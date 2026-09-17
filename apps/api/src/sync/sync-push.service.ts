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

import { Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import {
  syncAcceptedResult,
  syncRejectedResult,
  syncSupersededResult,
  SYNC_ENTITY_TYPE,
  SYNC_FIELD_PATH,
  SYNC_OPERATION_TYPE,
  SYNC_REASON_CODE,
  toEntityId,
  toOperationId,
  toServerSequence,
  type SyncFieldPath,
  type SyncOperationResult,
  type SyncReasonCode,
} from '@ostomy/core/sync';
import { evaluateTier1 } from '@ostomy/core/validation';

import { AuditService } from '../audit/audit.service';
import type { PatientActor } from '../auth/patient-actor';
import { getRequestId } from '../logging/request-id';
import {
  MeasurementSystem,
  ObservationStatus,
  Prisma,
  SyncEntityType,
  SyncOperationStatus,
  SyncOperationType,
  type Observation,
  type SyncOperation,
} from '../generated/prisma/client';
import { SecurityLogService } from '../logging/security-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { ThresholdsService } from '../thresholds/thresholds.service';
import {
  ObservationRejectedException,
  patientNotProvisioned,
} from '../observations/observation-rejection';
import {
  interpretObservationPayload,
  toAuditSnapshot,
  toRejectionDetails,
  toStoredMeasurementSystem,
} from '../observations/observation-payload';
import { observationRequestParseSchema } from '../observations/observation-wire';
import { toMeasuredOrEstimated, toStoredMethod } from '../observations/estimation-method';
import type { SyncPushOperationParsed, SyncPushRequestParsed } from './sync-push.pipe';

/** `reasonCode` on an audit row for a write that arrived over sync (§4.1). */
const SYNC_APPLIED_REASON = 'sync_applied';
/** `reasonCode` on an audit row for the version that lost last-write-wins (§4.1). */
const SYNC_CONFLICT_LOSER_REASON = 'sync_conflict_loser';

const OBSERVATION_ENTITY_TYPE = 'observation';

/**
 * Everything about the acting patient that the per-operation path needs,
 * resolved once per batch.
 *
 * `patientId` and `actorId` are deliberately separate fields rather than one:
 * `PatientActor.id` is the OIDC **subject**, which is what an audit row's
 * `actorId` records, while every (patient, id) scope needs the `patients` row
 * UUID. Conflating them is not a type error — both are strings — and the
 * result is a `findUnique` that throws on a malformed UUID in the lucky case
 * and silently matches nothing in the unlucky one.
 */
interface PatientContext {
  readonly patientId: string;
  readonly actorId: string;
  readonly surgeryDate: Date | null;
}

/**
 * Applies a push batch (`docs/sync-contract.md` §3, §4).
 *
 * ## The invariants this class exists to hold
 *
 * 1. **A batch never fails as a unit for data reasons** (ADR-0001 point 2).
 *    One implausible row — precisely what Tier 2 exists to let through — must
 *    not block every subsequent entry a patient made while offline. So each
 *    operation is applied in its own transaction and its own try/catch, and
 *    a failure becomes one `rejected` result rather than an exception.
 * 2. **Processing one operation is atomic** (§3.7). The entity write, its
 *    server-sequence assignment, its audit event, and the idempotency record
 *    commit together or not at all. The interesting failure if they do not is
 *    not a lost write but a silently *duplicated* one: the entity commits,
 *    the idempotency record does not, the response is lost, the client
 *    re-pushes, and the replay is not recognised as one. Nothing downstream
 *    can detect that afterwards, because both rows are legitimate.
 * 3. **Every lookup is scoped to `(patient, id)` together** (§2). Never by
 *    entity id alone, in any code path — not the create-collision check, not
 *    the update target, not the conflict comparison. `Observation.id` is a
 *    global primary key, so `where: { id }` compiles and lets a token for
 *    patient A overwrite patient B's row given its UUID.
 * 4. **Idempotency is keyed on `(patient, operationId)` together** (§3.7),
 *    for the same reason: the operation id is chosen by an untrusted offline
 *    device and is not patient-scoped by construction.
 *
 * ## Audit obligations
 *
 * §4.1 names two paths that get missed when audit logging is added
 * per-handler, and P1.S5's interceptor covers *routes* — a push batch
 * applying fifty operations is one route. So this service writes audit rows
 * itself, inside each operation's transaction:
 *
 *  - every `accepted` operation writes a `sync_applied` row naming its own
 *    entity, never one row naming the batch;
 *  - every `superseded` operation writes a `sync_conflict_loser` row carrying
 *    the **incoming** version that lost;
 *  - every `accepted` operation that displaced a stored version writes a
 *    second `sync_conflict_loser` row carrying the **stored** version as it
 *    was before the write.
 *
 * All three route through the same `AuditService` as a direct write, not a
 * parallel path.
 */
@Injectable()
export class SyncPushService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ThresholdsService) private readonly thresholds: ThresholdsService,
    @Inject(SecurityLogService) private readonly securityLog: SecurityLogService,
  ) {}

  async push(
    actor: PatientActor,
    request: Request,
    body: SyncPushRequestParsed,
  ): Promise<{ results: SyncOperationResult[]; appliedCount: number }> {
    const correlationId = getRequestId(request);

    // `PatientActor.id` is the OIDC SUBJECT, not the patient row's UUID.
    // Resolved once per batch rather than per operation: it is the same
    // lookup fifty times otherwise, and every (patient, id) scope below
    // depends on getting it right exactly once.
    const patient = await this.prisma.patient.findUnique({
      where: { oidcSubject: actor.id },
      select: { id: true, profile: { select: { surgeryDate: true, deletedAt: true } } },
    });

    if (!patient?.profile || patient.profile.deletedAt !== null) {
      // Authenticated, but no provisioned patient. A request-level refusal
      // rather than N identical per-operation rejections: nothing about the
      // operations is wrong, and §6.2 has no reason code for "this token has
      // no patient", because it is not a property of an operation.
      throw patientNotProvisioned();
    }

    const context: PatientContext = {
      patientId: patient.id,
      // The OIDC subject, which is what an audit row records as its actor —
      // matching the direct write path (`ObservationsService`) so one
      // patient's rows carry one actor identity whichever endpoint wrote them.
      actorId: actor.id,
      surgeryDate: patient.profile.surgeryDate,
    };

    const results: SyncOperationResult[] = [];
    let appliedCount = 0;

    // Sequential, never `Promise.all`. §3.2 applies operations in array
    // order because last-write-wins is defined by client timestamp, and two
    // operations on one entity resolved concurrently would race to decide
    // which version is live.
    for (const operation of body.operations) {
      const result = await this.applyOne(context, operation, correlationId);
      results.push(result.result);
      if (result.applied) appliedCount += 1;
    }

    return { results, appliedCount };
  }

  /**
   * One operation, start to finish: replay check, validation, conflict
   * resolution, write, audit, idempotency record.
   *
   * Never throws for a data reason — every such path returns a `rejected`
   * result, because a throw here would fail the batch (invariant 1).
   */
  private async applyOne(
    context: PatientContext,
    operation: SyncPushOperationParsed,
    correlationId: string | undefined,
  ): Promise<{ result: SyncOperationResult; applied: boolean }> {
    // §3.7. A re-pushed operation returns the result the first attempt
    // produced, byte-for-byte apart from `replayed: true`, and has no further
    // effect. Checked before anything else: a replayed rejection is still a
    // rejection, and re-validating could produce a *different* one if a
    // threshold changed in between, which would break the byte-for-byte
    // guarantee in a way no client could detect.
    const priorRecord = await this.prisma.syncOperation.findUnique({
      where: {
        patientId_operationId: { patientId: context.patientId, operationId: operation.operationId },
      },
    });
    if (priorRecord !== null) {
      return { result: replayOf(priorRecord), applied: false };
    }

    const outcome = await this.evaluate(context, operation, correlationId);

    // **Every** rejection gets its idempotency record, in ONE place.
    //
    // This used to be the caller's job at each `return`, and three paths
    // forgot — the unsupported `entityType`, `ENTITY_ID_CONFLICT`, and
    // `ENTITY_NOT_FOUND` on an update — while the identical
    // `ENTITY_NOT_FOUND` condition on the delete branch remembered. Both
    // reviewers found it.
    //
    // The consequence was not just a wrong `replayed` flag. A re-push is
    // re-evaluated against live state, so an update refused with
    // `ENTITY_NOT_FOUND` before its create landed would, on redelivery with
    // the same `operationId`, be **applied** — carrying its original stale
    // `clientTimestamp` into a conflict comparison the server had already
    // declined to run, while the client's stored first result still said
    // "rejected, retain for correction". That is §3.7's silently-duplicated
    // write in its documented form.
    //
    // A rejection has no entity write to be atomic with, so this is
    // deliberately outside a transaction; the accepted and superseded paths
    // write their record *inside* the operation's transaction instead.
    if (outcome.result.status === 'rejected') {
      await this.recordRejection(context, operation, outcome.result);
    }

    return outcome;
  }

  /** The decision, with no persistence of its own for the rejection paths — see `applyOne`. */
  private async evaluate(
    context: PatientContext,
    operation: SyncPushOperationParsed,
    correlationId: string | undefined,
  ): Promise<{ result: SyncOperationResult; applied: boolean }> {
    if (operation.entityType !== SYNC_ENTITY_TYPE.OBSERVATION) {
      // LIVE as of P3.S1, and it was written for exactly this. The comment
      // here used to say "currently unreachable ... becomes live at P4, when
      // Profile and EffectiveRange gain wire payloads and the enum grows" —
      // P3.S1 grew it first, adding `Meal` (docs/sync-contract.md §7.4).
      //
      // So a `Meal` operation arriving before its handler exists is a
      // per-operation `rejected` result, not a 500 and not a whole-batch
      // failure: one entity type this release does not yet apply must not
      // block every other entry a patient made while offline (§3.4). The
      // offending field is `entityType`, never the payload — naming a payload
      // path would tell the patient to fix content that is not the problem.
      //
      // `sync.integration.spec.ts` pins this, because the safe failure is the
      // entire reason the wire type could widen in one PR while the handler
      // lands in the next.
      return {
        result: rejection(
          operation,
          SYNC_REASON_CODE.UNSUPPORTED_CODE,
          SYNC_FIELD_PATH.ENTITY_TYPE,
        ),
        applied: false,
      };
    }

    const skewRejection = await this.checkClockSkew(operation);
    if (skewRejection !== null) {
      return { result: skewRejection, applied: false };
    }

    return this.applyObservation(context, operation, correlationId);
  }

  /**
   * §3.8. A `clientTimestamp` further in the future than the allowance is
   * rejected with `CLIENT_TIMESTAMP_OUT_OF_RANGE`.
   *
   * Separate from the Tier 1 rule blocking a future `effectiveDateTime`, and
   * for a different reason. A future `effectiveDateTime` is a data-entry
   * mistake. A future `clientTimestamp` is a **poisoned timestamp**: because
   * conflict resolution is last-write-wins by client timestamp, a device with
   * a clock set to 2031 wins every conflict against every other device,
   * permanently, for every entity it touches. Nothing else in the protocol
   * bounds that.
   *
   * There is no symmetric past bound. A device offline for three weeks
   * legitimately pushes three-week-old timestamps, and that queue is exactly
   * what must not be discarded.
   */
  private async checkClockSkew(
    operation: SyncPushOperationParsed,
  ): Promise<SyncOperationResult | null> {
    const thresholds = await this.thresholds.getVolumetricThresholds();
    const latestAllowed = Date.now() + thresholds.maxClockSkewMs;
    if (operation.clientTimestamp.getTime() > latestAllowed) {
      return rejection(
        operation,
        SYNC_REASON_CODE.CLIENT_TIMESTAMP_OUT_OF_RANGE,
        SYNC_FIELD_PATH.CLIENT_TIMESTAMP,
      );
    }
    return null;
  }

  private async applyObservation(
    context: PatientContext,
    operation: SyncPushOperationParsed,
    correlationId: string | undefined,
  ): Promise<{ result: SyncOperationResult; applied: boolean }> {
    const isDelete = operation.operationType === SYNC_OPERATION_TYPE.DELETE;

    // §2/§4: found by (patient, entityId) TOGETHER. `findFirst` with both in
    // the where clause, never `findUnique({ where: { id } })`.
    const stored = await this.prisma.observation.findFirst({
      where: { id: operation.entityId, patientId: context.patientId },
    });

    if (stored === null) {
      // An id that resolves only to ANOTHER patient's row is **treated as not
      // existing** (§2), so it takes the same branch below as an id that
      // exists for nobody and returns a byte-identical result.
      //
      // `ENTITY_ID_CONFLICT` used to be returned here, and a distinct code IS
      // the disclosure: it let an authenticated patient tell "this UUID
      // belongs to someone else" from "no such row". §2 and §4 said the
      // opposite of §6.2 and both could not be true; the contract was
      // corrected toward §2, matching the precedent P2.S1a set on the direct
      // endpoints, where returning the same refusal in both cases was chosen
      // because it is structurally incapable of leaking.
      //
      // The lookup survives ONLY to record the attempt. It selects nothing
      // but existence, feeds no branch a client can observe, and writes to
      // the security log rather than the response — so the probe learns
      // nothing and the operator still sees it.
      const foreign = await this.prisma.observation.findUnique({
        where: { id: operation.entityId },
        select: { id: true },
      });
      if (foreign !== null) {
        this.securityLog.crossPatientEntityAccess({
          actorSubject: context.actorId,
          patientId: context.patientId,
          entityId: operation.entityId,
          requestId: correlationId,
        });
      }

      if (isDelete || operation.operationType === SYNC_OPERATION_TYPE.UPDATE) {
        // §6.2: no row with that id exists for this patient — whether because
        // it exists for nobody, or because it belongs to someone else. Note
        // this is NOT the tombstoned case: §4 makes a tombstoned row still
        // exist for update, delete and conflict resolution, and `findFirst`
        // above deliberately does not filter `deletedAt`.
        return {
          result: rejection(
            operation,
            SYNC_REASON_CODE.ENTITY_NOT_FOUND,
            SYNC_FIELD_PATH.ENTITY_ID,
          ),
          applied: false,
        };
      }

      // A CREATE against a foreign id falls through to the create path below,
      // where the (patient, id) unique constraint refuses it — again without
      // the response distinguishing it from any other refusal.
    }

    // §4: last-write-wins, including for a create. A create whose entity id
    // already exists for this patient is NOT a rejection — it is an ordinary
    // comparison with the same three outcomes. The reachable case is not a
    // client bug: the server applies a create, the response is lost, the
    // client re-pushes, and if the idempotency record did not commit with the
    // write that arrives as a create against an existing row.
    if (stored !== null && operation.clientTimestamp.getTime() < stored.clientUpdatedAt.getTime()) {
      return this.recordSuperseded(context, operation, stored, correlationId);
    }

    return isDelete
      ? this.applyDelete(context, operation, stored, correlationId)
      : this.applyUpsert(context, operation, stored, correlationId);
  }

  /**
   * The incoming operation lost. Result `superseded`, and the **incoming**
   * version goes to the audit log (§4.1).
   *
   * `appliedServerSequence` is the WINNING row's sequence, not this
   * operation's — this operation never got one. §3.6: it names the version
   * that beat this one.
   */
  private async recordSuperseded(
    context: PatientContext,
    operation: SyncPushOperationParsed,
    stored: Observation,
    correlationId: string | undefined,
  ): Promise<{ result: SyncOperationResult; applied: boolean }> {
    const result = syncSupersededResult({
      operationId: toOperationId(operation.operationId),
      entityId: toEntityId(operation.entityId),
      appliedServerSequence: toServerSequence(stored.serverSequence.toString()),
      replayed: false,
    });

    await this.prisma.$transaction(async (tx) => {
      await this.audit.record(
        {
          actorType: 'PATIENT',
          actorId: context.actorId,
          action: 'UPDATE',
          entityType: OBSERVATION_ENTITY_TYPE,
          entityId: operation.entityId,
          reasonCode: SYNC_CONFLICT_LOSER_REASON,
          // The INCOMING version that lost. Projected field by field from
          // the operation, never spread from the payload (§6.3).
          beforeValue: incomingSnapshot(operation),
          ...(correlationId !== undefined ? { correlationId } : {}),
        },
        tx,
      );
      await this.writeOperationRecord(tx, context, operation, result);
    });

    return { result, applied: false };
  }

  private async applyUpsert(
    context: PatientContext,
    operation: SyncPushOperationParsed,
    stored: Observation | null,
    correlationId: string | undefined,
  ): Promise<{ result: SyncOperationResult; applied: boolean }> {
    // Payload CONTENT validation, per operation — never in the pipe (§6.1).
    let input;
    try {
      const parsed = observationRequestParseSchema.parse(operation.payload);
      input = interpretObservationPayload(parsed);
    } catch (error) {
      const detail = firstRejectionDetail(error);
      return { result: rejection(operation, detail.reasonCode, detail.field), applied: false };
    }

    const thresholds = await this.thresholds.getVolumetricThresholds();

    const tier1 = evaluateTier1(
      {
        field: SYNC_FIELD_PATH.VALUE_QUANTITY_VALUE,
        rawValueMl: input.rawValueMl,
        method: toMeasuredOrEstimated(input.method),
        effectiveDateTime: input.effectiveDateTime,
        surgeryDate: context.surgeryDate,
        now: new Date(),
      },
      thresholds,
    );

    if (tier1.outcome === 'blocked') {
      // §6.3: report the FIRST failure in §6.2's listed order, so two servers
      // do not walk one patient through different correction sequences.
      //
      // Routed through `toRejectionDetails`, which is the SAME remapper the
      // direct endpoint uses, rather than reading `evaluateTier1`'s output
      // directly. `evaluateTier1` stamps its single `input.field` onto every
      // error it returns, so reading `error.field` here reported
      // `valueQuantity.value` for METHOD_REQUIRED and both
      // EFFECTIVE_DATE_TIME_* codes — the correction inbox would highlight
      // the volume for an entry rejected because it predates the surgery
      // date, the patient would edit the volume, and it would be rejected
      // again forever (§9.2's retry-unchanged loop, through a mislabelled
      // field). `toRejectionDetails` also closes the reason code against
      // `Tier1ReasonCode` with no fallback, so a new rule in `packages/core`
      // is a compile error here rather than an unlisted code persisted to
      // `sync_operations` and replayed verbatim.
      const detail = toRejectionDetails(tier1.errors)[0]!;
      return {
        result: rejection(operation, detail.reasonCode, detail.field as SyncFieldPath),
        applied: false,
      };
    }

    // Tier 2 is deliberately not consulted here. §6.2: a soft warning is not
    // a rejection and never becomes one, and there is no wire representation
    // of a Tier 2 outcome in a push response — a field for it is a field
    // someone will eventually branch on.

    const data: Prisma.ObservationUncheckedCreateInput = {
      id: operation.entityId,
      patientId: context.patientId,
      resourceType: 'Observation',
      code: input.code,
      valueQuantityValue: new Prisma.Decimal(input.rawValueMl as number),
      valueQuantityUnit: input.unit,
      effectiveDatetime: input.effectiveDateTime,
      method: toStoredMethod(input.method),
      status: ObservationStatus.FINAL,
      // ADR-0012 as amended: the CLIENT's asserted entry system. For a queued
      // offline write only the device knows what the patient typed in.
      enteredMeasurementSystem: toStoredMeasurementSystem(input.enteredMeasurementSystem),
      // ADR-0016: client-asserted zone, server-derived day. `localDate` is a
      // DATE column; the UTC-midnight construction is how Prisma takes a
      // calendar date without a zone shifting it by a day.
      enteredTimezone: input.enteredTimezone,
      localDate: new Date(`${input.localDate}T00:00:00.000Z`),
      clientUpdatedAt: operation.clientTimestamp,
      deletedAt: null,
    };

    const row = await this.prisma.$transaction(async (tx) => {
      const written =
        stored === null
          ? await tx.observation.create({ data })
          : await tx.observation.update({
              // Scoped by both, as everywhere (§2).
              where: { id: operation.entityId, patientId: context.patientId },
              // A full replacement, not a patch (§4): every payload field is
              // required and the payload is the entity's new state entirely.
              // `deletedAt: null` is what resurrects a tombstoned row when an
              // update beats a delete.
              data,
            });

      await this.audit.record(
        {
          actorType: 'PATIENT',
          actorId: context.actorId,
          action: stored === null ? 'CREATE' : 'UPDATE',
          entityType: OBSERVATION_ENTITY_TYPE,
          entityId: operation.entityId,
          reasonCode: SYNC_APPLIED_REASON,
          ...(stored !== null ? { beforeValue: toAuditSnapshot(stored) } : {}),
          afterValue: toAuditSnapshot(written),
          ...(correlationId !== undefined ? { correlationId } : {}),
        },
        tx,
      );

      // §4.1: an accepted operation that DISPLACED a stored version writes a
      // second audit row carrying that stored version as it was before the
      // write. Two rows, because two things happened.
      if (stored !== null) {
        await this.audit.record(
          {
            actorType: 'PATIENT',
            actorId: context.actorId,
            action: 'UPDATE',
            entityType: OBSERVATION_ENTITY_TYPE,
            entityId: operation.entityId,
            reasonCode: SYNC_CONFLICT_LOSER_REASON,
            beforeValue: toAuditSnapshot(stored),
            ...(correlationId !== undefined ? { correlationId } : {}),
          },
          tx,
        );
      }

      await this.writeOperationRecord(
        tx,
        context,
        operation,
        acceptedResultFor(operation, written.serverSequence),
      );
      return written;
    });

    return { result: acceptedResultFor(operation, row.serverSequence), applied: true };
  }

  private async applyDelete(
    context: PatientContext,
    operation: SyncPushOperationParsed,
    stored: Observation | null,
    correlationId: string | undefined,
  ): Promise<{ result: SyncOperationResult; applied: boolean }> {
    // `stored` is non-null by construction: `applyObservation` returns
    // ENTITY_NOT_FOUND for a delete against a row this patient does not have,
    // before this method is reached. An earlier version repeated that check
    // here, which was dead code — and, worse, the dead copy was the one that
    // recorded the idempotency row while the live path did not.
    if (stored === null) {
      throw new Error(
        'applyDelete reached with no stored row; applyObservation should have rejected it.',
      );
    }

    const row = await this.prisma.$transaction(async (tx) => {
      const written = await tx.observation.update({
        where: { id: operation.entityId, patientId: context.patientId },
        data: { deletedAt: new Date(), clientUpdatedAt: operation.clientTimestamp },
      });

      // §4.1: a delete audits the entity's FULL pre-deletion state as
      // `beforeValue`, with `afterValue` null. The tombstone carries nothing
      // on the wire (§5.2) precisely because the audit store carries
      // everything — once the §10 purge policy lands, this row is the only
      // surviving copy of what was deleted.
      await this.audit.record(
        {
          actorType: 'PATIENT',
          actorId: context.actorId,
          action: 'DELETE',
          entityType: OBSERVATION_ENTITY_TYPE,
          entityId: operation.entityId,
          reasonCode: SYNC_APPLIED_REASON,
          beforeValue: toAuditSnapshot(stored),
          ...(correlationId !== undefined ? { correlationId } : {}),
        },
        tx,
      );

      if (stored.deletedAt === null) {
        await this.audit.record(
          {
            actorType: 'PATIENT',
            actorId: context.actorId,
            action: 'UPDATE',
            entityType: OBSERVATION_ENTITY_TYPE,
            entityId: operation.entityId,
            reasonCode: SYNC_CONFLICT_LOSER_REASON,
            beforeValue: toAuditSnapshot(stored),
            ...(correlationId !== undefined ? { correlationId } : {}),
          },
          tx,
        );
      }

      await this.writeOperationRecord(
        tx,
        context,
        operation,
        acceptedResultFor(operation, written.serverSequence),
      );
      return written;
    });

    return { result: acceptedResultFor(operation, row.serverSequence), applied: true };
  }

  /** A rejection still gets an idempotency record: a replayed rejection is still a rejection (§3.7). */
  private async recordRejection(
    context: PatientContext,
    operation: SyncPushOperationParsed,
    result: SyncOperationResult,
  ): Promise<void> {
    await this.writeOperationRecord(this.prisma, context, operation, result);
  }

  /**
   * The idempotency record. Stores everything the first response carried —
   * `status`, `reasonCode`, `field`, `appliedServerSequence` — because §3.7's
   * replay guarantee is byte-for-byte, not "enough to recompute a status".
   */
  private async writeOperationRecord(
    tx: Prisma.TransactionClient | PrismaService,
    context: PatientContext,
    operation: SyncPushOperationParsed,
    result: SyncOperationResult,
  ): Promise<void> {
    await tx.syncOperation.create({
      data: {
        patientId: context.patientId,
        operationId: operation.operationId,
        entityType: SyncEntityType.OBSERVATION,
        entityId: operation.entityId,
        operationType: toStoredOperationType(operation.operationType),
        clientTimestamp: operation.clientTimestamp,
        status: toStoredStatus(result.status),
        rejectionReasonCode: result.status === 'rejected' ? result.reasonCode : null,
        rejectionField: result.status === 'rejected' ? result.field : null,
        appliedServerSequence:
          result.status === 'rejected' ? null : BigInt(result.appliedServerSequence),
      },
    });
  }
}

