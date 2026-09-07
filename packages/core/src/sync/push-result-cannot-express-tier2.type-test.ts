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

import type { TIER2_RULE_CODE } from '../validation/index.js';

import type { SyncAcceptedResult, SyncOperationResult, SyncSupersededResult } from './push.js';
import type { SyncReasonCode } from './reasonCodes.js';

/**
 * Type-level proof that a push response has **no wire representation of a
 * Tier 2 outcome** (`docs/sync-contract.md` §6.2, SRS §3.8).
 *
 * "Tier 2 warnings never appear here. A soft warning is not a rejection
 * and never becomes one. An operation that trips the >2,000 mL threshold
 * is `accepted`; the warning was the client's job to show at entry time,
 * and a real 2,500 mL day is the data point the care team most needs.
 * There is no wire representation of a Tier 2 outcome in a push response,
 * deliberately — a field for it is a field someone will eventually branch
 * on."
 *
 * "Deliberately absent" is a fact about a document. These four assertions
 * make it a fact about the build, in three independent ways: no Tier 2
 * rule code can appear as a `reasonCode`, no fourth result status can
 * exist, and neither applied-result arm can grow a warnings field.
 *
 * This file has no runtime assertions and is never imported by anything —
 * the proof IS the compile errors suppressed below, checked by
 * `pnpm typecheck`.
 */

type Equals<TLeft, TRight> =
  (<TProbe>() => TProbe extends TLeft ? 1 : 2) extends <TProbe>() => TProbe extends TRight ? 1 : 2
    ? true
    : false;

type Expect<TAssertion extends true> = TAssertion;

type Tier2RuleCode = (typeof TIER2_RULE_CODE)[keyof typeof TIER2_RULE_CODE];

/**
 * 1. The sync reason-code set and the Tier 2 rule-code set are disjoint.
 *    Spreading `TIER2_RULE_CODE` into `SYNC_REASON_CODE` — the one-line
 *    change that would look like tidying up — makes this `Extract`
 *    non-`never` and fails the build.
 */
type _NoTier2CodeIsARejectionReason = Expect<Equals<Extract<SyncReasonCode, Tier2RuleCode>, never>>;

/**
 * 2. There are exactly three result statuses (§3.5). A fourth — `warned`,
 *    `accepted_with_warnings` — fails here.
 */
type _ExactlyThreeResultStatuses = Expect<
  Equals<SyncOperationResult['status'], 'accepted' | 'superseded' | 'rejected'>
>;

/**
 * 3. Neither applied arm has anywhere to hang a warning. (The rejected
 *    arm's key set is pinned by
 *    `rejected-result-carries-no-clinical-value.type-test.ts`, for the
 *    stronger §6.3 reason.)
 */
type _AcceptedResultKeys = Expect<
  Equals<
    keyof SyncAcceptedResult,
    'operationId' | 'entityId' | 'replayed' | 'status' | 'appliedServerSequence'
  >
>;
type _SupersededResultKeys = Expect<
  Equals<
    keyof SyncSupersededResult,
    'operationId' | 'entityId' | 'replayed' | 'status' | 'appliedServerSequence'
  >
>;

// @ts-expect-error — 'warned' is not a push result status; a Tier 2 outcome has no wire representation (§6.2).
const impossibleStatus: SyncOperationResult['status'] = 'warned';
void impossibleStatus;

// @ts-expect-error — a Tier 2 rule code is not a rejection reason: a soft warning never becomes a rejection (SRS §3.8).
const impossibleReasonCode: SyncReasonCode = 'VALUE_ABOVE_TYPICAL_RANGE';
void impossibleReasonCode;

export type {
  _NoTier2CodeIsARejectionReason,
  _ExactlyThreeResultStatuses,
  _AcceptedResultKeys,
  _SupersededResultKeys,
};
