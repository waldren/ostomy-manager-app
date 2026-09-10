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

import type { SyncFieldPath } from './fieldPaths.js';
import type { SyncRejectedResult } from './push.js';
import type { SyncReasonCode } from './reasonCodes.js';

/**
 * Type-level proof that a `rejected` push result has no field in which a
 * clinical value could be serialized (`docs/sync-contract.md` §6.3, ADR-0001
 * "Compliance and safety review", `docs/security-hipaa.md`).
 *
 * Rejection responses are persisted by the client in its correction queue
 * and appear in client-side diagnostics, so a value echoed here is PHI in
 * a log. `packages/core`'s `ValidationError` already makes this true for
 * Tier 1 by having no field a value could occupy; this file makes the same
 * fact checkable for the sync result type.
 *
 * This file has no runtime assertions and is never imported by anything —
 * the proof IS the compile errors suppressed below, checked by
 * `pnpm typecheck` (excluded from the built `dist/` output by
 * tsconfig.build.json, since there is nothing to run).
 */

type Equals<TLeft, TRight> =
  (<TProbe>() => TProbe extends TLeft ? 1 : 2) extends <TProbe>() => TProbe extends TRight ? 1 : 2
    ? true
    : false;

type Expect<TAssertion extends true> = TAssertion;

/**
 * The load-bearing assertion. Adding ANY property to `SyncRejectedResult`
 * — `value`, `valueQuantity`, `receivedPayload`, `detail`, `message`, or a
 * well-meant `offendingValue` — makes `Equals` resolve to `false` and
 * `Expect<false>` fail with "Type 'false' does not satisfy the constraint
 * 'true'". Removing one fails the same way. That is stronger than checking
 * for the absence of a list of names someone would have to keep current.
 */
type RejectedResultKeys = keyof SyncRejectedResult;

type _RejectedResultCarriesExactlyTheseKeys = Expect<
  Equals<
    RejectedResultKeys,
    'operationId' | 'entityId' | 'replayed' | 'status' | 'reasonCode' | 'field'
  >
>;

/**
 * And every one of those six is a code, a flag, or an identifier. If
 * `reasonCode` or `field` were ever widened to a bare `string`, a value
 * would fit in it — an implementation could write the offending amount
 * into the field path and typecheck. These two assertions fail the moment
 * either union stops being closed.
 */
type _ReasonCodeIsAClosedCodeSet = Expect<Equals<SyncRejectedResult['reasonCode'], SyncReasonCode>>;
type _FieldIsAClosedPathSet = Expect<Equals<SyncRejectedResult['field'], SyncFieldPath>>;

// @ts-expect-error — `reasonCode` is a closed set of codes; an arbitrary string (here, one carrying a value) is not assignable.
const reasonCodeCannotCarryAValue: SyncRejectedResult['reasonCode'] = 'VALUE_NOT_POSITIVE: -350';
void reasonCodeCannotCarryAValue;

// @ts-expect-error — `field` is a closed set of wire paths; an interpolated value is not one of them.
const fieldCannotCarryAValue: SyncRejectedResult['field'] = 'valueQuantity.value (2500)';
void fieldCannotCarryAValue;

declare const operationId: SyncRejectedResult['operationId'];
declare const entityId: SyncRejectedResult['entityId'];

const withClinicalValue: SyncRejectedResult = {
  operationId,
  entityId,
  status: 'rejected',
  reasonCode: 'VALUE_NOT_POSITIVE',
  field: 'valueQuantity.value',
  replayed: false,
  // Synthetic value, as every fixture in this repo is. It is here to be
  // rejected by the compiler, not to be transmitted.
  // @ts-expect-error — object literal may only specify known properties; there is no property a clinical value could go in.
  valueQuantity: { value: 2500, unit: 'mL' },
};
void withClinicalValue;

// The legitimate shape typechecks with no suppression needed.
const rejection: SyncRejectedResult = {
  operationId,
  entityId,
  status: 'rejected',
  reasonCode: 'VALUE_NOT_POSITIVE',
  field: 'valueQuantity.value',
  replayed: false,
};
void rejection;

export type {
  _RejectedResultCarriesExactlyTheseKeys,
  _ReasonCodeIsAClosedCodeSet,
  _FieldIsAClosedPathSet,
};
