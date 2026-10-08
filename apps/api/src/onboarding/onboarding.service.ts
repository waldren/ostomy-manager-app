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

import { randomUUID } from 'node:crypto';

import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import type { PatientActor } from '../auth/patient-actor';
import { MeasurementSystem, OstomyType, Prisma } from '../generated/prisma/client';
import { patientNotProvisioned } from '../observations/observation-rejection';
import { PrismaService } from '../prisma/prisma.service';

import {
  MAX_SURGERY_DATE_AGE_YEARS,
  type OnboardingRequest,
  type ProfileResponse,
} from './onboarding-wire';

/** What `audit_events.entity_type` carries for these rows. Greppable and stable. */
export const PROFILE_ENTITY_TYPE = 'profile';

/** Distinguishes an onboarding write from a later preference edit in the audit log (P4.S3 will add the second). */
const ONBOARDING_REASON_CODE = 'onboarding';

/** A completed provisioning write and the audit row committed with it — the shape `stageCommittedAuditEntry` demands. */
export interface OnboardingWrite {
  readonly profile: ProfileResponse;
  readonly profileId: string;
  readonly auditEventId: string;
}

const OSTOMY_TYPE_BY_WIRE: Readonly<Record<OnboardingRequest['ostomyType'], OstomyType>> = {
  colostomy: OstomyType.COLOSTOMY,
  ileostomy: OstomyType.ILEOSTOMY,
};

const MEASUREMENT_SYSTEM_BY_WIRE: Readonly<
  Record<OnboardingRequest['measurementSystem'], MeasurementSystem>
> = {
  metric: MeasurementSystem.METRIC,
  imperial: MeasurementSystem.IMPERIAL,
};

/** The inverse, so a read and a write cannot disagree about the mapping. */
const WIRE_BY_OSTOMY_TYPE: Readonly<Record<OstomyType, OnboardingRequest['ostomyType']>> = {
  [OstomyType.COLOSTOMY]: 'colostomy',
  [OstomyType.ILEOSTOMY]: 'ileostomy',
};

const WIRE_BY_MEASUREMENT_SYSTEM: Readonly<
  Record<MeasurementSystem, OnboardingRequest['measurementSystem']>
> = {
  [MeasurementSystem.METRIC]: 'metric',
  [MeasurementSystem.IMPERIAL]: 'imperial',
};

/**
 * Provisioning: the one write that creates a patient (P4.S1, SRS §3.0).
 *
 * Until this existed, a `patients` row came into being only because
 * `packages/seed` wrote one, which is why the implementation plan calls this
 * sprint "what makes a genuine first run possible at all". A verified token for
 * a human the database had never heard of could do nothing but read its own
 * `PATIENT_NOT_PROVISIONED`.
 *
 * ## Both rows, or neither
 *
 * `Patient` and `Profile` are created in ONE transaction. A patient with no
 * profile would be a state every later query has to defend against — and
 * `observations.service.ts`'s `resolvePatient` already refuses it, because
 * `surgeryDate` is a Tier 1 input and `measurementSystem` is ADR-0012's source
 * of truth, so "guessing either is worse than refusing". Making the pair atomic
 * means that refusal only ever means "has not onboarded", never "onboarded
 * halfway".
 */
@Injectable()
export class OnboardingService {
  // Explicit `@Inject()`, not implicit type-based injection — see `AuditService`'s
  // own constructor comment for why the latter resolves to `undefined` under this
  // workspace's Vitest (esbuild) transform.
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async provision(
    actor: PatientActor,
    request: OnboardingRequest,
    correlationId: string | undefined,
  ): Promise<OnboardingWrite> {
    const surgeryDate = this.parseSurgeryDate(request.surgeryDate);

    return this.prisma.$transaction(async (tx) => {
      /**
       * Refused rather than treated as an edit, and the distinction is the point.
       *
       * This endpoint answers "I am new"; a second call from a subject that
       * already has a profile is either a client that did not check, or a
       * replayed request. Silently updating would make onboarding a second,
       * unaudited edit path for a profile whose edits belong to P4.S3's sync
       * route — and would let a replay overwrite a surgery date the patient
       * has since corrected.
       *
       * 409 rather than 200, so the client learns to read the profile instead.
       */
      const existing = await tx.patient.findUnique({
        where: { oidcSubject: actor.id },
        select: { id: true, profile: { select: { id: true, deletedAt: true } } },
      });
      if (existing?.profile && existing.profile.deletedAt === null) {
        throw new ConflictException({ error: { code: 'ALREADY_ONBOARDED' } });
      }

      /**
       * A patient row may exist without a profile only by a route this endpoint
       * does not create: a prior transaction that rolled back cannot leave one,
       * but ADR-0017's purge and a future admin action could. Reusing it keeps
       * the subject's identity stable — a second `Patient` for the same human is
       * the thing `oidcSubject @unique` exists to prevent, and the one the model
       * comment calls out.
       */
      const patientId =
        existing?.id ??
        (
          await tx.patient.create({
            data: { oidcSubject: actor.id },
            select: { id: true },
          })
        ).id;

      const profile = await tx.profile.create({
        data: {
          // `Profile.id` has no `@default` — it shares the patient's lifecycle
          // and the schema leaves assignment to the writer.
          id: randomUUID(),
          patientId,
          ostomyType: OSTOMY_TYPE_BY_WIRE[request.ostomyType],
          surgeryDate,
          measurementSystem: MEASUREMENT_SYSTEM_BY_WIRE[request.measurementSystem],
          // The client asserts nothing here: onboarding is not a conflict-resolved
          // write, because it is the first one and there is nothing to conflict
          // with. ADR-0001's last-write-wins applies to the EDITS P4.S3 adds.
          clientUpdatedAt: new Date(),
        },
      });

      const after = toProfileResponse(profile);

      /**
       * Audited inside the transaction, like every other PHI write on this
       * surface (P1.S5's shape). A profile carries clinical facts — an ostomy
       * type and a surgery date are both diagnosis-adjacent — so this is a PHI
       * create, not account bookkeeping, and CLAUDE.md's rule applies in full.
       *
       * `beforeValue` is absent because there was nothing before. The audit row
       * is the only record that this patient came into existence at all.
       */
      const auditEvent = await this.audit.record(
        {
          actorType: 'PATIENT',
          actorId: actor.id,
          action: 'CREATE',
          entityType: PROFILE_ENTITY_TYPE,
          entityId: profile.id,
          reasonCode: ONBOARDING_REASON_CODE,
          ...(correlationId !== undefined ? { correlationId } : {}),
          afterValue: after,
        },
        tx,
      );

      return { profile: after, profileId: profile.id, auditEventId: auditEvent.id };
    });
  }