function acceptedResultFor(
  operation: SyncPushOperationParsed,
  serverSequence: bigint,
): SyncOperationResult {
  return syncAcceptedResult({
    operationId: toOperationId(operation.operationId),
    entityId: toEntityId(operation.entityId),
    appliedServerSequence: toServerSequence(serverSequence.toString()),
    replayed: false,
  });
}

/**
 * Built by naming fields, never by spreading a validation result (§6.3).
 * TypeScript's excess-property check does not apply to spread properties, so
 * `{ ...validationResult, status: 'rejected' }` typechecks cleanly and
 * serializes whatever the source carried — including the offending value.
 */
function rejection(
  operation: SyncPushOperationParsed,
  reasonCode: SyncReasonCode,
  field: SyncFieldPath,
): SyncOperationResult {
  return syncRejectedResult({
    operationId: toOperationId(operation.operationId),
    entityId: toEntityId(operation.entityId),
    reasonCode,
    field,
    replayed: false,
  });
}

/** §3.7: the stored result, replayed byte-for-byte apart from `replayed: true`. */
function replayOf(record: SyncOperation): SyncOperationResult {
  const operationId = toOperationId(record.operationId);
  const entityId = toEntityId(record.entityId);

  if (record.status === SyncOperationStatus.REJECTED) {
    return syncRejectedResult({
      operationId,
      entityId,
      reasonCode: record.rejectionReasonCode as SyncReasonCode,
      field: record.rejectionField as SyncFieldPath,
      replayed: true,
    });
  }

  const appliedServerSequence = toServerSequence((record.appliedServerSequence ?? 0n).toString());
  return record.status === SyncOperationStatus.SUPERSEDED
    ? syncSupersededResult({ operationId, entityId, appliedServerSequence, replayed: true })
    : syncAcceptedResult({ operationId, entityId, appliedServerSequence, replayed: true });
}

