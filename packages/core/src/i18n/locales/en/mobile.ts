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
 * The `mobile` namespace: `apps/mobile`'s app-shell copy.
 *
 * Per-app namespace, **shared catalog**. ADR-0006 requires one catalog in
 * this package with no per-app catalogs, and that is what this is — the
 * namespace is scoped to one app because a login screen's copy is not web
 * table-heading copy, but it lives here so a reviewer auditing
 * patient-facing text reads all of it in one place. That
 * single-place-to-audit property is the ADR's actual argument, and it
 * survives namespacing by app; it would not survive a catalog inside
 * `apps/mobile`.
 *
 * Scope discipline, which is what keeps this from drifting back toward two
 * catalogs: **only copy with no clinical meaning belongs here** — sign-in,
 * biometric unlock, navigation, placeholder states. Anything clinical or
 * cross-app (a validation message, a Tier 2 warning, the red-flag prompt,
 * the Measured/Estimated labels) belongs in `common`, `validationErrors`,
 * `validationWarnings` or `redFlags`, and is never duplicated here.
 *
 * Same key-naming convention as the rest of the catalog (see
 * `packages/core/src/i18n/index.ts`): `*.label` is visible text,
 * `*.a11yLabel` is an accessible name only when it must differ from the
 * visible label, `*.hint` is supplementary text.
 */
