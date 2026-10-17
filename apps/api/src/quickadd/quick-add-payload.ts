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

import { createHash } from 'node:crypto';

import {
  QUICK_ADD_DECISION,
  SYNC_FIELD_PATH,
  quickAddPreferenceId,
  toEntityId,
  type QuickAddDecision as WireQuickAddDecision,
  type QuickAddPreferenceSyncPayload,
  type SyncFieldPath,
  SYNC_REASON_CODE,
} from '@ostomy/core/sync';
import {
  ESTIMATION_METHOD_CODE,
  MAX_REPRESENTABLE_VALUE_ML,
  MAX_VALUE_DECIMAL_PLACES,
  MEASURED_METHOD_CODE,
} from '@ostomy/core/validation';
import { z } from 'zod';

import {
  MeasurementSystem,
  QuickAddDecision,
  type QuickAddPreference,
} from '../generated/prisma/client';
import { payloadMalformed } from '../observations/observation-rejection';
import {
  FLUID_INTAKE_LOINC_CODE,
  STOMA_OUTPUT_LOINC_CODE,
  VOIDED_URINE_LOINC_CODE,
} from '../observations/observation-wire';

/**
 * A Quick-Add decision on the wire and at rest (P4.S3 slice 5,
 * `docs/sync-contract.md` §7.7). See `QuickAddPreference` in the Prisma schema
 * for what this entity is, and is not.
 */

/** The audit store's `entityType` for a decision — lowercase, its vocabulary rather than the wire's. */
export const QUICK_ADD_ENTITY_TYPE = 'quick_add_preference';

/** The only codes a Quick-Add widget is generated for (`apps/mobile/src/quickadd`). */
const QUICK_ADD_CODES: ReadonlySet<string> = new Set([
  STOMA_OUTPUT_LOINC_CODE,
  FLUID_INTAKE_LOINC_CODE,
  VOIDED_URINE_LOINC_CODE,
]);

/** An unbounded patient-supplied string reaching a column is refused, never truncated. */
const MAX_CODE_LENGTH = 64;

/**
 * Every key present, every value `unknown` until interpreted: a key outside
 * §7.7 is refused by name (`PAYLOAD_FIELD_UNRECOGNIZED`), the rest by the rules
 * below, one field at a time.
 */
export const quickAddRequestParseSchema = z.strictObject({
  id: z.uuid(),
  code: z.unknown().optional(),
  valueMl: z.unknown().optional(),
  method: z.unknown().optional(),
  fluidTypeCode: z.unknown().optional(),
  urineColorCode: z.unknown().optional(),
  enteredMeasurementSystem: z.unknown().optional(),
  decision: z.unknown().optional(),
});
export type QuickAddRequestParsed = z.infer<typeof quickAddRequestParseSchema>;

/** A decision as a push describes it, checked, in the database's spelling. */
export interface QuickAddWriteInput {
  readonly code: string;
  readonly valueMl: number | null;
  readonly method: string | null;
  readonly fluidTypeCode: string | null;
  readonly urineColorCode: string | null;
  readonly enteredMeasurementSystem: MeasurementSystem;
  readonly decision: QuickAddDecision;
}

const DECISION_BY_WIRE: Readonly<Record<WireQuickAddDecision, QuickAddDecision>> = {
  pinned: QuickAddDecision.PINNED,
  hidden: QuickAddDecision.HIDDEN,
  none: QuickAddDecision.NONE,
};

const WIRE_BY_DECISION: Readonly<Record<QuickAddDecision, WireQuickAddDecision>> = {
  [QuickAddDecision.PINNED]: 'pinned',
  [QuickAddDecision.HIDDEN]: 'hidden',
  [QuickAddDecision.NONE]: 'none',
};

const METHOD_CODES: ReadonlySet<string> = new Set(
  [MEASURED_METHOD_CODE, ESTIMATION_METHOD_CODE].flatMap((method) =>
    method.resolved ? [method.code] : [],
  ),
);

