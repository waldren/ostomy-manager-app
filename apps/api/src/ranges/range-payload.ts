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

import {
  RANGE_PROVENANCE,
  RANGE_STATUS,
  SYNC_FIELD_PATH,
  SYNC_REASON_CODE,
  toEntityId,
  type EffectiveRangeSyncPayload,
  type RangeProvenance as WireRangeProvenance,
  type RangeStatus as WireRangeStatus,
  type SyncFieldPath,
} from '@ostomy/core/sync';
import { MAX_REPRESENTABLE_VALUE_ML, MAX_VALUE_DECIMAL_PLACES } from '@ostomy/core/validation';
import { z } from 'zod';

import { RangeProvenance, RangeStatus, type EffectiveRange } from '../generated/prisma/client';
import { payloadMalformed } from '../observations/observation-rejection';

import { isSuggestableRangeType } from './range-selection';

/**
 * The `EffectiveRange` sync payload (P4.S3 slice 3, `docs/sync-contract.md`
 * §7.6): the wire spelling of a range row, and what a patient's push may do
 * to one.
 *
 * Unlike `Profile`, there is one write path for this entity, and it is this
 * one. P4.S2 slice 3 built `GET /api/v1/ranges` and deliberately no write,
 * so that confirming a suggestion would arrive here rather than as a REST call
 * that left the entity with two paths (#130).
 */

/** The audit store's `entityType` for a range row — lowercase, its vocabulary rather than the wire's. */
export const RANGE_ENTITY_TYPE = 'effective_range';

/**
 * Strict on KEYS, lenient on values, as the profile and meal schemas are: an
 * unknown key is `PAYLOAD_FIELD_UNRECOGNIZED`, while a known key with a bad
 * value is refused by name in `interpretRangePayload`.
 */
export const rangeRequestParseSchema = z.strictObject({
  id: z.uuid(),
  rangeType: z.unknown().optional(),
  lowValue: z.unknown().optional(),
  highValue: z.unknown().optional(),
  targetValue: z.unknown().optional(),
  unit: z.unknown().optional(),
  provenance: z.unknown().optional(),
  status: z.unknown().optional(),
  previousRangeId: z.unknown().optional(),
});
export type RangeRequestParsed = z.infer<typeof rangeRequestParseSchema>;

/** A range as a push describes it, shape-checked and in the database's spelling. */
export interface RangeWriteInput {
  readonly rangeType: string;
  readonly lowValue: number | null;
  readonly highValue: number | null;
  readonly targetValue: number | null;
  readonly unit: string;
  readonly provenance: RangeProvenance;
  readonly status: RangeStatus;
  readonly previousRangeId: string | null;
}

const PROVENANCE_BY_WIRE: Readonly<Record<WireRangeProvenance, RangeProvenance>> = {
  physician_set: RangeProvenance.PHYSICIAN_SET,
  patient_set: RangeProvenance.PATIENT_SET,
  patient_confirmed_suggestion: RangeProvenance.PATIENT_CONFIRMED_SUGGESTION,
  clinical_default: RangeProvenance.CLINICAL_DEFAULT,
};

const WIRE_BY_PROVENANCE: Readonly<Record<RangeProvenance, WireRangeProvenance>> = {
  [RangeProvenance.PHYSICIAN_SET]: 'physician_set',
  [RangeProvenance.PATIENT_SET]: 'patient_set',
  [RangeProvenance.PATIENT_CONFIRMED_SUGGESTION]: 'patient_confirmed_suggestion',
  [RangeProvenance.CLINICAL_DEFAULT]: 'clinical_default',
};

const STATUS_BY_WIRE: Readonly<Record<WireRangeStatus, RangeStatus>> = {
  proposed: RangeStatus.PROPOSED,
  active: RangeStatus.ACTIVE,
  superseded: RangeStatus.SUPERSEDED,
  dismissed: RangeStatus.DISMISSED,
};

const WIRE_BY_STATUS: Readonly<Record<RangeStatus, WireRangeStatus>> = {
  [RangeStatus.PROPOSED]: 'proposed',
  [RangeStatus.ACTIVE]: 'active',
  [RangeStatus.SUPERSEDED]: 'superseded',
  [RangeStatus.DISMISSED]: 'dismissed',
};

/**
 * The two provenances a patient's own action produces. A push may create a row
 * only with one of these, and may change the status only of a row that has one
 * (or of a `proposed` row awaiting them).
 */
export const PATIENT_PROVENANCES: ReadonlySet<RangeProvenance> = new Set([
  RangeProvenance.PATIENT_SET,
  RangeProvenance.PATIENT_CONFIRMED_SUGGESTION,
]);

function invalid(field: SyncFieldPath): never {
  throw payloadMalformed({ field, reasonCode: SYNC_REASON_CODE.PAYLOAD_FIELD_INVALID });
}

const uuid = z.uuid();

/**
 * A bound, or `null`. Refused rather than rounded when the `DECIMAL(12,4)`
 * column cannot hold it: rounding would store a threshold nobody chose, and an
 * unstorable value reaching the database is a 500, which §9 tells a client to
 * re-push forever.
 */
