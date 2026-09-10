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
 * Everything between "a structurally well-formed payload" and "a row" —
 * release-scope acceptance, the Tier 1 field remap, and the two mappings
 * between storage and the wire.
 *
 * Pure functions only: no database, no request, no clock beyond what a
 * caller passes in. That is what lets `observation-payload.spec.ts` cover
 * the whole acceptance surface as unit tests, leaving the integration suite
 * to prove the things only a real PostgreSQL can prove.
 */
import {
  TIER1_RULE_CODE,
  type ValidationError,
  type ValidationWarning,
} from '@ostomy/core/validation';
import { SYNC_REASON_CODE, type SyncReasonCode, type Tier1ReasonCode } from '@ostomy/core/sync';
import type { MeasurementSystem as CoreMeasurementSystem } from '@ostomy/core/units';

import type { Observation } from '../generated/prisma/client';
import { MeasurementSystem, ObservationStatus } from '../generated/prisma/enums';
import { interpretMethodWireValue, type MethodWireInterpretation } from './estimation-method';
import {
  OBSERVATION_FIELD,
  ACCEPTED_OBSERVATION_STATUS,
  MEASUREMENT_SYSTEMS,
  STOMA_OUTPUT_CANONICAL_UNIT,
  STOMA_OUTPUT_LOINC_CODE,
  type ObservationRequestParsed,
  type ObservationResource,
} from './observation-wire';
import {
  payloadMalformed,
  type ObservationRejectionDetail,
  type ObservationRejectionField,
} from './observation-rejection';

/**
 * A payload this release is willing to *consider*. Everything here is
 * structurally sound and within the accepted code/status/unit sets — nothing
 * here has been clinically validated yet. `rawValueMl` is still `unknown`
 * on purpose: deciding whether it is a number at all is Tier 1's job
 * (`VALUE_NOT_NUMERIC`), not this layer's.
 */
export interface ObservationWriteInput {
  readonly id: string;
  readonly code: string;
  readonly rawValueMl: unknown;
  readonly unit: string;
  readonly effectiveDateTime: Date;
  readonly method: MethodWireInterpretation;
  readonly enteredMeasurementSystem: CoreMeasurementSystem;
}

/**
 * Release-scope acceptance. Throws an `ObservationRejectedException` — one
 * field, one code, no value — for the first failing check.
 *
 * Order matters and follows `docs/sync-contract.md` §6.2's own listing so
 * that two implementations of this contract walk a patient through the same
 * correction sequence for the same payload.
 */
export function interpretObservationPayload(
  parsed: ObservationRequestParsed,
): ObservationWriteInput {
  if (parsed.code !== STOMA_OUTPUT_LOINC_CODE) {
    // Not "unknown code" — this release simply has no handling for fluid
    // intake, voided urine, weight or heart rate yet, and accepting one
    // would write a row no read path understands.
    throw payloadMalformed({
      field: OBSERVATION_FIELD.CODE,
      reasonCode: SYNC_REASON_CODE.UNSUPPORTED_CODE,
    });
  }
  if (parsed.status !== ACCEPTED_OBSERVATION_STATUS) {
    throw payloadMalformed({
      field: OBSERVATION_FIELD.STATUS,
      reasonCode: SYNC_REASON_CODE.UNSUPPORTED_STATUS,
    });
  }
  if (parsed.valueQuantity.unit !== STOMA_OUTPUT_CANONICAL_UNIT) {
    // §7.2: the unit is determined by the code. A disagreement between the
    // two is the failure mode that is silent everywhere else — every daily
    // total and hydration computation reading the row would simply be wrong,
    // with no error raised at any layer.
    throw payloadMalformed({
      field: OBSERVATION_FIELD.UNIT,
      reasonCode: SYNC_REASON_CODE.PAYLOAD_FIELD_INVALID,
    });
  }

  const method = interpretMethodWireValue(parsed.method);
  if (method.kind === 'unrecognized') {
    throw payloadMalformed({
      field: OBSERVATION_FIELD.METHOD,
      reasonCode: SYNC_REASON_CODE.PAYLOAD_FIELD_INVALID,
    });
  }

  const enteredMeasurementSystem = toCoreMeasurementSystem(parsed.enteredMeasurementSystem);
  if (enteredMeasurementSystem === undefined) {
    throw payloadMalformed({
      field: OBSERVATION_FIELD.ENTERED_MEASUREMENT_SYSTEM,
      reasonCode: SYNC_REASON_CODE.PAYLOAD_FIELD_INVALID,
    });
  }

  return {
    id: parsed.id,
    code: parsed.code,
    rawValueMl: parsed.valueQuantity.value,
    unit: parsed.valueQuantity.unit,
    // Safe to construct: the zod layer already pinned the lexical form to
    // RFC 3339 with exactly three fractional digits and a `Z` offset (§7.3),
    // so this cannot be an Invalid Date.
    effectiveDateTime: new Date(parsed.effectiveDateTime),
    method,
    enteredMeasurementSystem,
  };
}