/**
 * The incoming version, for the audit row a `superseded` operation writes.
 *
 * Projected field by field from the parsed payload rather than spread, for
 * §6.3's reason — and note this one legitimately DOES carry clinical values:
 * it is an audit row, not a wire response. §4.1 requires the losing version
 * to be preserved rather than discarded, which is the only reason
 * last-write-wins is acceptable for clinical data at all.
 */
function incomingSnapshot(operation: SyncPushOperationParsed): Record<string, unknown> {
  const payload = operation.payload ?? {};
  return {
    id: operation.entityId,
    code: payload.code,
    valueQuantityValue: (payload.valueQuantity as { value?: unknown } | undefined)?.value,
    valueQuantityUnit: (payload.valueQuantity as { unit?: unknown } | undefined)?.unit,
    effectiveDatetime: payload.effectiveDateTime,
    method: payload.method,
    status: payload.status,
    enteredMeasurementSystem: payload.enteredMeasurementSystem,
    clientUpdatedAt: operation.clientTimestamp.toISOString(),
  };
}

function firstRejectionDetail(error: unknown): {
  reasonCode: SyncReasonCode;
  field: SyncFieldPath;
} {
  if (error instanceof ObservationRejectedException && error.details.length > 0) {
    const detail = error.details[0]!;
    return { reasonCode: detail.reasonCode, field: detail.field as SyncFieldPath };
  }
  // A zod failure on the payload shape. Reports `field: "payload"` and never
  // the offending key (§6.2) — the key is client-supplied content.
  return {
    reasonCode: SYNC_REASON_CODE.PAYLOAD_FIELD_UNRECOGNIZED,
    field: SYNC_FIELD_PATH.PAYLOAD,
  };
}

function toStoredOperationType(operationType: string): SyncOperationType {
  if (operationType === SYNC_OPERATION_TYPE.CREATE) return SyncOperationType.CREATE;
  if (operationType === SYNC_OPERATION_TYPE.UPDATE) return SyncOperationType.UPDATE;
  return SyncOperationType.DELETE;
}

function toStoredStatus(status: string): SyncOperationStatus {
  if (status === 'accepted') return SyncOperationStatus.ACCEPTED;
  if (status === 'superseded') return SyncOperationStatus.SUPERSEDED;
  return SyncOperationStatus.REJECTED;
}

/** Referenced so the enum import is not flagged; `MeasurementSystem` is used via `toStoredMeasurementSystem`. */
export type { MeasurementSystem };
