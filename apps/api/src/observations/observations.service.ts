/*
Copyright (C) 2026 Steven E. Waldren

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published
by the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

/**
 * The first PHI write path in this repository.
 *
 * Four properties this class exists to hold, each of which is a requirement
 * somewhere and none of which survives being "remembered":
 *
 * **Ownership, not merely authentication.** The patient is resolved from the
 * token subject and from nothing else, and every entity lookup is scoped to
 * `(patient, id)` **together**. `Observation.id` is a global primary key, so
 * `findUnique({ where: { id } })` compiles, passes any test written from the
 * happy path, and hands patient A patient B's row. There is no such call in
 * this file, deliberately, and `observations.integration.spec.ts` proves the
 * behaviour rather than the absence.
 *
 * **Server-side re-enforcement (AC 13.1 AC 3).** Every Tier 1 rule runs here
 * on a payload that has already passed whatever the client did, because the
 * client is untrusted — an old app version, an offline device, or something
 * that is not our app at all. The rules come from `packages/core` and the
 * numbers come from `ThresholdsService`; neither is restated here.
 *
 * **A Tier 2 warning never blocks.** It is computed, returned on a `201`,
 * and cannot reach any code path that refuses a write. A real 2,500 mL day
 * is the entry the care team most needs.
 *
 * **A PHI row never commits without its audit row.** The observation insert
 * and the `audit_events` insert are one transaction (`AuditService
 * .record(context, tx)`), so there is no window in which one exists without
 * the other.
 */
import { Inject, Injectable } from '@nestjs/common';
import { SYNC_REASON_CODE } from '@ostomy/core/sync';
import { validateVolumetricEntry, type VolumetricEntryInput } from '@ostomy/core/validation';
import type { Request } from 'express';

import { AuditService } from '../audit/audit.service';
import { stageCommittedAuditEntry } from '../audit/audit-recorder';
import type { PatientActor } from '../auth/patient-actor';
import { getRequestId } from '../logging/request-id';
import { PrismaService } from '../prisma/prisma.service';
import { ThresholdsService } from '../thresholds/thresholds.service';
import { ObservationStatus, type Prisma, type Observation } from '../generated/prisma/client';
import { toMeasuredOrEstimated, toStoredMethod } from './estimation-method';
import {
  ObservationPersistenceError,
  isUniqueConstraintViolation,
} from './observation-persistence.error';
import {
  interpretObservationPayload,
  toAuditSnapshot,
  toObservationResource,
  toRejectionDetails,
  toStoredMeasurementSystem,
  toWarnings,
  toWireMeasurementSystem,
  type ObservationWarning,
} from './observation-payload';
import {
  entityIdConflict,
  patientNotProvisioned,
  validationBlocked,
} from './observation-rejection';
import type { ObservationListQuery } from './observation-query.pipe';
import {
  OBSERVATION_FIELD,
  STOMA_OUTPUT_LOINC_CODE,
  type ObservationRequestParsed,
  type ObservationResource,
} from './observation-wire';

/** The `audit_events.reason_code` every write through this endpoint carries. */
export const DIRECT_WRITE_REASON_CODE = 'direct_write';

/** `audit_events.entity_type` for an observation. */
export const OBSERVATION_ENTITY_TYPE = 'observation';

export interface ObservationCreateResult {
  readonly observation: ObservationResource;
  readonly warnings: readonly ObservationWarning[];
}

export interface ObservationListResult {
  readonly observations: readonly ObservationResource[];
}

interface ResolvedPatient {
  readonly patientId: string;
  readonly surgeryDate: Date;
  readonly measurementSystem: ReturnType<typeof toWireMeasurementSystem>;
}