function toCoreMeasurementSystem(raw: string): CoreMeasurementSystem | undefined {
  return (MEASUREMENT_SYSTEMS as readonly string[]).includes(raw)
    ? (raw as CoreMeasurementSystem)
    : undefined;
}

/**
 * Which wire field each Tier 1 rule is *about*.
 *
 * This table exists because of a real limitation in `packages/core`, and it
 * is worth naming rather than burying: `VolumetricEntryInput` carries a
 * single `field` string for the whole entry, and `evaluateTier1` stamps that
 * one value onto every error it produces — so `METHOD_REQUIRED` and
 * `EFFECTIVE_DATE_TIME_IN_FUTURE` come back naming whatever field the caller
 * passed in, typically the value. `docs/sync-contract.md` §6.2 requires
 * `field` to name the offending field, and a correction UI needs it to
 * highlight the right input. Until `packages/core` (owned elsewhere under
 * ADR-0007) can attach a field per rule, the API re-derives it from the rule
 * code, which is unambiguous: each Tier 1 rule is about exactly one field.
 */
const TIER1_FIELD: Readonly<Record<Tier1ReasonCode, ObservationRejectionField>> = {
  [TIER1_RULE_CODE.VALUE_NOT_NUMERIC]: OBSERVATION_FIELD.VALUE,
  [TIER1_RULE_CODE.VALUE_NOT_POSITIVE]: OBSERVATION_FIELD.VALUE,
  [TIER1_RULE_CODE.VALUE_EXCEEDS_MAX_MAGNITUDE]: OBSERVATION_FIELD.VALUE,
  [TIER1_RULE_CODE.VALUE_EXCEEDS_MAX_PRECISION]: OBSERVATION_FIELD.VALUE,
  [TIER1_RULE_CODE.METHOD_REQUIRED]: OBSERVATION_FIELD.METHOD,
  [TIER1_RULE_CODE.EFFECTIVE_DATE_TIME_IN_FUTURE]: OBSERVATION_FIELD.EFFECTIVE_DATE_TIME,
  [TIER1_RULE_CODE.EFFECTIVE_DATE_TIME_BEFORE_SURGERY]: OBSERVATION_FIELD.EFFECTIVE_DATE_TIME,
};

/**
 * Projects `packages/core`'s Tier 1 errors onto the wire rejection shape.
 *
 * Built by naming two fields, never by spreading the `ValidationError`
 * (§6.3): a spread typechecks and would ship whatever the source object
 * carried, now or after a future change to that type.
 */
export function toRejectionDetails(
  errors: readonly ValidationError[],
): ObservationRejectionDetail[] {
  return errors.map((error) => {
    // Keyed by `Tier1ReasonCode`, not `string`, and with no `??` fallback
    // (P2.S1a review, finding 8): a new Tier 1 rule added in `packages/core`
    // — a different owner under ADR-0007, landing in a different sprint —
    // is now a compile error here rather than a rejection that silently
    // names `valueQuantity.value` for a rule about some other field and
    // casts an unlisted code past the closed `SyncReasonCode` set. The
    // correction UI highlights the wrong input when that happens, and no
    // test catches it.
    const field = TIER1_FIELD[error.ruleCode as Tier1ReasonCode];
    if (field === undefined) {
      throw new Error(
        `No rejection field is mapped for Tier 1 rule code "${error.ruleCode}". ` +
          'Add it to TIER1_FIELD in observation-payload.ts — see docs/sync-contract.md §6.2.',
      );
    }
    return { field, reasonCode: error.ruleCode as SyncReasonCode };
  });
}

/**
 * A Tier 2 warning as it appears on a **successful** response.
 *
 * Structurally identical to a rejection detail and deliberately carried on a
 * `201`, where it cannot block anything: SRS §3.8's rule is that a warning
 * never becomes an error, and the safest way to hold that is for the warning
 * to exist only on the success path. It carries no value either — a warning
 * is as forwardable as a rejection, and §6.3's argument applies unchanged.
 */
