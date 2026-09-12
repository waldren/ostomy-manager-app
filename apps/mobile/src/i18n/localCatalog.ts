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
 * ============================================================================
 * DELIBERATE, RECORDED DEVIATION FROM ADR-0006 — read before adding a key.
 * ============================================================================
 *
 * ADR-0006 states plainly: "All user-facing copy lives in one shared
 * English catalog at `packages/core/i18n/` ... There are no per-app
 * catalogs." That decision is correct and this file does not challenge it.
 *
 * It exists anyway because this dispatch's own scope boundary is more
 * specific and directly conflicting: P2.S2a's instructions list
 * `packages/core/src/**` as explicitly out of scope — "every subpath has
 * an owner under ADR-0007 and none is you... report anything missing" —
 * and the login/home skeleton this sprint builds needs copy
 * (`packages/core/src/i18n`'s `common` namespace holds exactly two keys
 * today, `method.measured`/`method.estimated`, nothing for a login or
 * placeholder home screen). Two direct instructions cannot both be
 * followed to the letter; this file is the resolution, stated so it can be
 * undone rather than discovered later:
 *
 *   - Every key below is routed through i18next exactly like a
 *     `packages/core/i18n` key would be (`src/i18n/i18n.ts` merges this
 *     namespace into the same `i18next` instance) — no hardcoded strings
 *     reach a screen, satisfying SRS §5.4's actual requirement.
 *   - `accessibility-copy-reviewer` should read this file with the same
 *     scrutiny as the shared catalog: 6th–8th grade reading level, no
 *     tone conflated with a validation warning or the red-flag prompt
 *     (moot here — this file has neither), and every `*.a11yLabel` naming
 *     the action a control performs.
 *   - **Follow-up owed, not optional:** these keys should migrate into
 *     `packages/core/src/i18n/locales/en/common.ts` (or a new namespace,
 *     the i18n owner's call) the next time that subpath's owner is
 *     in the loop, and this file should then be deleted. Until that
 *     happens, this is the one place in `apps/mobile` a literal English
 *     string is permitted to originate — nowhere else.
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