@Injectable()
export class ObservationsService {
  // Explicit `@Inject()` on every parameter — see `AuditService`'s
  // constructor comment for why implicit type-based injection is not safe
  // under this workspace's Vitest (esbuild) transform.
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ThresholdsService) private readonly thresholds: ThresholdsService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async create(
    actor: PatientActor,
    request: Request,
    parsed: ObservationRequestParsed,
  ): Promise<ObservationCreateResult> {
    const patient = await this.resolvePatient(actor);
    const input = interpretObservationPayload(parsed);

    const thresholds = await this.thresholds.getVolumetricThresholds();
    const validationInput: VolumetricEntryInput = {
      field: OBSERVATION_FIELD.VALUE,
      rawValueMl: input.rawValueMl,
      method: toMeasuredOrEstimated(input.method),
      effectiveDateTime: input.effectiveDateTime,
      surgeryDate: patient.surgeryDate,
      now: new Date(),
    };
    const validation = validateVolumetricEntry(validationInput, thresholds);

    // The discriminant rather than `packages/core`'s `isBlocked()` helper:
    // the helper returns a boolean and so does not narrow `tier1` to the
    // variant that carries `errors`, and narrowing by hand *after* a boolean
    // check would mean writing the "what counts as blocked" condition twice.
    // This reads the same union the helper reads.
    if (validation.tier1.outcome === 'blocked') {
      throw validationBlocked(toRejectionDetails(validation.tier1.errors));
    }

    const valueMl = input.rawValueMl;
    if (typeof valueMl !== 'number' || !Number.isFinite(valueMl)) {
      // Unreachable: Tier 1's VALUE_NOT_NUMERIC has already blocked anything
      // that is not a finite number. Kept because the alternative to an
      // explicit narrowing here is a cast, and a cast would hand a
      // non-numeric value to Prisma — whose `PrismaClientValidationError`
      // renders the offending `data` argument, i.e. the clinical value,
      // into its own message (P1.S5 finding B3).
      throw validationBlocked([
        { field: OBSERVATION_FIELD.VALUE, reasonCode: SYNC_REASON_CODE.VALUE_NOT_NUMERIC },
      ]);
    }

    // Scoped by `(patient, id)`, never by id alone. A row of this patient's
    // with this id is an honest duplicate; a row of someone else's is not
    // found here at all and is caught by the insert's own unique violation
    // below, which returns the identical refusal — see `entityIdConflict()`
    // for why one code covers both.
    const existing = await this.prisma.observation.findFirst({
      where: { id: input.id, patientId: patient.patientId },
      select: { id: true },
    });
    if (existing) {
      throw entityIdConflict();
    }

    // A direct write has no client-side queue, so the moment the server
    // accepts it *is* when the write was made. That is what
    // `clientUpdatedAt` means (ADR-0001 §1), and it is what a later sync
    // operation's own `clientTimestamp` will be compared against under
    // last-write-wins.
    const writtenAt = new Date();

    const data: Prisma.ObservationUncheckedCreateInput = {
      id: input.id,
      patientId: patient.patientId,
      resourceType: 'Observation',
      code: input.code,
      valueQuantityValue: valueMl,
      valueQuantityUnit: input.unit,
      effectiveDatetime: input.effectiveDateTime,
      method: toStoredMethod(input.method),
      status: ObservationStatus.FINAL,
      // ADR-0012: NOT NULL, no default, supplied by every write path.
      //
      // The CLIENT's asserted value, not the server's current profile
      // (`docs/sync-contract.md` §7.2, and ADR-0012 as amended by P2.S1a).
      // This column records which system the patient actually entered in,
      // and for a queued offline write only the device knows that — the
      // profile is mutable, so a patient who logs three days in imperial,
      // switches to metric, then reconnects would otherwise have every
      // queued entry attributed to a system they did not type in. The value
      // is already narrowed to `metric`/`imperial` by
      // `interpretObservationPayload`, which is the only domain check §6.2
      // defines for this field.
      //
      // An earlier revision of this method re-derived it from
      // `patient.measurementSystem` and refused any payload that disagreed.
      // That refused on a field no entry form contains and the patient
      // cannot edit, using a reason code §6.2 does not define for that
      // case — uncorrectable by construction, with §9 forbidding both
      // dropping the operation and retrying it unchanged.
      enteredMeasurementSystem: toStoredMeasurementSystem(input.enteredMeasurementSystem),
      clientUpdatedAt: writtenAt,
    };

    const correlationId = getRequestId(request);
    const { row, auditEventId } = await this.insertWithAudit(data, actor, correlationId);

    // Counts toward the `@Audited()` coverage trip-wire without being
    // written a second time — the row is already committed, in the same
    // transaction as the observation. `auditEventId` is that row's id, and
    // passing it is what makes the "already committed" claim checkable.
    stageCommittedAuditEntry(
      request,
      {
        actorType: 'PATIENT',
        actorId: actor.id,
        action: 'CREATE',
        entityType: OBSERVATION_ENTITY_TYPE,
        entityId: row.id,
        reasonCode: DIRECT_WRITE_REASON_CODE,
        afterValue: toAuditSnapshot(row),
      },
      auditEventId,
    );

    return {
      observation: toObservationResource(row),
      // Tier 2, on the success path, where it cannot become an error.
      warnings: validation.tier2.outcome === 'warn' ? toWarnings(validation.tier2.warnings) : [],
    };
  }

  async list(actor: PatientActor, query: ObservationListQuery): Promise<ObservationListResult> {
    const patient = await this.resolvePatient(actor);

    const rows = await this.prisma.observation.findMany({
      where: {
        patientId: patient.patientId,
        code: STOMA_OUTPUT_LOINC_CODE,
        // Tombstones are never returned by a read path (ADR-0001).
        deletedAt: null,
        ...(query.effectiveDateTimeFrom || query.effectiveDateTimeTo
          ? {
              effectiveDatetime: {
                ...(query.effectiveDateTimeFrom ? { gte: query.effectiveDateTimeFrom } : {}),
                ...(query.effectiveDateTimeTo ? { lte: query.effectiveDateTimeTo } : {}),
              },
            }
          : {}),
      },
      // Clinically ordered: the moment the observation describes, most
      // recent first — never `createdAt`, which is when the server happened
      // to receive it and can be days later for a synced entry. `id` breaks
      // ties so that paging is deterministic when two entries share an
      // effective moment.
      orderBy: [{ effectiveDatetime: 'desc' }, { id: 'asc' }],
      take: query.limit,
    });

    return { observations: rows.map(toObservationResource) };
  }

  /**
   * One observation of **this patient's**.
   *
   * `findFirst` with both columns in the `where`, never `findUnique({ where:
   * { id } })` followed by an ownership check: the latter reads the row into
   * process memory before deciding, which is one careless log line or error
   * message away from disclosing it. Not found and not-yours are the same
   * outcome here because they are the same query.
   */
  async findOne(actor: PatientActor, id: string): Promise<Observation | null> {
    const patient = await this.resolvePatient(actor);
    return this.prisma.observation.findFirst({
      where: { id, patientId: patient.patientId, deletedAt: null },
    });
  }

  /**
   * The token subject to a patient row, plus the profile facts a write needs.
   *
   * A verified token whose subject has no patient row (or no profile — an
   * onboarding that never finished) cannot write: `surgeryDate` is a Tier 1
   * input and `measurementSystem` is ADR-0012's source of truth, and
   * guessing either is worse than refusing.
   */
  private async resolvePatient(actor: PatientActor): Promise<ResolvedPatient> {
    const patient = await this.prisma.patient.findUnique({
      where: { oidcSubject: actor.id },
      select: {
        id: true,
        profile: {
          select: { surgeryDate: true, measurementSystem: true, deletedAt: true },
        },
      },
    });

    if (!patient?.profile || patient.profile.deletedAt !== null) {
      throw patientNotProvisioned();
    }

    return {
      patientId: patient.id,
      surgeryDate: patient.profile.surgeryDate,
      measurementSystem: toWireMeasurementSystem(patient.profile.measurementSystem),
    };
  }

  /**
   * The observation row and its audit row, in one transaction.
   *
   * P1.S5 recorded that `AuditService.record()` accepted a
   * `Prisma.TransactionClient` that nothing passed, and that its interceptor
   * necessarily runs after the handler returns — so until now every audit
   * row was a second transaction committed after the PHI row was already
   * durable. This is the first caller to close that: either both rows exist
   * or neither does.
   *
   * Nothing Prisma throws is allowed to escape unwrapped.
   * `PrismaClientValidationError` renders the offending `data` argument —
   * here, the clinical value — into its own `message`, `errSerializer`
   * allow-lists `message` through verbatim, and the redaction lists match
   * object paths rather than substrings inside a string. So a raw Prisma
   * error from this call site is a PHI log leak with no control in front of
   * it (P1.S5 finding B3, same reasoning, first real payload).
   */
  private async insertWithAudit(
    data: Prisma.ObservationUncheckedCreateInput,
    actor: PatientActor,
    correlationId: string | undefined,
  ): Promise<{ row: Observation; auditEventId: string }> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.observation.create({ data });
        // The returned id is carried out of this transaction and handed to
        // `stageCommittedAuditEntry()`, which refuses to stage without it —
        // so "the audit row was written" cannot be asserted by a caller that
        // did not write one.
        const { id: auditEventId } = await this.audit.record(
          {
            actorType: 'PATIENT',
            actorId: actor.id,
            action: 'CREATE',
            entityType: OBSERVATION_ENTITY_TYPE,
            entityId: row.id,
            reasonCode: DIRECT_WRITE_REASON_CODE,
            // The entity's own stored fields, never the request body.
            afterValue: toAuditSnapshot(row),
            ...(correlationId !== undefined ? { correlationId } : {}),
          },
          tx,
        );
        return { row, auditEventId };
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        // The id belongs to a row that exists — this patient's (a race
        // against the scoped pre-check above) or another patient's (which
        // the scoped pre-check cannot see, by design). Same refusal either
        // way; see `entityIdConflict()`.
        throw entityIdConflict();
      }
      throw new ObservationPersistenceError(String(data.id), error);
    }
  }
}
