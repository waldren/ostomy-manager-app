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

import type { ServerSequence } from './identifiers.js';
import type { SyncOperationResult, SyncRejectedResult } from './push.js';

/**
 * Type-level proof that `appliedServerSequence` is present on `accepted`
 * and `superseded` results and **absent** on `rejected`
 * (`docs/sync-contract.md` §3.6), expressed as a discriminated union
 * rather than an optional property on all three.
 *
 * Why the distinction matters enough to have a proof: §3.6's rule is that
 * the value is a receipt, not a cursor, and "a client MUST NOT use it to
 * advance its delta cursor" (§9.4). An optional-everywhere field invites
 * `result.appliedServerSequence ?? cursor` — code that compiles, reads
 * naturally, and silently skips every row written between the client's
 * last delta pull and this batch. Requiring a narrow on `status` first
 * puts the reader in front of the three meanings before they can read the
 * value.
 *
 * This file has no runtime assertions and is never imported by anything —
 * the proof IS the compile errors suppressed below, checked by
 * `pnpm typecheck`.
 */

declare const result: SyncOperationResult;

// @ts-expect-error — not present on every arm of the union; narrow on `status` first.
void result.appliedServerSequence;

if (result.status === 'rejected') {
  // @ts-expect-error — a rejected result has no appliedServerSequence: nothing was applied, so there is no receipt (§3.6).
  void result.appliedServerSequence;
} else {
  // Present, and non-optional, on both of the other two arms — no
  // suppression and no `?? fallback` needed.
  const receipt: ServerSequence = result.appliedServerSequence;
  void receipt;
}

declare const operationId: SyncRejectedResult['operationId'];
declare const entityId: SyncRejectedResult['entityId'];
declare const someSequence: ServerSequence;

const rejectionWithReceipt: SyncRejectedResult = {
  operationId,
  entityId,
  status: 'rejected',
  reasonCode: 'ENTITY_NOT_FOUND',
  field: 'entityId',
  replayed: false,
  // @ts-expect-error — object literal may only specify known properties; a rejection cannot be written with a receipt either.
  appliedServerSequence: someSequence,
};
void rejectionWithReceipt;
