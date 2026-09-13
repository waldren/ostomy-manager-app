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
  'login.signedOutBody':
    'You can write in your diary even with no internet. Entries save on your phone right away, and go to your care team when you are back online.',
  'login.signInButton': 'Sign in',
  'login.lockedHeading': 'Welcome back',
  'login.lockedBody': 'Unlock your diary to continue.',
  // Platform-neutral. "Face ID" is an Apple trademark and was shown to
  // Android users, and neither string named the DEVICE PASSCODE — the one
  // fallback this population most needs, deliberately enabled in
  // biometricUnlock.ts for the bandaged or post-surgical hand.
  'login.unlockButton': 'Unlock my diary',
  'login.unlockHint': 'Use your face, fingerprint, or phone passcode.',
  'login.unlockPromptMessage': 'Unlock your ostomy diary',
  'login.unlockUnavailableBody':
    'This phone does not have face, fingerprint, or passcode unlock turned on. Sign in again to continue.',
  'login.signInInsteadButton': 'Sign in again instead',
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
  'home.signOutButton': 'Sign out',
  // Sign-out is destructive and that was carried by colour alone (WCAG
  // 1.4.1) — a dark red button whose accessible name said only "Sign out".
  'home.signOutHint': 'This signs you out and removes your diary from this phone.',
  'common.loadingLabel': 'Loading your diary',
  // The app can fail to open its local database — the keychain is
  // unavailable before the device's first unlock, and a migration can
  // throw. That used to render as a spinner that never resolved.
  'common.startupErrorHeading': 'We could not open your diary',
  'common.startupErrorBody':
    'Something went wrong while opening your diary on this phone. Close the app and open it again. If that does not work, sign in again.',
  'common.startupErrorButton': 'Sign in again',
} as const;

export type MobileCatalogKey = keyof typeof mobile;
