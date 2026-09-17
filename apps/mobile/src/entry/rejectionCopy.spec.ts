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

import { en } from '@ostomy/core/i18n';

import { validationErrorKeyFor } from './rejectionCopy';

/**
 * `docs/sync-contract.md` §6.4 — which message the correction inbox shows.
 * `undefined` means "the one generic message"; a string is a
 * `validationErrors` catalog key.
 */
describe('validationErrorKeyFor', () => {
  it('resolves a Tier 1 reason code to its catalog key', () => {
    expect(validationErrorKeyFor('VALUE_NOT_POSITIVE')).toBe('VALUE_NOT_POSITIVE');
  });

  /**
   * Every key this function can return must actually exist in the catalog,
   * or the inbox renders `undefined` at a patient. Asserted over the whole
   * Tier 1 set rather than the one code above, so a code added to the
   * contract without catalog copy fails here.
   */
  it('returns only keys the validationErrors catalog actually has', () => {
    const tier1Codes = Object.keys(en.validationErrors);

    for (const code of tier1Codes) {
      const key = validationErrorKeyFor(code);
      expect(key).toBe(code);
      expect(en.validationErrors[key as keyof typeof en.validationErrors]).toBeDefined();
    }
  });

  /** §6.4: a non-validation code indicates a client or version problem, not something the patient entered wrongly. */
  it('falls back to the generic message for a non-validation reason code', () => {
    expect(validationErrorKeyFor('ENTITY_NOT_FOUND')).toBeUndefined();
    expect(validationErrorKeyFor('UNSUPPORTED_CODE')).toBeUndefined();
    expect(validationErrorKeyFor('PAYLOAD_FIELD_UNRECOGNIZED')).toBeUndefined();
  });

  /**
   * §8 makes new reason codes additive, and §6.4 requires an old app to
   * degrade rather than crash or render a raw identifier at someone.
   */
  it('falls back to the generic message for a code added after this build shipped', () => {
    expect(validationErrorKeyFor('SOME_CODE_FROM_A_LATER_RELEASE')).toBeUndefined();
  });

  /**
   * The sync worker stores a quarantined §6.1 protocol code in the same
   * column as a data-error reason code. Those are deliberately disjoint
   * vocabularies, and a protocol code has no patient-facing copy by
   * construction — so it must land in the generic bucket without the inbox
   * needing to know which vocabulary it came from.
   */
  it('falls back to the generic message for a quarantined protocol code', () => {
    expect(validationErrorKeyFor('ENTITY_ID_MISMATCH')).toBeUndefined();
    expect(validationErrorKeyFor('BATCH_OUT_OF_ORDER')).toBeUndefined();
    expect(validationErrorKeyFor('REJECTED_WITHOUT_REASON_CODE')).toBeUndefined();
  });

  it('falls back to the generic message when no code was recorded at all', () => {
    expect(validationErrorKeyFor(null)).toBeUndefined();
  });
});
