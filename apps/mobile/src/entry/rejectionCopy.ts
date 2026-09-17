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

import { hasPatientFacingCopy, isSyncReasonCode } from '@ostomy/core/sync';

/**
 * Which message the correction inbox shows for a rejection —
 * `docs/sync-contract.md` §6.4.
 *
 * Three rules, and the third is the one that is easy to get wrong:
 *
 * 1. A Tier 1 reason code is already a key in `packages/core`'s
 *    `validationErrors` catalog, so it renders as the same plain-language
 *    sentence the entry screen would have shown. No new strings.
 * 2. A non-validation code (`ENTITY_NOT_FOUND`, `UNSUPPORTED_CODE`, a
 *    protocol code this app quarantined, …) indicates a client or version
 *    problem rather than something the patient entered wrongly, and renders
 *    as ONE generic message.
 * 3. An **unrecognized** code renders as that same generic message. New
 *    codes are additive (§8), so an app built before a code existed must
 *    degrade rather than crash — and it must never render the raw
 *    identifier at someone.
 *
 * **The code itself is never shown.** §6.3: the codes are clinically
 * expressive with no value attached — `EFFECTIVE_DATE_TIME_BEFORE_SURGERY`
 * discloses that the subject has a surgery date — and §9.8 forbids
 * forwarding them off the device at all. Showing one on screen is not a
 * disclosure to a third party, but it is also not something a patient can
 * act on, and a screenshot of it in a support ticket is exactly the leak
 * §6.3 describes.
 */

/**
 * The `validationErrors` catalog key for a rejection, or `undefined` when the
 * generic message applies.
 *
 * Delegates the decision to `hasPatientFacingCopy` from
 * `@ostomy/core/sync` rather than re-listing the Tier 1 codes here. That
 * predicate is defined next to the code vocabulary it partitions, so a code
 * added to the contract cannot be silently missed by this client — which is
 * exactly what a local copy of the list would do.
 */
export function validationErrorKeyFor(reasonCode: string | null): string | undefined {
  if (reasonCode === null) return undefined;
  // Two guards, in this order, and both are load-bearing. The stored code is
  // a plain string: it may be a data-error reason code, a §6.1 protocol code
  // this app quarantined into the same column, or a code added to the
  // contract after this build shipped. `isSyncReasonCode` is the §8 degrade
  // — an unrecognized code is not an error, it is the generic message — and
  // only then can `hasPatientFacingCopy` narrow to the Tier 1 subset whose
  // codes are catalog keys.
  if (!isSyncReasonCode(reasonCode)) return undefined;
  return hasPatientFacingCopy(reasonCode) ? reasonCode : undefined;
}