export const mobile = {
  'login.title': 'Ostomy Diary',
  'login.signedOutHeading': 'Sign in to your diary',
  // Says what actually happens to the entries. It read "Your entries stay
  // on this phone and sync automatically" — which a patient can reasonably
  // read as "nothing leaves my phone", when the entries are uploaded and
  // read by a care team. That is a consent-adjacent misstatement in a
  // health app, and "sync" is unexplained jargon besides.
  // "Once you are signed in", because from THIS screen the patient cannot reach an
  // entry screen at all — the unqualified version read as a contradiction directly
  // above copy telling them to sign in before anything can send (#40's review).
  'login.signedOutBody':
    'Once you are signed in, you can write in your diary even with no internet. Entries save on your phone right away, and go to your care team when you are back online.',
  'login.signInButton': 'Sign in',
  'login.lockedHeading': 'Welcome back',
  'login.lockedBody': 'Unlock your diary to continue.',
  // Platform-neutral. "Face ID" is an Apple trademark and was shown to
  // Android users, and neither string named the DEVICE PASSCODE — the one
  // fallback this population most needs, deliberately enabled in
  // biometricUnlock.ts for the bandaged or post-surgical hand.
  'login.unlockButton': 'Unlock my diary',
  // "Passcode" is Apple's word, and v1 is Android only (ADR-0020), where Settings
  // calls this Screen lock and the sheet asks for a PIN, pattern or password. A
  // patient who unlocks with a pattern was being told to use something their phone
  // has never called that. Matching the word on the OS screen is the whole job of
  // this hint.
  //
  // It also has to serve a patient with no biometric at all, since #74 made local
  // unlock available to them — hence "if you set one up" rather than a second
  // string chosen by an extra async branch.
  'login.unlockHint':
    'Use your fingerprint or face, if you set one up. You can also use the PIN, pattern, or password that unlocks this phone.',
  'login.unlockPromptMessage': 'Unlock your ostomy diary',
  // Reached only when the OS has nothing enrolled to authenticate with at all
  // (`SecurityLevel.NONE`). It used to be reached by any phone without a biometric,
  // where it was simply false — the patient's passcode unlock WAS turned on (#74).
  'login.unlockUnavailableBody':
    'This phone has no fingerprint, face, or screen lock set up, so we cannot unlock your diary here. Sign in again to open it.',
  'login.signInInsteadButton': 'Sign in again instead',
  // --- The app ended the session by itself: two reasons, two blocks ------------
  //
  // Common to both, and the reason each has a body rather than a heading alone: a
  // patient who has been opening "Welcome back / Unlock my diary" for weeks opens
  // the app to "Sign in to your diary", and the most available inference is that
  // their diary is gone. It is not — ending a session clears the token only, and
  // re-login under the same subject matches the database owner, so nothing is
  // erased. The patient has no way to know that, which is the argument
  // `notProvisioned.*` was written from.
  //
  // Each HEADING carries the cause, not a second instruction. The H1 already says
  // "Sign in to your diary" and the button says "Sign in", so a heading like "Please
  // sign in again" made three instructions and no explanation — and `Heading.tsx`
  // exposes no heading level on Android, so two near-identical headings make
  // TalkBack's rotor worse than one would.
  //
  // Both promise the queue will send, identically, because the behaviour IS
  // identical: `endSession` clears the token and never purges, which a test asserts.
  // And both say "after you sign in" rather than "once you are back in", because
  // `login.signedOutBody` above says entries send "when you are back online" and the
  // queue does not drain on network alone from here.

  // The phone's unlock settings changed (#74).
  //
  // It must NOT say the patient added a fingerprint. The purge fires on a change in
  // either direction, and ADR-0015's threat is someone else enrolling one covertly —
  // naming the patient as the actor is false in exactly the case this exists for,
  // and it would erase the only signal they will ever get about it.
  'login.unlockChangedHeading': 'We signed you out to keep your diary safe',
  'login.unlockChangedBody':
    'The fingerprint, face, or screen lock on this phone changed. When that happens we sign you out and ask you to sign in again. Nothing you wrote is lost. Your entries are still on this phone, and they will send after you sign in.',

  // The issuer rejected the refresh token (#40).
  //
  // Deliberately NOT the enrolment copy above, which claims something about the
  // phone's security that is false here: this is an ordinary expired or revoked
  // sign-in and the patient did nothing.
  //
  // "Ended", not "run out". `invalid_grant` covers expired, revoked AND reissued to
  // another client (RFC 6749 §5.2), so "run out" asserts a timer that may not have
  // been the cause — and if the grant was revoked because someone reset access to
  // the account, telling the patient it was routine erases the only signal they get.
  // Same objection as the one recorded above about naming the patient as the actor.
  'login.sessionEndedHeading': 'Your sign-in has ended',
  'login.sessionEndedBody':
    'We need to check it is you again before you open your diary. Nothing you wrote is lost. Your entries are still on this phone, and they will send after you sign in.',
  'login.tryAgainButton': 'Try again',
  // Four outcomes, four remedies. One blanket "Something went wrong"
  // covered a failed sign-in, a failed unlock, a cancelled browser and
  // being offline — situations whose correct next actions differ, and two
  // of which are not errors at all.
  'login.errorBody':
    'We could not sign you in. Please try again. If this keeps happening, contact support.',
  'login.unlockFailedBody':
    'We could not unlock your diary. Try again, or use your phone passcode.',
  'login.unlockRetryButton': 'Try unlocking again',
  'login.cancelledBody': 'Sign in was cancelled. Tap Sign in when you are ready.',
  // The redirect route's waiting state (ADR-0021). It holds while the code is
  // exchanged, because navigating away is what previously stopped the flow
  // completing at all — so there is a moment the patient waits, and it says so
  // rather than showing a blank screen or, for a screen-reader user, silence.
  'login.completingHeading': 'Finishing sign in',
  'login.completingBody': 'Just a moment while we finish signing you in.',
  'login.offlineBody':
    'You are not connected to the internet. Signing in needs a connection. Try again when you have Wi-Fi or mobile data.',
  'home.title': 'Home',
  'home.welcomeHeading': 'You are signed in',
  // Second person, no clinical shorthand, and no roadmap voice. "Output"
  // unqualified is jargon, and "coming soon" is product language in a
  // clinical tool.
  'home.placeholderBody':
    'Soon you will be able to record what comes out of your stoma, what you drink, and your weight. For now, there is nothing to do here.',
  // Plural forms, and a distinct string for zero. The single template
  // rendered "Entries waiting to sync: 1", and told a patient with an empty
  // queue about a queue.
  'home.pendingCount_one': '1 entry has not been sent yet.',
  'home.pendingCount_other': '{{count}} entries have not been sent yet.',
  'home.pendingCountNone': 'Everything is saved and sent.',
  'home.addOutputButton': 'Add a stoma entry',
  'home.addIntakeButton': 'Add a drink',
  // Reads as an ACTION, not a body function: "Add a urine entry" is what the
  // patient is doing, and it matches the screen's own heading so the button and
  // the page they land on agree.
  'home.addUrineButton': 'Add a urine entry',
  'home.addMealButton': 'Add a meal',
  'home.correctionsButton': 'Entries that need attention',
  'home.correctionsCount_one': '1 entry needs your attention.',
  'home.correctionsCount_other': '{{count}} entries need your attention.',
  'home.signOutButton': 'Sign out',
  // Sign-out is destructive and that was carried by colour alone (WCAG
  // 1.4.1) — a dark red button whose accessible name said only "Sign out".
  'home.signOutHint': 'This signs you out and removes your diary from this phone.',
  // Sign-out destroys this phone's copy of the diary, and anything not yet
  // sent goes with it (ADR-0014). Naming the number is what makes the
  // choice a real one — "you may lose data" is not something a patient can
  // act on, and they cannot see the queue.
  'signOut.unsyncedHeading': 'Some entries have not been sent yet',
  'signOut.unsyncedBody_one':
    '1 entry is still only on this phone. Signing out removes it for good. Connect to the internet and wait a moment to send it first.',
  'signOut.unsyncedBody_other':
    '{{count}} entries are still only on this phone. Signing out removes them for good. Connect to the internet and wait a moment to send them first.',
  'signOut.waitButton': 'Go back and wait',
  'signOut.confirmButton': 'Sign out and delete them',
  'signOut.checkFailedBody':
    'We could not check whether everything has been sent. Signing out now may remove entries that have not gone to your care team.',

  'navigation.backButton': 'Go back',
  'common.loadingLabel': 'Loading your diary',
  // The app can fail to open its local database — the keychain is
  // unavailable before the device's first unlock, and a migration can
  // throw. That used to render as a spinner that never resolved.
  'common.startupErrorHeading': 'We could not open your diary',
  'common.startupErrorBody':
    'Something went wrong while opening your diary on this phone. Close the app and open it again. If that does not work, sign in again.',
  'common.startupErrorButton': 'Sign in again',
  // --- The safe ranges have not reached this phone yet (#63) -------------------
  //
  // NOT `startupErrorBody`, which the three entry screens used to borrow. That copy
  // says "Close the app and open it again. If that does not work, sign in again." —
  // advice that cannot work here however many times it is followed, and the same
  // defect class as #74's "Please try again" and #40's silent session. It also named
  // the wrong thing: the condition is an empty `validation_thresholds_cache`, not a
  // database that would not open, and `home.tsx` still uses that string for the
  // genuine database failure it was written for.
  //
  // What is actually true: the cache is **deliberately unseeded**, because a default
  // there is a hardcoded threshold wearing a database costume, so the save refuses
  // rather than validating against invented numbers. It fills from a sync, which
  // needs one online moment after signing in. Nothing for the patient to fix, and
  // nothing to restart.
  //
  // It says "safe range" rather than "validation threshold": the patient's reason to
  // care is that the app checks entries against limits their care team sets.
  'entry.thresholdsUnavailableBody':
    'This phone does not have your safe ranges yet, so it cannot check your entries. Connect to the internet for a moment and they will arrive on their own. You do not need to close the app.',
} as const;

export type MobileCatalogKey = keyof typeof mobile;