function bound(raw: unknown, field: SyncFieldPath): number | null {
  if (raw === null) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) invalid(field);
  if (Math.abs(raw) >= MAX_REPRESENTABLE_VALUE_ML) invalid(field);
  const scale = 10 ** MAX_VALUE_DECIMAL_PLACES;
  if (Math.round(raw * scale) / scale !== raw) invalid(field);
  return raw;
}

/** Shape only: every field present, of the right kind, refused by name. What a patient may DO with it is the service's question. */
export function interpretRangePayload(parsed: RangeRequestParsed): RangeWriteInput {
  const { rangeType, unit, provenance, status, previousRangeId } = parsed;
  if (typeof rangeType !== 'string' || rangeType.length === 0 || rangeType.length > 64) {
    invalid(SYNC_FIELD_PATH.RANGE_TYPE);
  }
  if (!('lowValue' in parsed)) invalid(SYNC_FIELD_PATH.LOW_VALUE);
  if (!('highValue' in parsed)) invalid(SYNC_FIELD_PATH.HIGH_VALUE);
  if (!('targetValue' in parsed)) invalid(SYNC_FIELD_PATH.TARGET_VALUE);
  const lowValue = bound(parsed.lowValue, SYNC_FIELD_PATH.LOW_VALUE);
  const highValue = bound(parsed.highValue, SYNC_FIELD_PATH.HIGH_VALUE);
  const targetValue = bound(parsed.targetValue, SYNC_FIELD_PATH.TARGET_VALUE);
  if (typeof unit !== 'string' || unit.length === 0 || unit.length > 16) {
    invalid(SYNC_FIELD_PATH.UNIT);
  }
  if (
    typeof provenance !== 'string' ||
    !(RANGE_PROVENANCE as readonly string[]).includes(provenance)
  ) {
    invalid(SYNC_FIELD_PATH.PROVENANCE);
  }
  if (typeof status !== 'string' || !(RANGE_STATUS as readonly string[]).includes(status)) {
    invalid(SYNC_FIELD_PATH.STATUS);
  }
  if (
    previousRangeId !== null &&
    (typeof previousRangeId !== 'string' || !uuid.safeParse(previousRangeId).success)
  ) {
    invalid(SYNC_FIELD_PATH.PREVIOUS_RANGE_ID);
  }

  return {
    rangeType,
    lowValue,
    highValue,
    targetValue,
    unit,
    provenance: PROVENANCE_BY_WIRE[provenance as WireRangeProvenance],
    status: STATUS_BY_WIRE[status as WireRangeStatus],
    previousRangeId: previousRangeId as string | null,
  };
}

/** What a range type means: its unit and the bounds a value of it may take (#102). */
export interface RangeTypeLimits {
  readonly unit: string;
  readonly minValue: number;
  readonly maxValue: number;
}

/**
 * The checks a NEW patient value must pass, against its type's limits row.
 * Returns the field to name in a rejection, or `null`.
 *
 * - **Safety types are never written.** `heart_rate_red_flag_bpm` is a safety
 *   response, not a preference, and is not patient-adjustable (CLAUDE.md). A
 *   patient row for it would sit in this table looking like a threshold, which
 *   is exactly the "adjustable red-flag bound" `SAFETY_RANGE_TYPES` exists to
 *   prevent.
 * - **A type with no limits row does not exist.** `effective_ranges` has no
 *   foreign key to the limits table, so this is the only thing standing
 *   between a typo'd type and a row nothing will ever read.
 * - **The unit is the type's unit**, and every bound sits inside its limits —
 *   the same rule the admin surface applies to a clinical default.
 * - **At least one bound, and not inverted** — the shape #97 made a database
 *   rule for the defaults.
 *
 * What is NOT checked: that a confirmed suggestion's bounds equal the default
 * the patient was shown. The default may change, or the post-operative window
 * may roll over, between the moment an offline patient confirms and the moment
 * the push lands, and refusing then would reject a decision made correctly.
 * Both patient provenances are the patient's own value, and only one of the two
 * can be active for a type at a time (§7.6), so the label decides nothing about
 * which value is in force.
 */
export function newPatientRangeViolation(
  input: RangeWriteInput,
  limits: RangeTypeLimits | undefined,
): SyncFieldPath | null {
  if (!isSuggestableRangeType(input.rangeType) || limits === undefined) {
    return SYNC_FIELD_PATH.RANGE_TYPE;
  }
  if (input.unit !== limits.unit) return SYNC_FIELD_PATH.UNIT;
  if (input.lowValue === null && input.highValue === null && input.targetValue === null) {
    return SYNC_FIELD_PATH.LOW_VALUE;
  }
  const outside = (value: number | null) =>
    value !== null && (value < limits.minValue || value > limits.maxValue);
  if (outside(input.lowValue)) return SYNC_FIELD_PATH.LOW_VALUE;
  if (outside(input.highValue)) return SYNC_FIELD_PATH.HIGH_VALUE;
  if (outside(input.targetValue)) return SYNC_FIELD_PATH.TARGET_VALUE;
  if (input.lowValue !== null && input.highValue !== null && input.lowValue > input.highValue) {
    return SYNC_FIELD_PATH.HIGH_VALUE;
  }
  return null;
}

