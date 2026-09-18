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

import { SYNC_REASON_CODE } from '@ostomy/core/sync';
import { isResolvableTimeZone, toLocalDate } from '@ostomy/core/units';

import {
  payloadMalformed,
  type ObservationRejectionDetail,
} from '../observations/observation-rejection';
import type { Meal } from '../generated/prisma/client';

import {
  MEAL_DESCRIPTION_MAX_LENGTH,
  MEAL_FIELD,
  MEAL_SIZES,
  MEAL_TAG_CODES_MAX,
  MEAL_TAG_CODE_MAX_LENGTH,
  type MealRequestParsed,
  type MealResource,
} from './meal-wire';

/**
 * Release-scope acceptance for a `Meal` payload (§7.4, SRS AC 2.4).
 *
 * Mirrors `observations/observation-payload.ts`: one field, one code, no
 * value, and the first failing check throws. The order below follows §6.2's
 * own listing so two implementations of this contract walk a patient through
 * the same correction sequence for the same payload.
 *
 * **No Tier 1 value rules apply here, and two Tier 1 timestamp rules do.** A
 * meal has no volume, no unit and no Measured/Estimated toggle, so
 * `evaluateTier1` is the wrong function — but a meal still cannot have been
 * eaten tomorrow, and it cannot predate the surgery that created the stoma.
 * Those two live in `@ostomy/core/validation`'s `evaluateEntryTimestamp`,
 * which `evaluateTier1` also composes, so a meal and a volumetric entry
 * cannot disagree about what "in the future" means. The caller applies them —
 * they need the patient's surgery date and the admin-managed clock-skew
 * threshold, neither of which belongs in a pure payload interpreter.
 */

export type MealSize = (typeof MEAL_SIZES)[number];

export interface MealWriteInput {
  readonly id: string;
  readonly description: string | null;
  readonly size: MealSize;
  readonly tagCodes: readonly string[];
  readonly effectiveDateTime: Date;
  /** IANA zone the device asserted (ADR-0016). */
  readonly enteredTimezone: string;
  /** `YYYY-MM-DD`, derived server-side from the instant and the zone. Not monotonic with `effectiveDateTime`. */
  readonly localDate: string;
}

/**
 * Reuses the observations module's rejection type deliberately — the shared
 * vocabulary is the point (`observation-rejection.ts` rule 2): the direct and
 * sync surfaces, and now both entity types, must not invent two ways to say
 * "this value is outside its domain". The name is historical; the shape is
 * the contract's.
 */
function malformed(detail: ObservationRejectionDetail): never {
  throw payloadMalformed(detail);
}

export function interpretMealPayload(parsed: MealRequestParsed): MealWriteInput {
  const description = interpretDescription(parsed.description);
  const size = interpretSize(parsed.size);
  const tagCodes = interpretTagCodes(parsed.tagCodes);

  // Only that the identifier resolves — never which zone it "should" be.
  // Second-guessing it would reject correct entries from a travelling
  // patient, which is the case the field exists for (ADR-0016).
  if (!isResolvableTimeZone(parsed.enteredTimezone)) {
    malformed({
      field: MEAL_FIELD.ENTERED_TIMEZONE,
      reasonCode: SYNC_REASON_CODE.PAYLOAD_FIELD_INVALID,
    });
  }

  // Safe to construct: the zod layer already pinned the lexical form to
  // RFC 3339 with exactly three fractional digits and a `Z` offset (§7.3).
  const effectiveDateTime = new Date(parsed.effectiveDateTime);

  return {
    id: parsed.id,
    description,
    size,
    tagCodes,
    effectiveDateTime,
    enteredTimezone: parsed.enteredTimezone,
    // DERIVED here, never taken from the client — a pure function of two
    // fields already on the wire, so a client-supplied one would be a second
    // source of truth whose disagreement nothing detects (§7.4, ADR-0016).
    localDate: toLocalDate(effectiveDateTime, parsed.enteredTimezone),
  };
}

/**
 * AC 2.4 AC1's free text. Optional — a patient who only tapped quick-tags has
 * still logged a meal — so absent and `null` both mean "none given".
 *
 * An over-long description is refused rather than truncated. Silently cutting
 * a patient's own words is a data-loss path with no signal on either side,
 * and the patient is the one person who could have shortened it themselves.
 */
function interpretDescription(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' || raw.length > MEAL_DESCRIPTION_MAX_LENGTH) {
    malformed({
      field: MEAL_FIELD.DESCRIPTION,
      reasonCode: SYNC_REASON_CODE.PAYLOAD_FIELD_INVALID,
    });
  }
  // An empty string is normalised to null: "" and "no description" are the
  // same fact, and keeping two representations of it means every reader has
  // to handle both.
  return raw.length === 0 ? null : raw;
}

