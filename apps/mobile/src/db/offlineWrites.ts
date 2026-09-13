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

import { toLocalDate, type MeasurementSystem } from '@ostomy/core/units';
import type { CanonicalWireUnit } from '@ostomy/core/sync';
import { ESTIMATION_METHOD_CODE } from '@ostomy/core/validation';

import { deviceTimeZone, toWireInstant } from '../lib/utils/clock';
import { generateUuid } from '../lib/utils/uuid';

import type { SqliteExecutor } from './executor';
import {
  insertObservation,
  replaceObservation,
  tombstoneObservation,
} from './repositories/observationsRepository';
import { enqueueOperation } from './repositories/syncQueueRepository';

/**
 * The offline-first write path (SRS §4.5, CLAUDE.md "Offline-first write
 * path"): every data-entry action writes to local `expo-sqlite` **first**
 * and appends to the local `sync_queue` in the **same transaction**, and
 * the save confirms from that local write alone. The Add Output screen
 * (P2.S2b) should call the three functions below directly rather than
 * re-deriving this pattern — that is the seam this module exists to be.
 *
 * None of these functions touch the network. Pushing the queue is
 * `apps/mobile`'s sync worker's job (P2.S2b, not built here).
 */

/** Whether a volumetric entry was measured or estimated (SRS §3.1's mandatory toggle). Not accepted at all for weight/heart-rate entries — see `MeasuredOrEstimated` in `@ostomy/core/validation`, which this mirrors; not imported directly because that type is about *validating* the choice, not about what a payload stores once made. */
export type MeasuredOrEstimated = 'measured' | 'estimated';

/**
 * Resolves the mandatory Measured/Estimated toggle to the wire's
 * `method` value. `null` for measured. For estimated, D4 (the SNOMED CT
 * "Estimation technique" code) is still unresolved — see
 * `@ostomy/core/validation`'s `ESTIMATION_METHOD_CODE` doc comment, which
 * spells out the three sanctioned responses to that: "queue it, error, or
 * block." This picks **error**, deliberately: silently writing `method:
 * null` for an Estimated entry would make it indistinguishable from
 * Measured, and queuing an entry this app cannot yet express correctly
 * would need a second, not-yet-designed local representation for "waiting
 * on D4" that nothing downstream reads. Weight and heart-rate entries
 * never call this function at all — `method` is `null` for them by
 * construction (CLAUDE.md: the toggle "applies to volumetric entries
 * only").
 */
function resolveMethod(measuredOrEstimated: MeasuredOrEstimated): string | null {
  if (measuredOrEstimated === 'measured') return null;
  if (!ESTIMATION_METHOD_CODE.resolved) {
    throw new Error(
      'Cannot save an Estimated entry yet: the SNOMED CT "Estimation technique" code (design decision D4) is still unresolved in @ostomy/core/validation. See ESTIMATION_METHOD_CODE\'s doc comment.',
    );
  }
  return ESTIMATION_METHOD_CODE.code;
}

interface VolumetricFields {
  readonly code: string;
  readonly valueQuantityValue: string;
  readonly valueQuantityUnit: CanonicalWireUnit;
  readonly effectiveDatetime: string;
  readonly measuredOrEstimated: MeasuredOrEstimated;
  readonly enteredMeasurementSystem: MeasurementSystem;
}

interface WeightOrHeartRateFields {
  readonly code: string;
  readonly valueQuantityValue: string;
  readonly valueQuantityUnit: CanonicalWireUnit;
  readonly effectiveDatetime: string;
  readonly enteredMeasurementSystem: MeasurementSystem;
}

/**
 * Builds the `ObservationSyncPayload`-shaped JSON this entity's queued
 * operation carries. Named field-by-field, never by spreading a row into
 * a literal — the same discipline `packages/core/src/sync`'s own
 * constructors enforce server-side, for the same reason (`docs/sync-contract.md`
 * §6.3): a spread typechecks even when the source object carries a field
 * that does not belong on the wire.
 */
/**
 * Builds the wire object for one observation.
 *
 * Called at PUSH time, not at enqueue. It used to run when the entry was
 * written and its output was frozen into `sync_queue.payload`, which made
 * every queued operation immune to a change in `docs/sync-contract.md` —
 * and that document is normative and does change. ADR-0016 is the live
 * case: it adds a required timezone field, and a frozen payload would go up
 * without it, be rejected Tier 1, and put a correction-inbox entry in front
 * of the patient naming a field no entry form contains.
 *
 * The sync worker calls this with values read from the `observations` row,
 * which is the single source of truth it always should have been.
 *
 * Every field is named explicitly rather than spread, mirroring the
 * server-side rule in `packages/core/src/sync`: TypeScript's
 * excess-property check does not apply to spread properties, so a spread
 * typechecks cleanly and ships fields the wire contract does not define.
 */
export function buildObservationPayload(fields: {
  id: string;
  code: string;
  valueQuantityValue: string;
  valueQuantityUnit: CanonicalWireUnit;
  effectiveDatetime: string;
  method: string | null;
  enteredMeasurementSystem: MeasurementSystem;
  /** IANA zone captured at entry (ADR-0016). */
  enteredTimezone: string;
}): string {
  return JSON.stringify({
    resourceType: 'Observation',
    id: fields.id,
    status: 'final',
    code: fields.code,
    valueQuantity: {
      // §7.3: valueQuantity.value is a JSON number on the wire. The local
      // column keeps the exact decimal string (../schema.ts); Number()
      // here is safe for the DECIMAL(12,4) values this app ever writes —
      // well under a double's exact-integer precision — and this is the
      // one place that conversion is allowed to happen, at the wire
      // boundary, never at rest.
      value: Number(fields.valueQuantityValue),
      unit: fields.valueQuantityUnit,
    },
    effectiveDateTime: fields.effectiveDatetime,
    method: fields.method,
    enteredMeasurementSystem: fields.enteredMeasurementSystem,
    enteredTimezone: fields.enteredTimezone,
  });
}

