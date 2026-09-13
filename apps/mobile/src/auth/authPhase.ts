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
 * The app's four auth states, and the pure function that derives which one
 * applies — split out from `AuthContext.tsx` so the decision logic is
 * testable with no React rendering, no `expo-secure-store`, and no
 * `expo-local-authentication` involved at all.
 *
 * - `checking`      — reading `expo-secure-store` on cold start; local and
 *                      near-instantaneous, never a network wait (SRS §4.5:
 *                      a spinner waiting on connectivity is a defect, and
 *                      this one waits on neither connectivity nor even a
 *                      slow local operation).
 * - `signedOut`     — no refresh token stored. `app/login.tsx` renders the
 *                      "Log in" affordance.
 * - `locked`        — a refresh token exists but this app process has not
 *                      yet passed a biometric/passcode check. `app/login.tsx`
 *                      renders the "Unlock" affordance instead of "Log in" —
 *                      one route, two rendered states, so this sprint adds
 *                      no third route beyond "login screen" and "placeholder
 *                      home screen" (P2.S2a's exit criteria).
 * - `authenticated` — unlocked (or freshly logged in) this session. Local
 *                      app access is granted **regardless of whether the
 *                      subsequent access-token refresh network call
 *                      succeeds** — see `AuthContext.tsx`'s header comment.
 *                      `app/home.tsx` renders.
 */
export type AuthPhase = 'checking' | 'signedOut' | 'locked' | 'authenticated';

export interface AuthPhaseInputs {
  readonly hasStoredRefreshToken: boolean;
  readonly unlockedThisSession: boolean;
}

export function deriveAuthPhase(inputs: AuthPhaseInputs): 'signedOut' | 'locked' | 'authenticated' {
  if (!inputs.hasStoredRefreshToken) return 'signedOut';
  return inputs.unlockedThisSession ? 'authenticated' : 'locked';
}