  /**
   * The profile, or the same refusal a write would give.
   *
   * `PATIENT_NOT_PROVISIONED` rather than a bare 404, because that is the code
   * #80 added for exactly this state and the one the client already routes on.
   * A second vocabulary for "you have not onboarded" would mean the client has
   * to learn both.
   */
  async readProfile(actor: PatientActor): Promise<ProfileResponse> {
    const patient = await this.prisma.patient.findUnique({
      where: { oidcSubject: actor.id },
      select: {
        profile: {
          select: {
            ostomyType: true,
            surgeryDate: true,
            measurementSystem: true,
            deletedAt: true,
          },
        },
      },
    });

    if (!patient?.profile || patient.profile.deletedAt !== null) throw patientNotProvisioned();

    return toProfileResponse(patient.profile);
  }

  /**
   * The surgery date, bounded at both ends, and both bounds are load-bearing.
   *
   * **No future date.** This value becomes the Tier 1 lower timestamp bound, so
   * a surgery date in the future makes every entry the patient can make fail
   * that rule — the app would accept onboarding and then refuse the first thing
   * they tried to log, with a message about a date they chose on a screen they
   * have already left.
   *
   * **Nothing absurdly old.** A typo of `1025-03-04` passes every shape rule and
   * silently disables the bound for the life of the account, and nothing
   * downstream reports a rule that never fires. See `MAX_SURGERY_DATE_AGE_YEARS`.
   *
   * Reported as a field and a rule code, never echoing the offending value —
   * CLAUDE.md's standing rule for validation errors, and a surgery date is
   * clinical.
   */
  private parseSurgeryDate(value: string): Date {
    // `z.iso.date()` has already fixed the shape, so this parses rather than
    // validates. `T00:00:00Z` explicitly: `new Date('2026-01-02')` is UTC
    // midnight by spec, but being explicit is what stops a later edit to a
    // non-ISO format silently becoming local midnight and shifting the date by a
    // day for half the world.
    const parsed = new Date(`${value}T00:00:00.000Z`);
    const today = new Date();

    if (parsed.getTime() > today.getTime()) {
      throw this.invalidSurgeryDate('in_the_future');
    }

    const oldest = new Date(today);
    oldest.setUTCFullYear(oldest.getUTCFullYear() - MAX_SURGERY_DATE_AGE_YEARS);
    if (parsed.getTime() < oldest.getTime()) {
      throw this.invalidSurgeryDate('implausibly_old');
    }

    return parsed;
  }

  private invalidSurgeryDate(rule: string): BadRequestException {
    return new BadRequestException({
      error: { code: 'INVALID_ONBOARDING', fields: [{ field: 'surgeryDate', rule }] },
    });
  }
}

function toProfileResponse(row: {
  ostomyType: OstomyType;
  surgeryDate: Date;
  measurementSystem: MeasurementSystem;
}): ProfileResponse {
  return {
    ostomyType: WIRE_BY_OSTOMY_TYPE[row.ostomyType],
    // `@db.Date` comes back as a Date at UTC midnight; the wire carries the
    // calendar date it has always been, not an instant.
    surgeryDate: row.surgeryDate.toISOString().slice(0, 10),
    measurementSystem: WIRE_BY_MEASUREMENT_SYSTEM[row.measurementSystem],
  };
}

/** Re-exported for the controller's OpenAPI description; `Prisma` is imported for its transaction client type only. */
export type { Prisma };
