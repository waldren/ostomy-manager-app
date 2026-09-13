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
  'login.signedOutBody': 'Your entries stay on this phone and sync automatically once you sign in.',
  'login.signInButton': 'Sign in',
  'login.lockedHeading': 'Welcome back',
  'login.lockedBody': 'Unlock your diary to continue.',
  'login.unlockButton': 'Unlock with Face ID or fingerprint',
  'login.unlockPromptMessage': 'Unlock your ostomy diary',
  'login.unlockUnavailableBody':
    'Face ID or fingerprint unlock is not set up on this device. Sign in again to continue.',
  'login.signInInsteadButton': 'Sign in again instead',
  'login.tryAgainButton': 'Try again',
  'login.errorBody': 'Something went wrong. Please try again.',
  'home.title': 'Home',
  'home.welcomeHeading': 'You are signed in',
  'home.placeholderBody': 'Logging output, intake, and weight is coming soon.',
  'home.queuedCountLabel': 'Entries waiting to sync: {{count}}',
  'home.signOutButton': 'Sign out',
  'common.loadingLabel': 'Loading your diary',
} as const;

export type MobileCatalogKey = keyof typeof mobile;