export interface ObservationWarning {
  readonly field: ObservationRejectionField;
  readonly ruleCode: string;
}

export function toWarnings(warnings: readonly ValidationWarning[]): ObservationWarning[] {
  return warnings.map((warning) => ({
    field: OBSERVATION_FIELD.VALUE,
    ruleCode: warning.ruleCode,
  }));
}

const STATUS_TO_WIRE: Readonly<Record<ObservationStatus, ObservationResource['status']>> = {
  [ObservationStatus.REGISTERED]: 'registered',
  [ObservationStatus.PRELIMINARY]: 'preliminary',
  [ObservationStatus.FINAL]: 'final',
  [ObservationStatus.AMENDED]: 'amended',
  [ObservationStatus.CORRECTED]: 'corrected',
  [ObservationStatus.CANCELLED]: 'cancelled',
  [ObservationStatus.ENTERED_IN_ERROR]: 'entered-in-error',
  [ObservationStatus.UNKNOWN]: 'unknown',
};

const SYSTEM_TO_WIRE: Readonly<Record<MeasurementSystem, CoreMeasurementSystem>> = {
  [MeasurementSystem.METRIC]: 'metric',
  [MeasurementSystem.IMPERIAL]: 'imperial',
};

const SYSTEM_TO_STORAGE: Readonly<Record<CoreMeasurementSystem, MeasurementSystem>> = {
  metric: MeasurementSystem.METRIC,
  imperial: MeasurementSystem.IMPERIAL,
};

export function toStoredMeasurementSystem(system: CoreMeasurementSystem): MeasurementSystem {
  return SYSTEM_TO_STORAGE[system];
}

export function toWireMeasurementSystem(system: MeasurementSystem): CoreMeasurementSystem {
  return SYSTEM_TO_WIRE[system];
}

/**
 * A stored row as §7.2 spells it.
 *
 * Built field by field. Everything the row carries that §7.2 does not name —
 * `patientId`, `serverSequence`, `deletedAt`, `createdAt`, `updatedAt`,
 * `clientUpdatedAt` — is absent because it is not written here, not because
 * something filtered it out afterwards.
 */
export function toObservationResource(row: Observation): ObservationResource {
  return {
    resourceType: 'Observation',
    id: row.id,
    status: STATUS_TO_WIRE[row.status],
    code: row.code,
    valueQuantity: {
      // `Decimal` -> `number`. DECIMAL(12,4) is nowhere near a double's
      // exact-integer limit, and §7.3 keeps a clinical value a JSON number
      // rather than a string.
      value: row.valueQuantityValue.toNumber(),
      unit: row.valueQuantityUnit as ObservationResource['valueQuantity']['unit'],
    },
    // `toISOString()` is RFC 3339, UTC, exactly three fractional digits —
    // the lexical form §7.3 pins.
    effectiveDateTime: row.effectiveDatetime.toISOString(),
    method: row.method,
    enteredMeasurementSystem: toWireMeasurementSystem(row.enteredMeasurementSystem),
  };
}

/**
 * The `beforeValue`/`afterValue` an audit row carries.
 *
 * The **entity's own stored fields**, never the request body — `audit.service
 * .ts` is explicit that it does not scrub what it is given, and a body spread
 * would carry client-supplied extra keys into an append-only table with no
 * UPDATE grant to correct them. `serverSequence` is stringified because JSON
 * cannot hold a BigInt (and §7.3 makes it a string on the wire for the same
 * 2^53 reason).
 */
export function toAuditSnapshot(row: Observation): Record<string, unknown> {
  return {
    id: row.id,
    patientId: row.patientId,
    resourceType: row.resourceType,
    code: row.code,
    valueQuantityValue: row.valueQuantityValue.toNumber(),
    valueQuantityUnit: row.valueQuantityUnit,
    effectiveDatetime: row.effectiveDatetime.toISOString(),
    method: row.method,
    status: row.status,
    enteredMeasurementSystem: row.enteredMeasurementSystem,
    clientUpdatedAt: row.clientUpdatedAt.toISOString(),
    serverSequence: row.serverSequence.toString(),
    deletedAt: row.deletedAt === null ? null : row.deletedAt.toISOString(),
  };
}