/**
 * AC 2.4 AC2's mandatory selection.
 *
 * An **absent** size is the "no selection made" case, and it is refused for
 * the Measured/Estimated toggle's reason: `size` is the only stored
 * representation of the choice, so defaulting it would be indistinguishable
 * afterwards from a deliberate answer.
 */
function interpretSize(raw: unknown): MealSize {
  if (typeof raw !== 'string' || !(MEAL_SIZES as readonly string[]).includes(raw)) {
    malformed({ field: MEAL_FIELD.SIZE, reasonCode: SYNC_REASON_CODE.PAYLOAD_FIELD_INVALID });
  }
  return raw as MealSize;
}

/**
 * AC 2.4 AC1's optional quick-tags.
 *
 * Absent is normalised to `[]` — §7.4 requires the key to be present on the
 * wire, but a client that omits it has unambiguously chosen no tags, and
 * refusing that would be a shape rule dressed as a content one.
 *
 * **Membership in the `meal_tag` value set is deliberately not checked**, for
 * the same reason `fluidTypeCode`'s is not (P3.S1 PR B): members are
 * admin-managed and retired-never-deleted, so validating against the live set
 * would refuse a patient's entry the moment an admin retired a tag a fielded
 * app still offers — a rejection they cannot act on, over a configuration
 * change they cannot see. An unknown tag renders as a generic label and is
 * recoverable; a refused meal is not.
 *
 * Duplicates are collapsed. A tag list is a set in meaning, and `['dairy',
 * 'dairy']` would otherwise make a containment query count one meal twice.
 */
function interpretTagCodes(raw: unknown): readonly string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MEAL_TAG_CODES_MAX) {
    malformed({ field: MEAL_FIELD.TAG_CODES, reasonCode: SYNC_REASON_CODE.PAYLOAD_FIELD_INVALID });
  }

  const codes: string[] = [];
  for (const code of raw) {
    if (typeof code !== 'string' || code.length === 0 || code.length > MEAL_TAG_CODE_MAX_LENGTH) {
      malformed({
        field: MEAL_FIELD.TAG_CODES,
        reasonCode: SYNC_REASON_CODE.PAYLOAD_FIELD_INVALID,
      });
    }
    if (!codes.includes(code)) codes.push(code);
  }
  return codes;
}

/**
 * Projects a stored row onto the wire, field by field.
 *
 * **Never a spread.** TypeScript's excess-property check does not apply to
 * spread properties, so `{ ...row }` typechecks and ships `patientId`,
 * `serverSequence`, `deletedAt` and `localDate` — the first of which §2
 * forbids outright.
 */
export function toMealResource(row: Meal): MealResource {
  return {
    id: row.id,
    description: row.description,
    size: toWireSize(row.size),
    tagCodes: row.tagCodes,
    // `toISOString()` is RFC 3339, UTC, exactly three fractional digits —
    // the lexical form §7.3 pins.
    effectiveDateTime: row.effectiveDatetime.toISOString(),
    enteredTimezone: row.enteredTimezone,
    // `localDate` is deliberately absent: server-derived, not a wire field.
  };
}

const SIZE_TO_WIRE: Readonly<Record<Meal['size'], MealSize>> = {
  SMALL: 'small',
  MEDIUM: 'medium',
  LARGE: 'large',
};

export function toWireSize(size: Meal['size']): MealSize {
  return SIZE_TO_WIRE[size];
}

const SIZE_TO_STORED: Readonly<Record<MealSize, Meal['size']>> = {
  small: 'SMALL',
  medium: 'MEDIUM',
  large: 'LARGE',
};

export function toStoredSize(size: MealSize): Meal['size'] {
  return SIZE_TO_STORED[size];
}

/**
 * The audit snapshot for a meal — §4.1's before/after values.
 *
 * Every column, including the ones the wire never carries. That is the point:
 * §4.1 requires a delete to audit "the entity's full pre-deletion state", and
 * once the purge policy in §10 runs, the audit row is the only surviving copy
 * of what was deleted. A snapshot trimmed to the wire shape would silently
 * lose `localDate` and the server bookkeeping that makes a row reconstructible.
 *
 * Named field by field, never `{ ...row }` — the same rule the wire projection
 * follows, for a different reason here: a spread would carry whatever future
 * columns are added, which is fine for an audit row but means nobody ever
 * decides whether a new column belongs in one.
 */
export function toMealAuditSnapshot(row: Meal): Record<string, unknown> {
  return {
    id: row.id,
    patientId: row.patientId,
    description: row.description,
    size: row.size,
    tagCodes: row.tagCodes,
    effectiveDatetime: row.effectiveDatetime.toISOString(),
    enteredTimezone: row.enteredTimezone,
    localDate: row.localDate.toISOString(),
    clientUpdatedAt: row.clientUpdatedAt.toISOString(),
    serverSequence: row.serverSequence.toString(),
    deletedAt: row.deletedAt === null ? null : row.deletedAt.toISOString(),
  };
}