function invalid(field: SyncFieldPath): never {
  throw payloadMalformed({ field, reasonCode: SYNC_REASON_CODE.PAYLOAD_FIELD_INVALID });
}

function presentKey(parsed: QuickAddRequestParsed, key: keyof QuickAddRequestParsed): void {
  // Every field is required and nullable ones are sent as `null`, so an
  // absent key is a malformed payload rather than "unchanged" (§4: a full
  // replacement, never a patch).
  if (!(key in parsed)) invalid(SYNC_FIELD_PATH[FIELD_BY_KEY[key]]);
}

const FIELD_BY_KEY: Readonly<Record<keyof QuickAddRequestParsed, keyof typeof SYNC_FIELD_PATH>> = {
  id: 'ID',
  code: 'CODE',
  valueMl: 'VALUE_ML',
  method: 'METHOD',
  fluidTypeCode: 'FLUID_TYPE_CODE',
  urineColorCode: 'URINE_COLOR_CODE',
  enteredMeasurementSystem: 'ENTERED_MEASUREMENT_SYSTEM',
  decision: 'DECISION',
};

function optionalCode(raw: unknown, field: SyncFieldPath): string | null {
  if (raw === null) return null;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_CODE_LENGTH) invalid(field);
  return raw;
}

/**
 * The routine's shape, held to the rules the observations it names are held
 * to, so a decision can only ever name a widget that could exist:
 *
 * - one of the three Quick-Add codes;
 * - a positive volume the `DECIMAL(12,4)` column can hold, refused rather than
 *   rounded — or no volume, only for a colour-only urine routine (AC 12.1 AC2);
 * - Measured/Estimated with a volume and never without one;
 * - a colour only on urine, a fluid type only on intake.
 *
 * The migration's CHECK constraints say the same, so a write that skipped
 * this would fail rather than store a routine no entry could have.
 */
export function interpretQuickAddPayload(parsed: QuickAddRequestParsed): QuickAddWriteInput {
  for (const key of Object.keys(FIELD_BY_KEY) as (keyof QuickAddRequestParsed)[]) {
    presentKey(parsed, key);
  }

  const { code } = parsed;
  if (typeof code !== 'string' || !QUICK_ADD_CODES.has(code)) invalid(SYNC_FIELD_PATH.CODE);

  let valueMl: number | null = null;
  if (parsed.valueMl !== null) {
    const raw = parsed.valueMl;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
      invalid(SYNC_FIELD_PATH.VALUE_ML);
    }
    if (raw >= MAX_REPRESENTABLE_VALUE_ML) invalid(SYNC_FIELD_PATH.VALUE_ML);
    const scale = 10 ** MAX_VALUE_DECIMAL_PLACES;
    if (Math.round(raw * scale) / scale !== raw) invalid(SYNC_FIELD_PATH.VALUE_ML);
    valueMl = raw;
  }

  const method = optionalCode(parsed.method, SYNC_FIELD_PATH.METHOD);
  if (method !== null && !METHOD_CODES.has(method)) invalid(SYNC_FIELD_PATH.METHOD);
  const fluidTypeCode = optionalCode(parsed.fluidTypeCode, SYNC_FIELD_PATH.FLUID_TYPE_CODE);
  const urineColorCode = optionalCode(parsed.urineColorCode, SYNC_FIELD_PATH.URINE_COLOR_CODE);

  if (valueMl === null) {
    // Only a colour-only urine routine has no volume, and it has no toggle.
    if (code !== VOIDED_URINE_LOINC_CODE || urineColorCode === null) {
      invalid(SYNC_FIELD_PATH.VALUE_ML);
    }
    if (method !== null) invalid(SYNC_FIELD_PATH.METHOD);
  } else if (method === null) {
    invalid(SYNC_FIELD_PATH.METHOD);
  }
  if (urineColorCode !== null && code !== VOIDED_URINE_LOINC_CODE) {
    invalid(SYNC_FIELD_PATH.URINE_COLOR_CODE);
  }
  if (fluidTypeCode !== null && code !== FLUID_INTAKE_LOINC_CODE) {
    invalid(SYNC_FIELD_PATH.FLUID_TYPE_CODE);
  }

  const system = parsed.enteredMeasurementSystem;
  if (system !== 'metric' && system !== 'imperial') {
    invalid(SYNC_FIELD_PATH.ENTERED_MEASUREMENT_SYSTEM);
  }

  const { decision } = parsed;
  if (
    typeof decision !== 'string' ||
    !(QUICK_ADD_DECISION as readonly string[]).includes(decision)
  ) {
    invalid(SYNC_FIELD_PATH.DECISION);
  }

  return {
    code,
    valueMl,
    method,
    fluidTypeCode,
    urineColorCode,
    enteredMeasurementSystem:
      system === 'metric' ? MeasurementSystem.METRIC : MeasurementSystem.IMPERIAL,
    decision: DECISION_BY_WIRE[decision as WireQuickAddDecision],
  };
}