type RangeRow = Pick<
  EffectiveRange,
  | 'id'
  | 'rangeType'
  | 'lowValue'
  | 'highValue'
  | 'targetValue'
  | 'unit'
  | 'provenance'
  | 'status'
  | 'previousRangeId'
>;

function toNumberOrNull(value: { toNumber(): number } | null): number | null {
  return value === null ? null : value.toNumber();
}

/** The delta payload (§7.6). Field by field, never a spread of the row. */
export function toRangeResource(row: RangeRow): EffectiveRangeSyncPayload {
  return {
    id: toEntityId(row.id),
    rangeType: row.rangeType,
    lowValue: toNumberOrNull(row.lowValue),
    highValue: toNumberOrNull(row.highValue),
    targetValue: toNumberOrNull(row.targetValue),
    unit: row.unit,
    provenance: WIRE_BY_PROVENANCE[row.provenance],
    status: WIRE_BY_STATUS[row.status],
    previousRangeId: row.previousRangeId === null ? null : toEntityId(row.previousRangeId),
  };
}

/** The audit snapshot of a stored range — every content field, so a threshold's history can be read from the audit store alone. */
export function toRangeAuditSnapshot(
  row: RangeRow & Pick<EffectiveRange, 'clientUpdatedAt'>,
): Record<string, unknown> {
  return {
    ...toRangeResource(row),
    clientUpdatedAt: row.clientUpdatedAt.toISOString(),
  };
}

/** The INCOMING version that lost a conflict (§4.1), from the shape-checked input — never the raw payload. */
export function incomingRangeSnapshot(
  entityId: string,
  input: RangeWriteInput,
  clientTimestamp: Date,
): Record<string, unknown> {
  return {
    id: entityId,
    rangeType: input.rangeType,
    lowValue: input.lowValue,
    highValue: input.highValue,
    targetValue: input.targetValue,
    unit: input.unit,
    provenance: WIRE_BY_PROVENANCE[input.provenance],
    status: WIRE_BY_STATUS[input.status],
    previousRangeId: input.previousRangeId,
    clientUpdatedAt: clientTimestamp.toISOString(),
  };
}

/**
 * The status changes a patient may make to an existing row. Anything else —
 * reviving a superseded value, un-dismissing a suggestion — is refused: a
 * patient who wants that value again creates it again, as a new row with a
 * new decision time, rather than rewriting which decision was in force when.
 */
const ALLOWED_STATUS_CHANGES: Readonly<Record<RangeStatus, readonly RangeStatus[]>> = {
  [RangeStatus.PROPOSED]: [RangeStatus.PROPOSED, RangeStatus.ACTIVE, RangeStatus.DISMISSED],
  [RangeStatus.ACTIVE]: [RangeStatus.ACTIVE, RangeStatus.SUPERSEDED],
  [RangeStatus.SUPERSEDED]: [RangeStatus.SUPERSEDED],
  [RangeStatus.DISMISSED]: [RangeStatus.DISMISSED],
};

/**
 * Whether a push may write `input` over the stored row, and if not, which
 * field to name. Only the status may change (§7.6), and only along
 * `ALLOWED_STATUS_CHANGES`.
 *
 * A `physician_set` or `clinical_default` row is never the patient's to
 * change, whatever the push says (AC 14.1 AC4). The field named is
 * `provenance`, the one that makes the row not theirs.
 */
export function statusChangeViolation(
  stored: RangeRow,
  input: RangeWriteInput,
): { reasonCode: typeof SYNC_REASON_CODE.PAYLOAD_FIELD_INVALID; field: SyncFieldPath } | null {
  const refuse = (field: SyncFieldPath) => ({
    reasonCode: SYNC_REASON_CODE.PAYLOAD_FIELD_INVALID,
    field,
  });
  if (!PATIENT_PROVENANCES.has(stored.provenance)) return refuse(SYNC_FIELD_PATH.PROVENANCE);
  if (input.provenance !== stored.provenance) return refuse(SYNC_FIELD_PATH.PROVENANCE);
  if (input.rangeType !== stored.rangeType) return refuse(SYNC_FIELD_PATH.RANGE_TYPE);
  if (input.unit !== stored.unit) return refuse(SYNC_FIELD_PATH.UNIT);
  if (input.lowValue !== toNumberOrNull(stored.lowValue)) return refuse(SYNC_FIELD_PATH.LOW_VALUE);
  if (input.highValue !== toNumberOrNull(stored.highValue)) {
    return refuse(SYNC_FIELD_PATH.HIGH_VALUE);
  }
  if (input.targetValue !== toNumberOrNull(stored.targetValue)) {
    return refuse(SYNC_FIELD_PATH.TARGET_VALUE);
  }
  if (input.previousRangeId !== stored.previousRangeId) {
    return refuse(SYNC_FIELD_PATH.PREVIOUS_RANGE_ID);
  }
  if (!ALLOWED_STATUS_CHANGES[stored.status].includes(input.status)) {
    return refuse(SYNC_FIELD_PATH.STATUS);
  }
  return null;
}
