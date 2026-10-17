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
import {
  evaluateEntryTimestamp,
  evaluateTier1,
  validateVolumelessObservation,
} from '@ostomy/core/validation';

import { AuditService } from '../audit/audit.service';
import type { PatientActor } from '../auth/patient-actor';
import { getRequestId } from '../logging/request-id';
import {
  incomingProfileSnapshot,
  interpretProfilePayload,
  PROFILE_ENTITY_TYPE,
  profileRequestParseSchema,
  toProfileAuditSnapshot,
} from '../onboarding/profile-payload';
import { toWireSurgeryDate } from '../onboarding/surgery-date';
import {
  incomingRangeSnapshot,
  interpretRangePayload,
  newPatientRangeViolation,
  PATIENT_PROVENANCES,
  RANGE_ENTITY_TYPE,
  RANGE_REPLACED_REASON,
  rangeLockKey,
  rangeRequestParseSchema,
  rangeRowViolation,
  statusTransitionViolation,
  toNumberOrNull,
  toRangeAuditSnapshot,
  type RangeTypeLimits,
  type RangeWriteInput,
} from '../ranges/range-payload';
import {
  MeasurementSystem,
  ObservationStatus,
  Prisma,
  RangeStatus,
  SyncEntityType,
  SyncOperationStatus,
  SyncOperationType,
  type EffectiveRange,
  type Meal,
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
import { interpretMealPayload, toMealAuditSnapshot, toStoredSize } from '../meals/meal-payload';
import { MEAL_FIELD, mealRequestParseSchema } from '../meals/meal-wire';
import { toMeasuredOrEstimated, toStoredMethod } from '../observations/estimation-method';
import type { SyncPushOperationParsed, SyncPushRequestParsed } from './sync-push.pipe';

/** `reasonCode` on an audit row for a write that arrived over sync (§4.1). */
const SYNC_APPLIED_REASON = 'sync_applied';
/** `reasonCode` on an audit row for the version that lost last-write-wins (§4.1). */
const SYNC_CONFLICT_LOSER_REASON = 'sync_conflict_loser';

const OBSERVATION_ENTITY_TYPE = 'observation';
/** The audit `entityType` for a meal. Lowercase like `observation`'s — this is the audit store's vocabulary, not the wire's. */
const MEAL_ENTITY_TYPE = 'meal';

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
  /**
   * `YYYY-MM-DD`. A calendar date, because the Tier 1 rule it feeds compares calendar days — see `packages/core/src/validation/entryTimestamp.ts`.
   *
   * Not `readonly`, the one exception in this type: an accepted `Profile`
   * update in the batch replaces it (see `push`).
   */
  surgeryDate: string | null;
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
      surgeryDate:
        patient.profile.surgeryDate === null
          ? null
          : toWireSurgeryDate(patient.profile.surgeryDate),
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
      // A surgery-date edit applies to every operation queued AFTER it in this
      // batch. The device queued the edit first and the entries after, so it
      // validated those entries against the new date; validating them here
      // against the date the batch started with would refuse entries the
      // patient made correctly (P4.S3). Operations BEFORE the edit keep the
      // old date, which is what they were checked against.
      if (result.surgeryDate !== undefined) context.surgeryDate = result.surgeryDate;
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
  ): Promise<OperationOutcome> {
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
  ): Promise<OperationOutcome> {
    if (!HANDLED_ENTITY_TYPES.has(operation.entityType)) {
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

    // §3.8, for EVERY entity type, before anything else. A poisoned
    // `clientTimestamp` wins every last-write-wins comparison for the entity it
    // touches, and that is no less true of a meal or a profile than of an
    // observation. Meals used to be dispatched above this check and so were
    // never bounded at all: a phone with its clock set a year ahead won every
    // meal conflict, permanently (fixed at P4.S3).
    const skewRejection = await this.checkClockSkew(operation);
    if (skewRejection !== null) {
      return { result: skewRejection, applied: false };
    }

    if (operation.entityType === SYNC_ENTITY_TYPE.MEAL) {
      return this.applyMeal(context, operation, correlationId);
    }
    if (operation.entityType === SYNC_ENTITY_TYPE.PROFILE) {
      return this.applyProfile(context, operation, correlationId);
    }
    if (operation.entityType === SYNC_ENTITY_TYPE.EFFECTIVE_RANGE) {
      return this.applyEffectiveRange(context, operation, correlationId);
    }
    return this.applyObservation(context, operation, correlationId);
  }

  /**
   * The `Profile` push path (P4.S3, §7.5): an UPDATE to the patient's own
   * profile, and nothing else.
   *
   * Structurally the meal path — (patient, entityId) lookup, last-write-wins
   * by client timestamp with the same three outcomes, the same audit
   * obligations — because a profile resolving conflicts differently would make
   * §4 mean two things. Five things differ:
   *
   * - **Update only.** A profile is created by provisioning, which cannot be a
   *   sync operation, and deleting one is account deletion (ADR-0017). Both are
   *   refused per operation naming `operationType`, the way an entity type this
   *   release does not handle is refused naming `entityType`.
   * - **No clinical timestamp.** A profile describes the patient rather than an
   *   event, so neither Tier 1 timestamp rule applies; the surgery date has its
   *   own bounds, onboarding's (`interpretProfilePayload`).
   * - **The payload is validated BEFORE the conflict comparison.** The meal
   *   path compares first, so an older payload carrying anything at all in a
   *   known field is `superseded` and its raw value is copied into the
   *   append-only audit store, where only an ADR-0017 purge can reach it. Here
   *   an invalid payload is `rejected` whatever its timestamp, and the losing
   *   version the audit row preserves is always one that passed validation.
   * - **The comparison runs under a row lock.** Every device a patient owns
   *   edits this one row. Read outside the transaction, two concurrent pushes
   *   both pass the comparison against the same stored version, the OLDER one
   *   can commit second and win, and its audit row names the wrong version as
   *   the one it displaced. For the row that is every later entry's Tier 1
   *   bound, that is not a theoretical race (#140 review).
   * - **It changes the batch.** An accepted surgery-date edit becomes the bound
   *   for the operations after it (`push`).
   */
  private async applyProfile(
    context: PatientContext,
    operation: SyncPushOperationParsed,
    correlationId: string | undefined,
  ): Promise<OperationOutcome> {
    if (operation.operationType !== SYNC_OPERATION_TYPE.UPDATE) {
      return {
        result: rejection(
          operation,
          SYNC_REASON_CODE.UNSUPPORTED_CODE,
          SYNC_FIELD_PATH.OPERATION_TYPE,
        ),
        applied: false,
      };
    }

    // §2: by (patient, entityId) together. Another patient's profile id
    // resolves to nothing and gets the byte-identical refusal a nonexistent id
    // does. `deletedAt: null` is safe HERE only because `push` already refuses
    // a batch from a patient whose profile is deleted; §4 says a tombstoned row
    // still exists, so do not copy this filter into a path where it can matter.
    const exists = await this.prisma.profile.findFirst({
      where: { id: operation.entityId, patientId: context.patientId, deletedAt: null },
      select: { id: true },
    });
    if (exists === null) {
      // A profile id reaches a device only from that patient's own responses,
      // so naming someone else's is a strong sign of a stolen token or device.
      // Recorded for the operator, exactly as the observation path does, and
      // never reflected in the response (§2).
      const foreign = await this.prisma.profile.findUnique({
        where: { id: operation.entityId },
        select: { id: true },
      });
      if (foreign !== null) {
        this.securityLog.crossPatientEntityAccess({
          actorSubject: context.actorId,
          patientId: context.patientId,
          entityType: PROFILE_ENTITY_TYPE,
          entityId: operation.entityId,
          requestId: correlationId,
        });
      }
      return {
        result: rejection(operation, SYNC_REASON_CODE.ENTITY_NOT_FOUND, SYNC_FIELD_PATH.ENTITY_ID),
        applied: false,
      };
    }

    let input;
    try {
      const parsed = profileRequestParseSchema.parse(operation.payload);
      input = interpretProfilePayload(parsed, new Date());
    } catch (error) {
      const detail = firstRejectionDetail(error);
      return { result: rejection(operation, detail.reasonCode, detail.field), applied: false };
    }

    return this.prisma.$transaction(async (tx) => {
      // The lock that makes the comparison below mean anything: a concurrent
      // push for this row waits here until this transaction commits, then reads
      // the version this one wrote.
      await tx.$queryRaw`
        SELECT id FROM profiles
        WHERE id = ${operation.entityId}::uuid AND patient_id = ${context.patientId}::uuid
        FOR UPDATE
      `;
      const stored = await tx.profile.findFirstOrThrow({
        where: { id: operation.entityId, patientId: context.patientId },
      });

      if (operation.clientTimestamp.getTime() < stored.clientUpdatedAt.getTime()) {
        const result = syncSupersededResult({
          operationId: toOperationId(operation.operationId),
          entityId: toEntityId(operation.entityId),
          appliedServerSequence: toServerSequence(stored.serverSequence.toString()),
          replayed: false,
        });
        await this.audit.record(
          {
            actorType: 'PATIENT',
            actorId: context.actorId,
            action: 'UPDATE',
            entityType: PROFILE_ENTITY_TYPE,
            entityId: operation.entityId,
            reasonCode: SYNC_CONFLICT_LOSER_REASON,
            // The INCOMING version that lost (§4.1) — validated above, so this
            // is never arbitrary client content.
            beforeValue: incomingProfileSnapshot(
              operation.entityId,
              input,
              operation.clientTimestamp,
            ),
            ...(correlationId !== undefined ? { correlationId } : {}),
          },
          tx,
        );
        await this.writeOperationRecord(tx, context, operation, result);
        return { result, applied: false };
      }

      const written = await tx.profile.update({
        where: { id: operation.entityId, patientId: context.patientId },
        // A full replacement (§4): every field the payload carries, named.
        data: {
          ostomyType: input.ostomyType,
          surgeryDate: input.surgeryDate,
          measurementSystem: input.measurementSystem,
          clientUpdatedAt: operation.clientTimestamp,
        },
      });

      // §3.10: "editable but audit-logged, since the surgery date is a
      // validation boundary" — before AND after, so a moved boundary can always
      // be traced to who moved it and from where. `stored` is the locked read,
      // so "before" is the version this write actually displaced.
      await this.audit.record(
        {
          actorType: 'PATIENT',
          actorId: context.actorId,
          action: 'UPDATE',
          entityType: PROFILE_ENTITY_TYPE,
          entityId: operation.entityId,
          reasonCode: SYNC_APPLIED_REASON,
          beforeValue: toProfileAuditSnapshot(stored),
          afterValue: toProfileAuditSnapshot(written),
          ...(correlationId !== undefined ? { correlationId } : {}),
        },
        tx,
      );
      // §4.1: the displaced version, as its own row — the meal path's rule.
      // Written on every accepted edit, including the first after provisioning
      // where nothing conflicted, so a count of these rows is not a count of
      // conflicts.
      await this.audit.record(
        {
          actorType: 'PATIENT',
          actorId: context.actorId,
          action: 'UPDATE',
          entityType: PROFILE_ENTITY_TYPE,
          entityId: operation.entityId,
          reasonCode: SYNC_CONFLICT_LOSER_REASON,
          beforeValue: toProfileAuditSnapshot(stored),
          ...(correlationId !== undefined ? { correlationId } : {}),
        },
        tx,
      );

      const result = acceptedResultFor(operation, written.serverSequence);
      await this.writeOperationRecord(tx, context, operation, result);
      return { result, applied: true, surgeryDate: toWireSurgeryDate(written.surgeryDate) };
    });
  }

  /**
   * The `EffectiveRange` push path (P4.S3 slice 3, §7.6): a patient confirming
   * a suggestion, setting their own value, or moving a row through its
   * lifecycle. This is the only write path for this entity.
   *
   * What a patient may do, and nothing else:
   *
   * - **Create** an `active` row of their own — `patient_set` or
   *   `patient_confirmed_suggestion` — for a range type that is not a safety
   *   type, with bounds inside that type's limits. Never a `physician_set` row
   *   (AC 14.1 AC4) and never a `proposed` one: a suggestion awaiting a human is
   *   the system's to make.
   * - **Update** the STATUS of a row of their own: accept a proposal
   *   (`proposed` → `active`), dismiss one (`proposed` → `dismissed`), or
   *   withdraw their value (`active` → `superseded`), which falls back to a
   *   physician's value or the default. Every other field is immutable; a new
   *   value is a new row.
   * - **Never delete.** History is kept, and a withdrawn value is `superseded`.
   *
   * **One patient value per type is in force.** Precedence ranks `patient_set`
   * above `patient_confirmed_suggestion`, so without this a patient who set a
   * value and later confirmed the suggestion would stay on their own value with
   * no way to tell why. So a new patient value supersedes whichever patient
   * value was active for that type, and links to it through `previousRangeId`.
   * A physician's row is never touched; it outranks both and stays in force,
   * and the patient's divergence from it is flagged by the read (AC4).
   *
   * **The latest patient decision wins, across rows.** A value created offline
   * at T5 that arrives after another device's T10 decision for the same type —
   * a new value OR a withdrawal — is stored as `superseded` history rather than
   * taking over. Last-write-wins by client timestamp is the contract's rule
   * (§4), and applying it only within one row would let a stale device revert a
   * newer decision.
   *
   * **What, then when.** On an existing row, the rules about what this patient
   * may write run BEFORE the timestamp comparison: a write they may never make
   * is `rejected` whatever its timestamp, rather than answered `superseded`
   * and copied into the append-only audit store under a physician's row (#146
   * review — the profile path's #140 rule, applied here too). Only the status
   * change itself is checked after, so that a replayed or out-of-date
   * operation resolves to `superseded` instead of a correction no patient
   * could make.
   *
   * Everything runs under one advisory lock per (patient, range type), taken
   * first in every write, because these rules read one row and write another:
   * two devices confirming at once would otherwise both see "nothing active"
   * and both become active.
   */
  private async applyEffectiveRange(
    context: PatientContext,
    operation: SyncPushOperationParsed,
    correlationId: string | undefined,
  ): Promise<OperationOutcome> {
    if (operation.operationType === SYNC_OPERATION_TYPE.DELETE) {
      return {
        result: rejection(
          operation,
          SYNC_REASON_CODE.UNSUPPORTED_CODE,
          SYNC_FIELD_PATH.OPERATION_TYPE,
        ),
        applied: false,
      };
    }
    const isCreate = operation.operationType === SYNC_OPERATION_TYPE.CREATE;

    // Shape first, before any comparison, so a losing version copied into the
    // audit store has always passed validation (#140 review).
    let input: RangeWriteInput;
    try {
      input = interpretRangePayload(rangeRequestParseSchema.parse(operation.payload));
    } catch (error) {
      const detail = firstRejectionDetail(error);
      return { result: rejection(operation, detail.reasonCode, detail.field), applied: false };
    }

    // §2: by (patient, id) together. The type is read here only to choose the
    // lock; it is immutable, so reading it outside the lock is safe.
    const own = await this.prisma.effectiveRange.findFirst({
      where: { id: operation.entityId, patientId: context.patientId },
      select: { rangeType: true },
    });
    if (own === null) {
      const foreign = await this.prisma.effectiveRange.findUnique({
        where: { id: operation.entityId },
        select: { id: true },
      });
      if (foreign !== null) {
        this.securityLog.crossPatientEntityAccess({
          actorSubject: context.actorId,
          patientId: context.patientId,
          entityType: RANGE_ENTITY_TYPE,
          entityId: operation.entityId,
          requestId: correlationId,
        });
        // A CREATE naming another patient's id cannot be answered like a
        // nonexistent id — that create would succeed — so any refusal here
        // reveals the id exists. Random v4 ids make an honest collision
        // practically impossible, so this answers an attacker who already
        // holds the id, and the security log has the attempt.
        return {
          result: rejection(
            operation,
            isCreate ? SYNC_REASON_CODE.ENTITY_ID_CONFLICT : SYNC_REASON_CODE.ENTITY_NOT_FOUND,
            SYNC_FIELD_PATH.ENTITY_ID,
          ),
          applied: false,
        };
      }
      if (!isCreate) {
        return {
          result: rejection(
            operation,
            SYNC_REASON_CODE.ENTITY_NOT_FOUND,
            SYNC_FIELD_PATH.ENTITY_ID,
          ),
          applied: false,
        };
      }
      const violation = await this.newRangeViolation(input);
      if (violation !== null) {
        return {
          result: rejection(operation, violation.reasonCode, violation.field),
          applied: false,
        };
      }
    }

    const rangeType = own?.rangeType ?? input.rangeType;

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${rangeLockKey(context.patientId, rangeType)}, 0))
      `;

      const stored = await tx.effectiveRange.findFirst({
        where: { id: operation.entityId, patientId: context.patientId },
      });

      if (stored === null) {
        return this.createPatientRange(tx, context, operation, input, correlationId);
      }

      // WHAT before WHEN — see this method's comment.
      const breach = rangeRowViolation(stored, input);
      if (breach !== null) {
        return { result: rejection(operation, breach.reasonCode, breach.field), applied: false };
      }

      // The row already holds this status: nothing to write, and writing anyway
      // would move its timestamp and let a no-op win a later comparison.
      if (input.status === stored.status) {
        const result = acceptedResultFor(operation, stored.serverSequence);
        await this.writeOperationRecord(tx, context, operation, result);
        return { result, applied: false };
      }

      // Out of date: a newer write to this row exists (§4). And a CREATE whose
      // row exists with a different status is the same thing seen from a
      // replay — the creation landed, and a later decision has since moved the
      // row on — so it is `superseded`, never a status correction the patient
      // would be asked to make.
      if (operation.clientTimestamp.getTime() < stored.clientUpdatedAt.getTime() || isCreate) {
        return this.recordRangeSuperseded(tx, context, operation, stored, input, correlationId);
      }

      const refusal = statusTransitionViolation(stored.status, input.status);
      if (refusal !== null) {
        return { result: rejection(operation, refusal.reasonCode, refusal.field), applied: false };
      }
      return this.changeRangeStatus(tx, context, operation, stored, input.status, correlationId);
    });
  }

  /** The incoming range lost. Result `superseded`, and the INCOMING version — validated — goes to the audit log (§4.1). */
  private async recordRangeSuperseded(
    tx: Prisma.TransactionClient,
    context: PatientContext,
    operation: SyncPushOperationParsed,
    stored: EffectiveRange,
    input: RangeWriteInput,
    correlationId: string | undefined,
  ): Promise<OperationOutcome> {
    const result = syncSupersededResult({
      operationId: toOperationId(operation.operationId),
      entityId: toEntityId(operation.entityId),
      appliedServerSequence: toServerSequence(stored.serverSequence.toString()),
      replayed: false,
    });
    await this.audit.record(
      {
        actorType: 'PATIENT',
        actorId: context.actorId,
        action: 'UPDATE',
        entityType: RANGE_ENTITY_TYPE,
        entityId: operation.entityId,
        reasonCode: SYNC_CONFLICT_LOSER_REASON,
        beforeValue: incomingRangeSnapshot(operation.entityId, input, operation.clientTimestamp),
        ...(correlationId !== undefined ? { correlationId } : {}),
      },
      tx,
    );
    await this.writeOperationRecord(tx, context, operation, result);
    return { result, applied: false };
  }

  /** The limits row for a range type, in the shape `newPatientRangeViolation` takes. */
  private async rangeTypeLimits(rangeType: string): Promise<RangeTypeLimits | undefined> {
    const limits = await this.prisma.clinicalDefaultRangeLimits.findUnique({
      where: { rangeType },
    });
    return limits === null
      ? undefined
      : {
          unit: limits.unit,
          minValue: limits.minValue.toNumber(),
          maxValue: limits.maxValue.toNumber(),
        };
  }

  /** The create-only rules that need the limits table (`newPatientRangeViolation`). */
  private async newRangeViolation(
    input: RangeWriteInput,
  ): Promise<{ reasonCode: SyncReasonCode; field: SyncFieldPath } | null> {
    const invalidField = (field: SyncFieldPath) => ({
      reasonCode: SYNC_REASON_CODE.PAYLOAD_FIELD_INVALID,
      field,
    });
    // Never a physician's value (AC 14.1 AC4), never a default's: those are not
    // a patient's to assert.
    if (!PATIENT_PROVENANCES.has(input.provenance)) return invalidField(SYNC_FIELD_PATH.PROVENANCE);
    // Never a proposal: a suggestion awaiting a human is the system's to make,
    // and a patient creating one would be confirming nothing.
    if (input.status !== RangeStatus.ACTIVE) return invalidField(SYNC_FIELD_PATH.STATUS);
    // Server-assigned (§7.6), so a client cannot rewrite which row this replaced.
    if (input.previousRangeId !== null) return invalidField(SYNC_FIELD_PATH.PREVIOUS_RANGE_ID);

    const field = newPatientRangeViolation(input, await this.rangeTypeLimits(input.rangeType));
    return field === null ? null : invalidField(field);
  }

  /**
   * Makes the incoming decision the patient's value in force for its type,
   * unless a newer patient decision already is — a newer value, or a newer
   * WITHDRAWAL. Returns the status the incoming row should take and the row it
   * replaced, having superseded every other active patient value.
   *
   * Read under the advisory lock, so nothing can become active between this
   * read and the write that follows it.
   */
  private async takeOverFromPatientRanges(
    tx: Prisma.TransactionClient,
    context: PatientContext,
    operation: SyncPushOperationParsed,
    rangeType: string,
    correlationId: string | undefined,
  ): Promise<{ status: RangeStatus; previousRangeId: string | null }> {
    // ACTIVE and SUPERSEDED both carry a decision time: when a value was set,
    // and when one was withdrawn or replaced. The newest of them is the
    // patient's latest decision for this type. Proposals and dismissals are
    // not decisions about the value in force, so they do not count.
    const decided = await tx.effectiveRange.findMany({
      where: {
        patientId: context.patientId,
        rangeType,
        id: { not: operation.entityId },
        status: { in: [RangeStatus.ACTIVE, RangeStatus.SUPERSEDED] },
        provenance: { in: [...PATIENT_PROVENANCES] },
        deletedAt: null,
      },
      orderBy: { clientUpdatedAt: 'desc' },
    });
    const latest = decided[0];
    if (
      latest !== undefined &&
      latest.clientUpdatedAt.getTime() > operation.clientTimestamp.getTime()
    ) {
      // A newer decision already stands. This one is kept as history.
      return { status: RangeStatus.SUPERSEDED, previousRangeId: null };
    }

    const active = decided.filter((row) => row.status === RangeStatus.ACTIVE);
    for (const other of active) {
      const superseded = await tx.effectiveRange.update({
        where: { id: other.id, patientId: context.patientId },
        data: { status: RangeStatus.SUPERSEDED, clientUpdatedAt: operation.clientTimestamp },
      });
      await this.audit.record(
        {
          actorType: 'PATIENT',
          actorId: context.actorId,
          action: 'UPDATE',
          entityType: RANGE_ENTITY_TYPE,
          entityId: other.id,
          // Its own reason, and the successor named, so "who changed my
          // threshold" is answerable from this row alone — a withdrawal the
          // patient chose and a value their new one replaced are different
          // answers (#146 review).
          reasonCode: RANGE_REPLACED_REASON,
          beforeValue: toRangeAuditSnapshot(other),
          afterValue: { ...toRangeAuditSnapshot(superseded), supersededBy: operation.entityId },
          ...(correlationId !== undefined ? { correlationId } : {}),
        },
        tx,
      );
    }
    return { status: RangeStatus.ACTIVE, previousRangeId: active[0]?.id ?? null };
  }

  private async createPatientRange(
    tx: Prisma.TransactionClient,
    context: PatientContext,
    operation: SyncPushOperationParsed,
    input: RangeWriteInput,
    correlationId: string | undefined,
  ): Promise<OperationOutcome> {
    const { status, previousRangeId } = await this.takeOverFromPatientRanges(
      tx,
      context,
      operation,
      input.rangeType,
      correlationId,
    );

    const written = await tx.effectiveRange.create({
      data: {
        id: operation.entityId,
        patientId: context.patientId,
        rangeType: input.rangeType,
        lowValue: input.lowValue,
        highValue: input.highValue,
        targetValue: input.targetValue,
        unit: input.unit,
        provenance: input.provenance,
        status,
        previousRangeId,
        clientUpdatedAt: operation.clientTimestamp,
      },
    });

    await this.audit.record(
      {
        actorType: 'PATIENT',
        actorId: context.actorId,
        action: 'CREATE',
        entityType: RANGE_ENTITY_TYPE,
        entityId: operation.entityId,
        reasonCode: SYNC_APPLIED_REASON,
        afterValue: toRangeAuditSnapshot(written),
        ...(correlationId !== undefined ? { correlationId } : {}),
      },
      tx,
    );

    // `accepted` even when the row was stored as superseded history: the row
    // DOES reflect this operation — it was written, with the status a newer
    // decision gave it — and the delta pull tells the device so (§7.6).
    const result = acceptedResultFor(operation, written.serverSequence);
    await this.writeOperationRecord(tx, context, operation, result);
    return { result, applied: true };
  }

  private async changeRangeStatus(
    tx: Prisma.TransactionClient,
    context: PatientContext,
    operation: SyncPushOperationParsed,
    stored: EffectiveRange,
    requested: RangeStatus,
    correlationId: string | undefined,
  ): Promise<OperationOutcome> {
    let status = requested;
    let previousRangeId = stored.previousRangeId;

    if (stored.status === RangeStatus.PROPOSED && requested === RangeStatus.ACTIVE) {
      // Accepting makes a proposal a threshold, so it must pass what a new
      // patient value must pass — today's proposals have no writer, and
      // whichever one is built must not be able to route a safety bound or an
      // out-of-limits value through a patient's tap (#146 review).
      const field = newPatientRangeViolation(
        {
          rangeType: stored.rangeType,
          lowValue: toNumberOrNull(stored.lowValue),
          highValue: toNumberOrNull(stored.highValue),
          targetValue: toNumberOrNull(stored.targetValue),
          unit: stored.unit,
          provenance: stored.provenance,
          status: requested,
          previousRangeId: stored.previousRangeId,
        },
        await this.rangeTypeLimits(stored.rangeType),
      );
      if (field !== null) {
        return {
          result: rejection(operation, SYNC_REASON_CODE.PAYLOAD_FIELD_INVALID, field),
          applied: false,
        };
      }
      // The same takeover rule as a create, and the same link to what it
      // replaced (§7.6) — unless the proposal already carried one.
      const takeover = await this.takeOverFromPatientRanges(
        tx,
        context,
        operation,
        stored.rangeType,
        correlationId,
      );
      status = takeover.status;
      previousRangeId = stored.previousRangeId ?? takeover.previousRangeId;
    }

    const written = await tx.effectiveRange.update({
      where: { id: operation.entityId, patientId: context.patientId },
      data: { status, previousRangeId, clientUpdatedAt: operation.clientTimestamp },
    });

    await this.audit.record(
      {
        actorType: 'PATIENT',
        actorId: context.actorId,
        action: 'UPDATE',
        entityType: RANGE_ENTITY_TYPE,
        entityId: operation.entityId,
        reasonCode: SYNC_APPLIED_REASON,
        beforeValue: toRangeAuditSnapshot(stored),
        afterValue: toRangeAuditSnapshot(written),
        ...(correlationId !== undefined ? { correlationId } : {}),
      },
      tx,
    );
    // §4.1: the displaced version as its own row, as every other entity does.
    await this.audit.record(
      {
        actorType: 'PATIENT',
        actorId: context.actorId,
        action: 'UPDATE',
        entityType: RANGE_ENTITY_TYPE,
        entityId: operation.entityId,
        reasonCode: SYNC_CONFLICT_LOSER_REASON,
        beforeValue: toRangeAuditSnapshot(stored),
        ...(correlationId !== undefined ? { correlationId } : {}),
      },
      tx,
    );

    const result = acceptedResultFor(operation, written.serverSequence);
    await this.writeOperationRecord(tx, context, operation, result);
    return { result, applied: true };
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

  /**
   * The `Meal` push path (§7.4, SRS AC 2.4) — the mirror of
   * `applyObservation` for the first app-native synced entity.
   *
   * Everything structural is identical and deliberately so: lookup by
   * (patient, entityId) TOGETHER (§2), last-write-wins by client timestamp
   * (§4) with the same three outcomes, `ENTITY_NOT_FOUND` for an update or
   * delete against a row this patient does not have, and the same audit
   * obligations (§4.1). A meal that behaved differently from an observation
   * under conflict would make the contract mean two things.
   *
   * What differs is validation, and only validation: a meal has no value, no
   * unit and no Measured/Estimated toggle, so `evaluateTier1` does not apply —
   * but the two TIMESTAMP rules do, through the shared
   * `evaluateEntryTimestamp` that `evaluateTier1` also composes.
   */
  private async applyMeal(
    context: PatientContext,
    operation: SyncPushOperationParsed,
    correlationId: string | undefined,
  ): Promise<OperationOutcome> {
    const isDelete = operation.operationType === SYNC_OPERATION_TYPE.DELETE;

    // §2/§4: by (patient, entityId) together, never `findUnique({ id })`. An
    // id resolving only to another patient's row is treated as not existing,
    // so it takes the same branch and returns a byte-identical result as an
    // id that exists for nobody — a distinct code would itself be the
    // disclosure.
    const stored = await this.prisma.meal.findFirst({
      where: { id: operation.entityId, patientId: context.patientId },
    });

    if (stored === null && (isDelete || operation.operationType === SYNC_OPERATION_TYPE.UPDATE)) {
      return {
        result: rejection(operation, SYNC_REASON_CODE.ENTITY_NOT_FOUND, SYNC_FIELD_PATH.ENTITY_ID),
        applied: false,
      };
    }

    // §4: last-write-wins, including for a CREATE against an existing row —
    // that is an ordinary comparison, never a rejection. The reachable case is
    // not a client bug: the server applies a create, the response is lost, the
    // client re-pushes.
    if (stored !== null && operation.clientTimestamp.getTime() < stored.clientUpdatedAt.getTime()) {
      return this.recordMealSuperseded(context, operation, stored, correlationId);
    }

    return isDelete
      ? this.applyMealDelete(context, operation, stored, correlationId)
      : this.applyMealUpsert(context, operation, stored, correlationId);
  }

  /** The incoming meal lost. Result `superseded`, and the INCOMING version goes to the audit log (§4.1). */
  private async recordMealSuperseded(
    context: PatientContext,
    operation: SyncPushOperationParsed,
    stored: Meal,
    correlationId: string | undefined,
  ): Promise<OperationOutcome> {
    const result = syncSupersededResult({
      operationId: toOperationId(operation.operationId),
      entityId: toEntityId(operation.entityId),
      // §3.6: for a superseded result this is the WINNING row's sequence, not
      // this operation's — the receipt names where the entity row stands.
      appliedServerSequence: toServerSequence(stored.serverSequence.toString()),
      replayed: false,
    });

    await this.prisma.$transaction(async (tx) => {
      await this.audit.record(
        {
          actorType: 'PATIENT',
          actorId: context.actorId,
          action: 'UPDATE',
          entityType: MEAL_ENTITY_TYPE,
          entityId: operation.entityId,
          reasonCode: SYNC_CONFLICT_LOSER_REASON,
          // The INCOMING version that lost — not the stored one. Nothing the
          // patient recorded is destroyed; it is moved somewhere append-only,
          // which is the only reason last-write-wins is acceptable for
          // clinical data at all (§4.1).
          beforeValue: incomingMealSnapshot(operation),
          ...(correlationId !== undefined ? { correlationId } : {}),
        },
        tx,
      );
      await this.writeOperationRecord(tx, context, operation, result);
    });

    return { result, applied: false };
  }

  private async applyMealUpsert(
    context: PatientContext,
    operation: SyncPushOperationParsed,
    stored: Meal | null,
    correlationId: string | undefined,
  ): Promise<OperationOutcome> {
    // Payload CONTENT validation, per operation — never in the pipe (§6.1).
    let input;
    try {
      const parsed = mealRequestParseSchema.parse(operation.payload);
      input = interpretMealPayload(parsed);
    } catch (error) {
      const detail = firstRejectionDetail(error);
      return { result: rejection(operation, detail.reasonCode, detail.field), applied: false };
    }

    // The two Tier 1 rules a meal is subject to. Shared with volumetric
    // entries through `packages/core`, so the clock-skew allowance a meal is
    // judged against is the same admin-managed row an observation is.
    const thresholds = await this.thresholds.getVolumetricThresholds();
    const timestampErrors = evaluateEntryTimestamp(
      {
        field: MEAL_FIELD.EFFECTIVE_DATE_TIME,
        effectiveDateTime: input.effectiveDateTime,
        surgeryDate: context.surgeryDate,
        // The zone the device asserted, so the surgery-date rule compares the
        // PATIENT's calendar day. A queued meal from a travelling patient carries
        // the zone they were in when they made it, which is the whole point of
        // ADR-0016's per-row zone.
        enteredTimezone: input.enteredTimezone,
        now: new Date(),
      },
      thresholds,
    );

    const firstTimestampError = timestampErrors[0];
    if (firstTimestampError !== undefined) {
      // First in §6.2's order, like every other rejection on this surface.
      return {
        result: rejection(
          operation,
          firstTimestampError.ruleCode as Parameters<typeof rejection>[1],
          MEAL_FIELD.EFFECTIVE_DATE_TIME,
        ),
        applied: false,
      };
    }

    const data: Prisma.MealUncheckedCreateInput = {
      id: operation.entityId,
      patientId: context.patientId,
      description: input.description,
      size: toStoredSize(input.size),
      tagCodes: [...input.tagCodes],
      effectiveDatetime: input.effectiveDateTime,
      // ADR-0016: client-asserted zone, server-derived day. The UTC-midnight
      // construction is how Prisma takes a calendar DATE without a zone
      // shifting it by one.
      enteredTimezone: input.enteredTimezone,
      localDate: new Date(`${input.localDate}T00:00:00.000Z`),
      clientUpdatedAt: operation.clientTimestamp,
      deletedAt: null,
    };

    const row = await this.prisma.$transaction(async (tx) => {
      const written =
        stored === null
          ? await tx.meal.create({ data })
          : await tx.meal.update({
              where: { id: operation.entityId, patientId: context.patientId },
              // A full replacement, not a patch (§4). `deletedAt: null` is
              // what resurrects a tombstoned meal when an update beats a
              // delete.
              data,
            });

      await this.audit.record(
        {
          actorType: 'PATIENT',
          actorId: context.actorId,
          action: stored === null ? 'CREATE' : 'UPDATE',
          entityType: MEAL_ENTITY_TYPE,
          entityId: operation.entityId,
          reasonCode: SYNC_APPLIED_REASON,
          ...(stored !== null ? { beforeValue: toMealAuditSnapshot(stored) } : {}),
          afterValue: toMealAuditSnapshot(written),
          ...(correlationId !== undefined ? { correlationId } : {}),
        },
        tx,
      );

      // §4.1: an accepted operation that DISPLACED a stored version writes a
      // second row carrying that version as it was. Two rows, two things.
      if (stored !== null) {
        await this.audit.record(
          {
            actorType: 'PATIENT',
            actorId: context.actorId,
            action: 'UPDATE',
            entityType: MEAL_ENTITY_TYPE,
            entityId: operation.entityId,
            reasonCode: SYNC_CONFLICT_LOSER_REASON,
            beforeValue: toMealAuditSnapshot(stored),
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

  private async applyMealDelete(
    context: PatientContext,
    operation: SyncPushOperationParsed,
    stored: Meal | null,
    correlationId: string | undefined,
  ): Promise<OperationOutcome> {
    if (stored === null) {
      throw new Error(
        'applyMealDelete reached with no stored row; applyMeal should have rejected it.',
      );
    }

    const row = await this.prisma.$transaction(async (tx) => {
      // A tombstone, never a hard DELETE (§1) — and the runtime role holds no
      // DELETE grant on this table, so a hard delete would fail at the
      // database too.
      const written = await tx.meal.update({
        where: { id: operation.entityId, patientId: context.patientId },
        data: { deletedAt: new Date(), clientUpdatedAt: operation.clientTimestamp },
      });

      // §4.1: the FULL pre-deletion state as `beforeValue`, `afterValue`
      // null. The tombstone carries nothing on the wire precisely because the
      // audit store carries everything.
      await this.audit.record(
        {
          actorType: 'PATIENT',
          actorId: context.actorId,
          action: 'DELETE',
          entityType: MEAL_ENTITY_TYPE,
          entityId: operation.entityId,
          reasonCode: SYNC_APPLIED_REASON,
          beforeValue: toMealAuditSnapshot(stored),
          ...(correlationId !== undefined ? { correlationId } : {}),
        },
        tx,
      );

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

  private async applyObservation(
    context: PatientContext,
    operation: SyncPushOperationParsed,
    correlationId: string | undefined,
  ): Promise<OperationOutcome> {
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
          entityType: OBSERVATION_ENTITY_TYPE,
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
  ): Promise<OperationOutcome> {
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
  ): Promise<OperationOutcome> {
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

    // Which engine follows from whether the payload carried a volume, exactly
    // as it does on the direct endpoint (`observations.service.ts`) — §6.3
    // requires the two paths to reach the same verdict on the same payload,
    // and a colour-only voided-urine entry (AC 12.1 AC2) is a payload only one
    // of them used to accept.
    //
    // Before this branch existed, a queued colour-only entry reached
    // `evaluateTier1` with no number, was blocked on a value rule it was never
    // subject to, and landed in the patient's correction inbox naming a field
    // their entry form left deliberately blank — §9.2's retry-unchanged loop,
    // through a rule that does not apply.
    //
    // `hasVolume`, not `rawValueMl !== undefined`: `interpretObservationPayload`
    // exists to tell an ABSENT `valueQuantity` apart from one present with a
    // null value, and collapsing them here would re-introduce the defect that
    // flag was added for — a stoma-output payload sending `value: null` routed
    // to the volume-less engine, which has no value rules and accepts it.
    const tier1 = !input.hasVolume
      ? validateVolumelessObservation(
          {
            // Named on the colour: it is the only clinical content a
            // volume-less entry carries, so it is the field the patient's
            // correction inbox can act on.
            field: SYNC_FIELD_PATH.URINE_COLOR_CODE,
            method: toMeasuredOrEstimated(input.method),
            effectiveDateTime: input.effectiveDateTime,
            surgeryDate: context.surgeryDate,
            enteredTimezone: input.enteredTimezone,
            now: new Date(),
          },
          thresholds,
        ).tier1
      : evaluateTier1(
          {
            field: SYNC_FIELD_PATH.VALUE_QUANTITY_VALUE,
            rawValueMl: input.rawValueMl,
            method: toMeasuredOrEstimated(input.method),
            effectiveDateTime: input.effectiveDateTime,
            surgeryDate: context.surgeryDate,
            enteredTimezone: input.enteredTimezone,
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
      // `null` when the payload carried no volume, never a `Decimal(null)`
      // and never zero. `new Prisma.Decimal(null as unknown as number)` is
      // what stood here, and on a colour-only entry it threw inside the
      // transaction — a 500, which `docs/sync-contract.md` §9 tells a client
      // to re-push indefinitely, so the entry would retry forever instead of
      // ever being stored.
      valueQuantityValue: input.hasVolume ? new Prisma.Decimal(input.rawValueMl as number) : null,
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
      // Both app-native coded fields, and both were MISSING from this write.
      //
      // The direct endpoint has persisted `fluidTypeCode` since P3.S1 and
      // this one never did, so every intake entry a patient logged OFFLINE
      // lost its categorisation on push — silently, because the field is
      // optional on the payload type and nothing compared the two write
      // paths. `urineColorCode` would have gone the same way, and for a
      // colour-only entry the loss is total: the colour is the only clinical
      // content the row carries, so the database CHECK would refuse the
      // insert outright as a 500.
      //
      // Already narrowed by `interpretObservationPayload` — `null` unless the
      // code accepts the field and the patient supplied it.
      fluidTypeCode: input.fluidTypeCode,
      urineColorCode: input.urineColorCode,
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
  ): Promise<OperationOutcome> {
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
        // The operation's own type. This was the literal `OBSERVATION` for every
        // record, so each meal's idempotency row misdescribed what it was about
        // from P3.S1 until P4.S3 (replay was unaffected: it keys on
        // (patient, operationId)).
        entityType: toStoredEntityType(operation.entityType),
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

/**
 * What one operation produced. `surgeryDate` is set only by an accepted
 * profile update, and is the new bound for the rest of the batch (`push`).
 */
interface OperationOutcome {
  readonly result: SyncOperationResult;
  readonly applied: boolean;
  readonly surgeryDate?: string;
}

/** The entity types this release applies. Anything else is refused per operation, naming `entityType`. */
const HANDLED_ENTITY_TYPES: ReadonlySet<string> = new Set<string>([
  SYNC_ENTITY_TYPE.OBSERVATION,
  SYNC_ENTITY_TYPE.MEAL,
  SYNC_ENTITY_TYPE.PROFILE,
  SYNC_ENTITY_TYPE.EFFECTIVE_RANGE,
]);

const STORED_ENTITY_TYPE: Readonly<Record<string, SyncEntityType>> = {
  [SYNC_ENTITY_TYPE.OBSERVATION]: SyncEntityType.OBSERVATION,
  [SYNC_ENTITY_TYPE.MEAL]: SyncEntityType.MEAL,
  [SYNC_ENTITY_TYPE.PROFILE]: SyncEntityType.PROFILE,
  [SYNC_ENTITY_TYPE.EFFECTIVE_RANGE]: SyncEntityType.EFFECTIVE_RANGE,
};

function toStoredEntityType(entityType: string): SyncEntityType {
  const stored = STORED_ENTITY_TYPE[entityType];
  if (stored === undefined) {
    // Unreachable: the pipe admits only `SYNC_ENTITY_TYPE` members. A throw
    // rather than a fallback, because a fallback is how every meal came to be
    // recorded as an observation.
    throw new Error('No stored sync_entity_type for this wire entity type.');
  }
  return stored;
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
    // The fields this snapshot omitted, and why it mattered more here than
    // anywhere else: §4.1 requires the LOSING version of a conflict to be
    // preserved rather than discarded, and that requirement is the only reason
    // last-write-wins is acceptable for clinical data at all.
    //
    // For a colour-only voided-urine entry the omission was total. The colour
    // is the entry's whole clinical content, so `valueQuantityValue` and
    // `valueQuantityUnit` resolved to `undefined`, JSON dropped both keys, and
    // the audit row recorded a losing version with no values in it. The loser
    // WAS discarded — tripwire 7 in its documented form.
    urineColorCode: payload.urineColorCode ?? null,
    fluidTypeCode: payload.fluidTypeCode ?? null,
    // `?? null` here too, so an absent field records `null` rather than
    // dropping its key — one representation of "the client did not send this",
    // in a table with no UPDATE grant to tidy later.
    enteredTimezone: payload.enteredTimezone ?? null,
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

/**
 * The INCOMING meal that lost a conflict, as §4.1 requires it be audited.
 *
 * Built from the operation rather than from a stored row, because the whole
 * point is that this version was never written. Field by field and never a
 * spread of `operation.payload`: that object is client-supplied and
 * unvalidated at this point, so a spread would put arbitrary client content
 * into the audit store.
 *
 * The payload is recorded as the client sent it, including fields that failed
 * nothing — this is the losing VERSION, and an audit row that trimmed it to
 * what the server would have stored would not be a record of what the patient
 * wrote.
 */
function incomingMealSnapshot(operation: SyncPushOperationParsed): Record<string, unknown> {
  const payload = (operation.payload ?? {}) as Record<string, unknown>;
  return {
    id: operation.entityId,
    description: payload.description ?? null,
    size: payload.size ?? null,
    tagCodes: payload.tagCodes ?? [],
    effectiveDatetime: payload.effectiveDateTime ?? null,
    enteredTimezone: payload.enteredTimezone ?? null,
    clientUpdatedAt: operation.clientTimestamp.toISOString(),
  };
}
