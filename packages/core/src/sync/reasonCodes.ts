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

import { TIER1_RULE_CODE } from '../validation/index.js';

/**
 * The §6.2 data-error vocabulary: the machine-readable reason a single
 * operation was rejected inside an otherwise-`200` push response.
 *
 * These are data errors only. §6.1's protocol errors — malformed JSON, a
 * descending `clientTimestamp` array, a `payload` on a delete, an
 * oversized batch — fail the whole request with a `4xx` and never appear
 * as a reason code. Conflating the two is how "a batch never fails as a
 * unit" turns into "a malformed batch silently half-applies".
 */

/**
 * The Tier 1 rule codes, **imported, not restated** (§6.2: "Returned
 * verbatim, not remapped"). A second copy in `src/sync` is exactly the
 * drift ADR-0006 and ADR-0007 exist to prevent: a code that differs by one
 * character between the validator and the wire means the client cannot
 * find the catalog entry for a rejection it just received.
 */
export type Tier1ReasonCode = (typeof TIER1_RULE_CODE)[keyof typeof TIER1_RULE_CODE];

/**
 * The §6.2 codes that are the sync protocol's own, with no Tier 1
 * analogue.
 *
 * Kept as a named subset rather than folded anonymously into
 * `SYNC_REASON_CODE`, because §6.4 draws a line exactly here: a Tier 1
 * code is already a key in `packages/core`'s `validationErrors` catalog
 * and renders as specific, correctable copy, whereas these five indicate a
 * client or version problem rather than something the patient entered
 * wrongly and are **not** rendered verbatim to a patient. `hasPatientFacingCopy`
 * below is how a client tells the two apart without hardcoding the list a
 * second time.
 */
export const SYNC_SPECIFIC_REASON_CODE = {
  /** §3.8 — `clientTimestamp` further into the future than the `sync_clock_skew_allowance_seconds` threshold allows. The threshold itself is admin-managed configuration and is deliberately not named in this package. */
  CLIENT_TIMESTAMP_OUT_OF_RANGE: 'CLIENT_TIMESTAMP_OUT_OF_RANGE',
  /** An update or delete naming an entity id that does not exist for this patient. */
  ENTITY_NOT_FOUND: 'ENTITY_NOT_FOUND',
  /** A create naming an entity id that already exists with different content — distinct from a replay, which is matched on operation id and never reaches validation (§3.7). */
  ENTITY_ID_CONFLICT: 'ENTITY_ID_CONFLICT',
  /** An observation `code` outside the value set the current release accepts. */
  UNSUPPORTED_CODE: 'UNSUPPORTED_CODE',
  /** An observation `status` outside the set the current release accepts (§7.2). The wire type is the full eight-member FHIR value set; what a release accepts is narrower and is server configuration, so this is a data error rather than a type-level exclusion. */
  UNSUPPORTED_STATUS: 'UNSUPPORTED_STATUS',
  /** A field not in §7. Rejected rather than ignored: silently dropping a field a newer client thought it was sending is a data-loss path with no signal on either side. */
  PAYLOAD_FIELD_UNRECOGNIZED: 'PAYLOAD_FIELD_UNRECOGNIZED',
} as const;

export type SyncSpecificReasonCode =
  (typeof SYNC_SPECIFIC_REASON_CODE)[keyof typeof SYNC_SPECIFIC_REASON_CODE];

/**
 * Every reason code §6.2 defines, in one frozen object in the style of
 * `TIER1_RULE_CODE`.
 *
 * Note what is **not** here and cannot be added without a review that
 * notices: any Tier 2 rule code. §6.2 is explicit that a soft warning is
 * not a rejection and never becomes one, and that there is no wire
 * representation of a Tier 2 outcome in a push response — "a field for it
 * is a field someone will eventually branch on". The compile-time proof
 * that this set and the Tier 2 set are disjoint is in
 * `push-result-cannot-express-tier2.type-test.ts`.
 */
export const SYNC_REASON_CODE = {
  ...TIER1_RULE_CODE,
  ...SYNC_SPECIFIC_REASON_CODE,
} as const;

export type SyncReasonCode = Tier1ReasonCode | SyncSpecificReasonCode;

const KNOWN_REASON_CODES: ReadonlySet<string> = new Set<string>(Object.values(SYNC_REASON_CODE));

const TIER1_REASON_CODES: ReadonlySet<string> = new Set<string>(Object.values(TIER1_RULE_CODE));

/**
 * The decode-boundary guard §8 and §6.4 require.
 *
 * `SyncReasonCode` is a **closed** union on purpose — a server
 * implementation must be structurally unable to put anything else in a
 * rejection, including the offending clinical value (§6.3). But new codes
 * are additive without a version bump, so a fielded client will one day
 * receive one it has never heard of. That client parses raw JSON, which is
 * `unknown`, and narrows through this guard; anything that fails it
 * degrades to the generic message rather than crashing or rendering a raw
 * identifier at someone.
 */
export function isSyncReasonCode(value: unknown): value is SyncReasonCode {
  return typeof value === 'string' && KNOWN_REASON_CODES.has(value);
}

/**
 * §6.4 — whether this code has an entry in `packages/core`'s
 * `validationErrors` catalog and may therefore be rendered as specific
 * copy, or whether the client must show its one generic "this entry could
 * not be saved — please check it" message and keep the code for
 * diagnostics.
 *
 * A guard rather than a lookup table, so a client cannot index the catalog
 * with a code that has no entry and render `undefined` at a patient.
 * `packages/core/src/i18n/catalog.spec.ts` already asserts the catalog's
 * keys equal `TIER1_RULE_CODE` exactly, which is what makes this narrowing
 * sound; `reasonCodes.spec.ts` re-checks it from this side.
 */
export function hasPatientFacingCopy(code: SyncReasonCode): code is Tier1ReasonCode {
  return TIER1_REASON_CODES.has(code);
}
