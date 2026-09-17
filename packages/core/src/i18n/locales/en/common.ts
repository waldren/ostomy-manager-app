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

/**
 * "common" namespace: copy shared across screens that is neither a
 * validation error, a validation warning, nor the heart-rate red-flag
 * prompt. See ../../index.ts for why those are kept in separate
 * namespaces.
 *
 * Unit wording is deliberately NOT duplicated here (S2, this sprint's
 * review): `../../format.ts`'s `formatVolumeQuantity` /
 * `formatWeightQuantity` source unit wording from
 * `Intl.NumberFormat`'s `style: 'unit'`, which is locale-aware and
 * CLDR-correct. A hand-written `unit.mL: 'milliliters (mL)'` string here
 * would be a second, unreferenced source of truth for the same wording —
 * the exact divergence ADR-0006 exists to prevent — so it was removed
 * rather than kept unused.
 */
export const common = {
  'method.measured': 'Measured',
  'method.estimated': 'Estimated',

  // Entry-form copy. Clinical meaning, so `common` rather than `mobile`:
  // the web client will eventually ask the same questions, and the two
  // must not drift into wording them differently.
  //
  // Reading level is the binding constraint here (CLAUDE.md: 6th-8th
  // grade, a population skewing older and post-surgical). "Output volume"
  // and "measurement method" are the clinical terms and are avoided;
  // "came out" is what a patient would say.
  'entry.stomaOutputHeading': 'Add a stoma entry',
  'entry.stomaOutputAmountLabel': 'How much came out?',
  // Names the toggle's stakes without lecturing. A patient who does not
  // know an exact number must still feel able to enter one.
  'entry.stomaOutputAmountHint':
    'A close guess is fine. You will say next whether you measured it.',
  'entry.methodLabel': 'Did you measure this amount, or estimate it?',
  'entry.methodMeasuredHint': 'You poured it into a measuring container.',
  'entry.methodEstimatedHint': 'You judged the amount by eye.',
  'entry.whenLabel': 'When was this?',
  'entry.whenHint': 'Set to now. Change it if you are adding this later.',
  'entry.whenChangeButton': 'Change the date and time',
  'entry.whenUseNowButton': 'Use right now',
  'entry.saveButton': 'Save entry',
  // §9.5: the LOCAL write is the confirmation, and this string is what the
  // patient sees the moment it commits. It deliberately does not mention
  // sending, uploading or the care team — none of that has happened yet,
  // and a confirmation that implies it would be the false reassurance
  // `login.signedOutBody` was already corrected for.
  'entry.savedConfirmation': 'Saved on this phone.',
  'entry.saveFailedBody': 'We could not save this entry on your phone. Please try again.',

  // Tier 2 (AC 13.2 AC1): a confirmation, never a block. The wording asks
  // rather than warns, and the confirm button is an ordinary action —
  // saving must be no harder than it would have been without the warning.
  'entry.warningHeading': 'Does this look right?',
  'entry.warningConfirmButton': 'Yes, save it',
  'entry.warningEditButton': 'Let me change it',

  // D4. The toggle is mandatory and both options are offered, but an
  // Estimated entry cannot be stored yet — see ESTIMATION_METHOD_CODE.
  // Says what the patient can do now rather than describing our problem.
  'entry.estimatedUnavailableBody':
    'We cannot save estimated amounts yet. If you can, measure the amount and choose Measured.',

  // Correction inbox (AC 13.1 AC4). "Could not be saved" is accurate from
  // the patient's point of view: the entry is on their phone, but it has
  // not been accepted.
  'corrections.heading': 'Entries that need your attention',
  'corrections.empty': 'Nothing needs fixing.',
  'corrections.intro':
    'These entries are still on your phone. Something about them needs a change before they can be sent.',
  // docs/sync-contract.md §6.4: a code with no patient-facing copy — and
  // any code this app does not recognise — degrades to ONE generic
  // message. The raw code is never shown: the codes are clinically
  // expressive on their own (§6.3).
  'corrections.genericProblem': 'This entry could not be saved. Please check it.',
  'corrections.fixButton': 'Fix this entry',
  'corrections.deleteButton': 'Delete this entry',
  'corrections.savedAt': 'You added this on {{when}}.',
} as const;