function wireSystem(system: MeasurementSystem): 'metric' | 'imperial' {
  return system === MeasurementSystem.METRIC ? 'metric' : 'imperial';
}

const sha1 = (input: Uint8Array): Uint8Array =>
  new Uint8Array(createHash('sha1').update(input).digest());

/**
 * The id a decision about this routine must have, for this patient (§7.7).
 * Anything else is refused: it is what makes two devices' decisions about one
 * widget the same row, and what keeps one patient's routine from naming
 * another's row.
 */
export function expectedQuickAddId(profileId: string, input: QuickAddWriteInput): Promise<string> {
  return quickAddPreferenceId(
    profileId,
    {
      code: input.code,
      valueMl: input.valueMl,
      method: input.method,
      fluidTypeCode: input.fluidTypeCode,
      urineColorCode: input.urineColorCode,
      enteredMeasurementSystem: wireSystem(input.enteredMeasurementSystem),
    },
    sha1,
  );
}

type QuickAddRow = Pick<
  QuickAddPreference,
  | 'id'
  | 'code'
  | 'valueMl'
  | 'method'
  | 'fluidTypeCode'
  | 'urineColorCode'
  | 'enteredMeasurementSystem'
  | 'decision'
>;

/** The delta payload (§7.7). Field by field, never a spread of the row. */
export function toQuickAddResource(row: QuickAddRow): QuickAddPreferenceSyncPayload {
  return {
    id: toEntityId(row.id),
    code: row.code,
    valueMl: row.valueMl === null ? null : row.valueMl.toNumber(),
    method: row.method,
    fluidTypeCode: row.fluidTypeCode,
    urineColorCode: row.urineColorCode,
    enteredMeasurementSystem: wireSystem(row.enteredMeasurementSystem),
    decision: WIRE_BY_DECISION[row.decision],
  };
}

/** The audit snapshot of a stored decision: every content field, and when the patient made it. */
export function toQuickAddAuditSnapshot(
  row: QuickAddRow & Pick<QuickAddPreference, 'clientUpdatedAt'>,
): Record<string, unknown> {
  return { ...toQuickAddResource(row), clientUpdatedAt: row.clientUpdatedAt.toISOString() };
}

/** The INCOMING version that lost a conflict (§4.1), from the checked input — never the raw payload. */
export function incomingQuickAddSnapshot(
  entityId: string,
  input: QuickAddWriteInput,
  clientTimestamp: Date,
): Record<string, unknown> {
  return {
    id: entityId,
    code: input.code,
    valueMl: input.valueMl,
    method: input.method,
    fluidTypeCode: input.fluidTypeCode,
    urineColorCode: input.urineColorCode,
    enteredMeasurementSystem: wireSystem(input.enteredMeasurementSystem),
    decision: WIRE_BY_DECISION[input.decision],
    clientUpdatedAt: clientTimestamp.toISOString(),
  };
}

/** The advisory-lock key for one decision row, namespaced so it cannot collide with another feature's. */
export function quickAddLockKey(id: string): string {
  return `quick_add_preference:${id}`;
}
