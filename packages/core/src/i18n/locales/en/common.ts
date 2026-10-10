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

  // Quick-Add widget copy (P3.S4, SRS §3.1). `common` rather than `mobile`:
  // a widget's accessible name states a volume, a Measured/Estimated
  // assertion and a fluid type, all of which carry clinical meaning, and the
  // web client will eventually offer the same thing.
  //
  // The visible label is composed by `QuickAddWidgets` from these keys plus
  // `formatVolumeQuantity`, never from a hand-written unit string — ADR-0006,
  // and the same reason this catalog has no `unit.mL` key.
  //
  // What the ACCESSIBLE NAME must carry that the visible label need not:
  // the Measured/Estimated answer is rendered visibly as a separate line, but
  // a screen-reader user hearing only "350 millilitres, button" would be one
  // tap from asserting a measurement they did not make. So the hint spells out
  // what tapping does, including the toggle.
  'quickAdd.volumeLabel': '{{amount}} · {{method}}',
  'quickAdd.volumeWithTypeLabel': '{{amount}} {{fluidType}} · {{method}}',
  // A colour-only urine entry (AC 12.1 AC2) has no amount at all. Naming the
  // colour alone, without an amount, is the honest rendering — and "no amount"
  // is said out loud rather than left as an absence, because a missing volume
  // is never zero.
  'quickAdd.colorOnlyLabel': '{{color}} · no amount',
  'quickAdd.logHint': 'Records this entry now, with the time set to right now.',
  // Said plainly, because the number is the patient's own and the honesty of
  // it is what makes the widget trustworthy.
  'quickAdd.repeatCount_one': 'You logged this once recently.',
  'quickAdd.repeatCount_other': 'You logged this {{count}} times recently.',
  'quickAdd.editButton': 'Change before saving',
  'quickAdd.editHint': 'Opens the entry form with these details filled in, so you can adjust them.',

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
  // Names the noun. "How much did you pass?" is ambiguous on exactly this
  // screen: for an ostomy patient "pass" is what stool does, the verb appeared
  // with no object, and the only thing disambiguating it was a heading two
  // lines up — which a screen-reader user hearing the label alone does not
  // have.
  'entry.urineAmountLabel': 'How much urine did you pass? (optional)',
  // Says the toggle is coming BEFORE it appears. It is inserted mid-form when
  // an amount is typed, so without this a screen-reader user meets a required
  // control that materialised behind them, after they have already read the
  // form. `entry.stomaOutputAmountHint` does the same thing for the same
  // reason.
  'entry.urineAmountHint':
    'Leave this blank if you did not measure it, and pick a colour below instead. If you do enter an amount, you will say next whether you measured it.',
  // AC 12.1 AC3. "Optional" again, for the same reason — with the amount
  // also optional, a patient must be able to see that ONE of the two is
  // enough, which the hint below says outright.
  'entry.urineColorLabel': 'What colour was your urine? (optional)',
  // States the DIRECTION of the scale, which is the clinical content and was
  // previously carried by the gradient alone. A sighted patient reads
  // pale-to-dark off the swatches in one glance; a screen-reader user hears
  // six names, and nothing in the words said which end was which.
  'entry.urineColorHint':
    'The list goes from lightest to darkest. Pick the closest match. Colour on its own is a useful entry, even with no amount.',
  // POSITION only. The direction is already established twice before a user
  // reaches option 1 — once in the label's own hint, once by the two ends
  // naming themselves — so repeating "lightest to darkest" here spoke that
  // phrase seven times in one control. Verbosity in a screen-reader flow is not
  // neutral: it is what trains someone to swipe past a control before it
  // finishes speaking, and this is the control they must not swipe past.
  //
  // React Native reports no position-in-set for a `ChoiceGroup`, which is why
  // this channel exists at all.
  'entry.urineColorStepHint': 'Step {{step}} of {{total}}.',
  // The pale-to-dark urine colour scale (AC 12.1 AC3). Each step is named in
  // words, because the swatch beside it is decorative and hidden from
  // assistive technology — the words ARE the scale.
  //
  // The labels must also be ORDERABLE, not merely distinguishable, which is
  // what the first version got wrong. This is a scale, and its direction is
  // the clinical content ("darker is more concentrated"). Six unique names
  // satisfy "announced distinguishably" while leaving a screen-reader user
  // unable to tell which end is which — nothing in the words placed "Amber"
  // against "Dark yellow". So the two ends say which ends they are, and the
  // middle uses one comparative vocabulary throughout.
  //
  // "Amber" became "Orange-brown" for a reason that is not reading level: it
  // scores fine and is a common word. It is the one name here a substantial
  // share of adults cannot map to a shade without being shown one — which
  // defeats the point of a name-based scale, whose whole job is to let someone
  // who cannot see the swatch still choose.
  'urineColor.pale_straw': 'Almost clear — lightest',
  'urineColor.straw': 'Pale yellow',
  'urineColor.yellow': 'Yellow',
  // "Darker yellow", not "Dark yellow": at TalkBack's default rate the pair
  // "Yellow" / "Dark yellow" is the one most at risk of being heard as the
  // same option twice, and the comparative carries the ordering as well.
  'urineColor.dark_yellow': 'Darker yellow',
  'urineColor.amber': 'Orange-brown',
  'urineColor.brown': 'Brown — darkest',
  // Shown in place of Save until the entry records something. States the
  // condition rather than scolding: an entry with neither an amount nor a
  // colour records nothing at all, and the server refuses it.
  // Action first, active voice, two short sentences. The previous version was
  // one twelve-word sentence ending in the passive "can be saved", which is
  // where a skimming reader drops off.
  'entry.urineNothingToSave': 'Add an amount or pick a colour. Then you can save this entry.',

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
  // Its own string, because the shared `entry.optionsUnavailable` ends "You can
  // still save your entry without them" — true for the optional pickers on the
  // intake and meal screens, and false here in the one way that matters. With
  // no colour scale the amount-optional route is gone, so a patient who cannot
  // measure can save nothing at all. Reachable by design: the value-set cache
  // is unseeded until the first successful sync.
  'entry.urineColorUnavailable':
    'We could not load the colour choices yet. For now, you will need to enter an amount to save this entry.',
  'entry.optionsUnavailable':
    'We could not load the choices for this yet. You can still save your entry without them.',

  // --- No patient record on the server yet (#80, §6.1) -------------------
  //
  // The token is valid; the account simply has no clinical record attached, so
  // nothing can sync until it does. Shown rather than left silent because the
  // alternative is the failure this code was added to end: entries queue
  // forever while every screen truthfully reports them saved, and nothing says
  // why.
  //
  // Two things this copy must NOT do. It must not tell the patient to sign in
  // again — that is what the old `UNAUTHENTICATED` mapping caused, it succeeds,
  // and it changes nothing. And it must not read as data loss: the entries are
  // safe on the phone and will send themselves, which is the first thing
  // someone in this state needs to know.
  //
  // It also does not name onboarding, because onboarding does not exist yet
  // (P4). When it does, this becomes a route rather than a sentence, and the
  // heading can stay.
  /**
   * Onboarding — the three questions SRS §3.0 makes mandatory (P4.S1).
   *
   * In `common` rather than `mobile` because every one of these has clinical
   * meaning: an ostomy type, a surgery date, and the units every clinical amount
   * in the app is rendered in. ADR-0006's rule is that such copy lives in a shared
   * namespace so one reviewer reads all of it in one place, and it does not turn on
   * which app happens to show it.
   *
   * Each hint says what the answer is FOR. §3.0's reason for keeping this to three
   * questions is that a newly discharged patient may be setting the app up in a
   * hospital bed, and a question whose purpose is invisible is one they stall on.
   *
   * Nothing here promises these can be changed later. Editing a profile is P4.S3,
   * and copy that offers it now would be a promise this build does not keep.
   */
  'onboarding.heading': 'Set up your diary',
  'onboarding.intro': 'Three questions, then you can start logging.',

  'onboarding.ostomyTypeLabel': 'What kind of ostomy do you have?',
  'onboarding.ostomyTypeHint':
    'This sets the amounts the app expects, so it can tell you when something looks unusual.',
  'onboarding.ostomyTypeRequired': 'Choose the kind of ostomy you have.',
  'ostomyType.colostomy': 'Colostomy',
  'ostomyType.ileostomy': 'Ileostomy',

  'onboarding.surgeryDateLabel': 'When was your surgery?',
  // Says what the date does, because it is the one answer here with a consequence
  // the patient will meet later: an entry dated before it cannot be saved.
  'onboarding.surgeryDateHint':
    'The app uses this so an entry from before your surgery is not saved by mistake.',
  'onboarding.surgeryDateDayLabel': 'Day',
  'onboarding.surgeryDateMonthLabel': 'Month',
  'onboarding.surgeryDateYearLabel': 'Year',
  'onboarding.surgeryDateYearHint': 'All four numbers, like 2026.',
  'onboarding.surgeryDateRequired': 'Fill in the day, month and year of your surgery.',
  // Keyed to `SURGERY_DATE_RULE_CODE`, and mapped by a Record in
  // `apps/mobile/src/onboarding/onboardingCopy.ts` so a new code with no copy is a
  // compile error rather than a raw key in front of a patient.
  'onboarding.surgeryDateNotADate': 'That is not a real date. Check the day and month.',
  'onboarding.surgeryDateInTheFuture': 'Choose a date that has already happened.',
  'onboarding.surgeryDateImplausiblyOld': 'Check the year — that date is a long time ago.',

  'onboarding.measurementSystemLabel': 'Which units do you want to use?',
  'onboarding.measurementSystemHint':
    'One choice covers amounts and weight. The app shows every amount this way.',
  'onboarding.measurementSystemRequired': 'Choose the units you want to use.',
  'measurementSystem.metric': 'Millilitres and kilograms (mL, kg)',
  'measurementSystem.imperial': 'Ounces and pounds (oz, lb)',

  'onboarding.saveButton': 'Finish setting up',
  'onboarding.savingLabel': 'Setting up your diary',
  // Unknown fate, not failure: the request may have landed. Says what to do, and
  // the retry is safe — a second attempt for a patient who IS set up finds their
  // profile instead of failing.
  'onboarding.unreachableHeading': 'We could not reach your account',
  'onboarding.unreachableBody':
    'Your phone needs a connection for this one step. Check your connection, then try again.',
  'onboarding.retryButton': 'Try again',
  'onboarding.failedBody':
    'Your diary could not be set up. Please try again, and contact your care team if it keeps happening.',
  'onboarding.checkingLabel': 'Checking your account',

  /**
   * Target ranges and their basis (P4.S2 slice 4, SRS §3.9, AC 14.1 AC1/AC4).
   *
   * In `common` because every line here has clinical meaning: a range type is a
   * clinical measure, and a basis statement says what is typical for a group of
   * people. ADR-0006 puts that in a shared namespace so one reviewer reads all
   * of it together, and §3.9's framing constraint is what that review is for.
   *
   * ## Descriptive, never prescriptive — and the numbers make that sharper
   *
   * §3.9: patient-facing copy "describes suggestions descriptively — what is
   * typical for people with a similar profile — rather than prescriptively.
   * Suggested ranges are informational context for the patient and their care
   * team; they are not a treatment recommendation, and copy must not present
   * them as one."
   *
   * That constraint binds harder here than it would otherwise, because the
   * numbers behind these sentences are implementer-chosen and **unratified by
   * any clinician** (#130). So: "typical", never "should"; "about", never a
   * precise claim; and no verb that tells the patient to do anything.
   */
  'targetRanges.heading': 'Your target ranges',
  'targetRanges.intro':
    'What is typical for people with a similar profile. These are for context — they are not advice, and nothing here is checked against your entries yet.',
  'targetRanges.empty': 'There are no target ranges for your profile yet.',

  'rangeType.daily_output_ml': 'Daily output from your stoma',
  'rangeType.urine_output_adequacy_ml': 'Daily urine',
  'rangeType.net_fluid_balance_ml': 'Daily net fluid balance',
  // Shown in place of a range type this release has no label for. The three
  // above are the ones seeded today; weight and heart-rate measures arrive with
  // Sections 3.12 and 3.13, and until this catalog names them a reader sees the
  // value under a generic label rather than not at all. Hiding it would be the
  // worse failure: a measure silently missing from a review screen.
  'rangeType.unknownMeasure': 'Another measure',

  // Both bounds, one bound, or neither. `{{low}}`/`{{high}}` arrive already
  // formatted and carrying their unit, so the measurement system governs them
  // (ADR-0004) and this never spells a unit itself.
  'targetRanges.band': '{{low}} to {{high}}',
  'targetRanges.atLeast': 'At least {{low}}',
  'targetRanges.atMost': 'Up to {{high}}',

  /**
   * The basis (AC 1), assembled from the fields the API returns rather than
   * from a sentence it sends. "About" is doing real work: the window is a span
   * of days and a precise phrasing would overstate what is known.
   */
  'targetRanges.basisEarly': 'Typical for {{ostomyType}} in the first weeks after surgery.',
  'targetRanges.basisMonths': 'Typical for {{ostomyType}} about {{months}} months after surgery.',
  'targetRanges.basisSettled': 'Typical for {{ostomyType}} once things have settled.',
  /**
   * The article is part of the value, not of the sentence.
   *
   * "a {{ostomyType}}" produces "a ileostomy", which a test caught. Pulling the
   * article out of the template is also the only form that survives translation:
   * which article a noun takes is a property of the noun in most languages, and
   * several decline it by case — a sentence that assumes one is a sentence that
   * can only be English.
   */
  'ostomyType.colostomyLower': 'a colostomy',
  'ostomyType.ileostomyLower': 'an ileostomy',

  /**
   * AC 2, said out loud. A suggestion shown without this reads as "this is your
   * target", which is the impression the whole confirmation rule exists to
   * prevent — and the stored row says so too (`isActiveThreshold`).
   */
  'targetRanges.notConfirmed': 'A suggestion. You have not set this yourself.',
  'targetRanges.sourcePhysician': 'Set by your care team.',
  'targetRanges.sourcePatient': 'Set by you.',
  'targetRanges.sourceConfirmed': 'A suggestion you accepted.',
  /**
   * AC 4. The physician's value stays in force and the divergence is reported —
   * so this says which one is being shown, rather than leaving a patient to
   * assume the number they entered is the one in use.
   */
  'targetRanges.divergesFromPhysician':
    'You have a different value saved. Your care team’s value is the one shown.',

  'notProvisioned.heading': 'Your account is not set up yet',
  // P4.S1: this is now a route rather than a sentence, which is what the earlier
  // version of this comment said it would become. The entries really are safe
  // on the phone — that half has not changed — but the patient can now act, so
  // the copy stops telling them to wait for something that will not happen.
  'notProvisioned.body':
    'Your entries are saved on this phone. Finish setting up your account and they will send on their own.',
  'notProvisioned.contact':
    'If this keeps happening, contact your care team — they can help finish setting up your account.',
  'notProvisioned.finishSetupButton': 'Finish setting up',

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