/** Creates a new volumetric observation (stoma output, fluid intake, or voided urine) and queues it for sync, atomically. */
export async function enqueueVolumetricObservationCreate(
  executor: SqliteExecutor,
  fields: VolumetricFields,
  now: () => Date,
): Promise<{ id: string; operationId: string }> {
  const method = resolveMethod(fields.measuredOrEstimated);
  return enqueueObservationCreate(executor, { ...fields, method }, now);
}

/** Creates a new weight or heart-rate observation and queues it for sync, atomically. Never accepts a Measured/Estimated choice — `method` is always `null` (CLAUDE.md: the toggle is volumetric-entry-only). */
export async function enqueueWeightOrHeartRateObservationCreate(
  executor: SqliteExecutor,
  fields: WeightOrHeartRateFields,
  now: () => Date,
): Promise<{ id: string; operationId: string }> {
  return enqueueObservationCreate(executor, { ...fields, method: null }, now);
}

async function enqueueObservationCreate(
  executor: SqliteExecutor,
  fields: {
    code: string;
    valueQuantityValue: string;
    valueQuantityUnit: CanonicalWireUnit;
    effectiveDatetime: string;
    method: string | null;
    enteredMeasurementSystem: MeasurementSystem;
  },
  now: () => Date,
): Promise<{ id: string; operationId: string }> {
  const id = generateUuid();
  // Distinct from `id` by construction (docs/sync-contract.md §1: "Never
  // the entity id") — two separate `generateUuid()` calls, never one value
  // reused for both.
  const operationId = generateUuid();
  const nowIso = toWireInstant(now());
  // Read HERE, not taken from the caller. A zone every call site has to
  // remember to pass is one some call site will forget, and a row written
  // without it can never have its day recovered (ADR-0016).
  const enteredTimezone = deviceTimeZone();
  const localDate = toLocalDate(new Date(fields.effectiveDatetime), enteredTimezone);

  await executor.withTransactionAsync(async () => {
    await insertObservation(
      executor,
      {
        id,
        code: fields.code,
        valueQuantityValue: fields.valueQuantityValue,
        valueQuantityUnit: fields.valueQuantityUnit,
        effectiveDatetime: fields.effectiveDatetime,
        method: fields.method,
        status: 'final',
        enteredMeasurementSystem: fields.enteredMeasurementSystem,
        enteredTimezone,
        localDate,
        clientUpdatedAt: nowIso,
      },
      nowIso,
    );
    await enqueueOperation(
      executor,
      {
        operationId,
        entityType: 'Observation',
        entityId: id,
        operationType: 'create',
        clientTimestamp: nowIso,
      },
      nowIso,
    );
  });

  return { id, operationId };
}

/**
 * Full-replacement update of an existing observation (`docs/sync-contract.md`
 * §4: "An update is a full replacement of the entity's fields, not a
 * patch") — every field must be supplied again, matching the wire
 * contract exactly rather than merging a partial change locally and
 * hoping the eventual payload matches what the server expects.
 */
export async function enqueueObservationUpdate(
  executor: SqliteExecutor,
  fields: {
    id: string;
    code: string;
    valueQuantityValue: string;
    valueQuantityUnit: CanonicalWireUnit;
    effectiveDatetime: string;
    method: string | null;
    enteredMeasurementSystem: MeasurementSystem;
  },
  now: () => Date,
): Promise<{ operationId: string }> {
  const operationId = generateUuid();
  const nowIso = toWireInstant(now());
  // Read HERE, not taken from the caller. A zone every call site has to
  // remember to pass is one some call site will forget, and a row written
  // without it can never have its day recovered (ADR-0016).
  const enteredTimezone = deviceTimeZone();
  const localDate = toLocalDate(new Date(fields.effectiveDatetime), enteredTimezone);

  await executor.withTransactionAsync(async () => {
    await replaceObservation(
      executor,
      {
        id: fields.id,
        code: fields.code,
        valueQuantityValue: fields.valueQuantityValue,
        valueQuantityUnit: fields.valueQuantityUnit,
        effectiveDatetime: fields.effectiveDatetime,
        method: fields.method,
        status: 'final',
        enteredMeasurementSystem: fields.enteredMeasurementSystem,
        enteredTimezone,
        localDate,
        clientUpdatedAt: nowIso,
      },
      nowIso,
    );
    await enqueueOperation(
      executor,
      {
        operationId,
        entityType: 'Observation',
        entityId: fields.id,
        operationType: 'update',
        clientTimestamp: nowIso,
      },
      nowIso,
    );
  });

  return { operationId };
}

/** Tombstones an observation locally and queues its delete (`docs/sync-contract.md` §3.1: "payload is absent for operationType: delete"). */
export async function enqueueObservationDelete(
  executor: SqliteExecutor,
  id: string,
  now: () => Date,
): Promise<{ operationId: string }> {
  const operationId = generateUuid();
  const nowIso = toWireInstant(now());

  // No zone here: a delete tombstones an EXISTING row and carries no
  // payload (`docs/sync-contract.md` §3.1), so there is nothing whose day
  // needs deciding.
  await executor.withTransactionAsync(async () => {
    await tombstoneObservation(executor, id, nowIso, nowIso, nowIso);
    await enqueueOperation(
      executor,
      {
        operationId,
        entityType: 'Observation',
        entityId: id,
        operationType: 'delete',
        clientTimestamp: nowIso,
      },
      nowIso,
    );
  });

  return { operationId };
}
