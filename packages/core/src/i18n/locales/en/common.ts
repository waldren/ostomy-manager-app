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
  // --- Fluid intake (P3.S1, SRS AC 2.3) ---------------------------------
  'entry.intakeHeading': 'Add a drink',
  'entry.intakeAmountLabel': 'How much did you drink?',
  'entry.intakeAmountHint': 'Tap a size below, or type the amount.',
  // AC 2.3 AC2. The buttons themselves are labelled with the amount, which is
  // a VALUE interpolated by Intl rather than a catalog string — a catalog key
  // cannot carry a number (ADR-0006), and "250 mL" localises properly while
  // "glass_250" would need one key per size forever.
  'entry.intakeQuickAddLabel': 'Common sizes',
  // AC 2.3 AC1. "Optional" is said out loud: a categorised list next to a
  // required amount reads as required unless it says otherwise, and a patient
  // who does not know what to pick should not be stopped.
  'entry.fluidTypeLabel': 'What did you drink? (optional)',
  'entry.fluidTypeNone': 'Rather not say',

  // Fluid-type labels, keyed by the value set's stable member codes. A code
  // with no entry here renders via `entry.unknownOptionLabel` rather than the
  // raw code — a member an admin added after this release shipped is a real
  // case, and showing `oral_rehydration_solution` at a patient is not.
  'fluidType.water': 'Water',
  'fluidType.oral_rehydration_solution': 'Rehydration drink',
  'fluidType.coffee_or_tea': 'Coffee or tea',
  'fluidType.juice': 'Juice',
  'fluidType.milk': 'Milk',
  'fluidType.soup_or_broth': 'Soup or broth',
  'fluidType.other': 'Something else',

  // --- Voided urine (P3.S2, SRS §3.7, AC 12.1) --------------------------
  'entry.urineHeading': 'Add a urine entry',
  // AC 12.1 AC2 is the whole feature: a patient who cannot measure must
  // still be able to record something. The label says the amount is optional
  // BEFORE the field rather than after a rejected save, so nobody abandons
  // the entry believing they cannot make one.
  'entry.urineAmountLabel': 'How much did you pass? (optional)',
  'entry.urineAmountHint':
    'Leave this blank if you did not measure it. You can pick a colour instead.',
  // AC 12.1 AC3. "Optional" again, for the same reason — with the amount
  // also optional, a patient must be able to see that ONE of the two is
  // enough, which the hint below says outright.
  'entry.urineColorLabel': 'What colour was it? (optional)',
  'entry.urineColorHint':
    'Pick the closest match. Colour on its own is a useful entry, even with no amount.',
  // The pale-to-dark urine colour scale (AC 12.1 AC3). Each step is named in
  // words, because the swatch beside it is decorative and hidden from
  // assistive technology — the words ARE the scale, and a screen-reader user
  // gets exactly the distinctions a sighted one does.
  'urineColor.pale_straw': 'Almost clear',
  'urineColor.straw': 'Pale yellow',
  'urineColor.yellow': 'Yellow',
  'urineColor.dark_yellow': 'Dark yellow',
  'urineColor.amber': 'Amber',
  'urineColor.brown': 'Brown or darker',
  // Shown in place of Save until the entry records something. States the
  // condition rather than scolding: an entry with neither an amount nor a
  // colour records nothing at all, and the server refuses it.
  'entry.urineNothingToSave': 'Add an amount or pick a colour, and this entry can be saved.',

  // --- Meals (P3.S1, SRS AC 2.4) ----------------------------------------
  'entry.mealHeading': 'Add a meal',
  'entry.mealDescriptionLabel': 'What did you eat? (optional)',
  'entry.mealDescriptionHint': 'A few words is plenty. You can also just pick tags below.',
  // AC 2.4 AC2. A relative judgement, not a quantity — this app never asks a
  // patient to weigh food, and the labels say so by being comparative.
  'entry.mealSizeLabel': 'How big was it?',
  // Its OWN message, not METHOD_REQUIRED's. That one reads "Tell us if you
  // measured this amount or estimated it" — correct for a volumetric entry and
  // nonsense beside a meal, which has no amount. Reusing it would have put a
  // sentence about measuring in front of someone logging a sandwich.
  'entry.mealSizeRequired': 'Choose how big the meal was.',
  'mealSize.small': 'Small or a snack',
  'mealSize.medium': 'A normal meal',
  'mealSize.large': 'Large or heavy',
  'entry.mealTagsLabel': 'Anything in it worth noting? (optional)',
  'entry.mealTagsHint': 'Tap any that apply. These help you and your care team spot patterns.',
  'entry.mealSaveButton': 'Save meal',

  // Meal-tag labels, keyed by stable member code. Same fallback rule as the
  // fluid types above.
  'mealTag.high_fibre': 'High fibre',
  'mealTag.dairy': 'Dairy',
  'mealTag.high_sugar': 'High sugar',
  'mealTag.spicy': 'Spicy',
  'mealTag.high_fat': 'High fat',
  'mealTag.alcohol': 'Alcohol',

  // Shown in place of a value-set member this release has no label for.
  // Members are admin-managed and can be added after an app ships, so this is
  // a reachable state rather than a defensive one — and rendering the raw
  // code at a patient would be worse than saying plainly that it is new.
  'entry.unknownOptionLabel': 'Another option',
  // The pickers have nothing to offer until the device has fetched the value
  // sets at least once. Says what is true rather than showing an empty box.
  'entry.optionsUnavailable':
    'We could not load the choices for this yet. You can still save your entry without them.',

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

  // sync-contract §5.4. Deliberately says what will happen BEFORE it happens
  // and names the one thing a patient would fear — losing what they wrote.
  // "Refresh" rather than "reset" or "wipe": the patient did nothing wrong,
  // and the outcome they experience is an up-to-date diary, not a deletion.
  // No mention of cursors, servers or sync: the cause is ours, and a patient
  // can act on none of it.
  'staleSync.heading': 'Your diary needs a refresh',
  'staleSync.body':
    'This phone has been away for a while, so it may be showing entries your care team no longer has. Refreshing gets a fresh copy.',
  'staleSync.keepsUnsent': 'Anything you wrote that has not been sent yet is kept.',
  'staleSync.button': 'Refresh my diary',
  'staleSync.working': 'Refreshing…',
  'staleSync.failed': 'The refresh did not finish. You can try again.',
} as const;
