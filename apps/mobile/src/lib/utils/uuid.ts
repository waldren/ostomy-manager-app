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

import * as Crypto from 'expo-crypto';

/**
 * Mints a new, canonical-lowercase-form UUID.
 *
 * The one function every entity-id and operation-id mint in this app goes
 * through (`docs/sync-contract.md` §1, §9.7: an operation id is minted
 * **once, at enqueue**, and an entity id is minted **once, at create**, and
 * neither is ever reused). Centralising the call site is what makes
 * "generate a fresh id" and "reuse an existing one" visibly different
 * operations in a review, rather than both being `randomUUID()` scattered
 * inline.
 */
export function generateUuid(): string {
  return Crypto.randomUUID();
}
