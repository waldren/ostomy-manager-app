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

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import i18next from '../i18n/i18n';

import { authenticate, type BiometricUnlockOutcome } from './biometricUnlock';
import { deriveAuthPhase, type AuthPhase } from './authPhase';
import { getOidcClientConfig } from './oidcConfig';
import { useAutoDiscovery, refreshAccessToken, type OidcTokens } from './oidcSession';
import { clearRefreshToken, getRefreshToken, hasStoredRefreshToken, setRefreshToken } from './tokenStorage';

/**
 * **Design decision, stated here because it is the one a reviewer is most
 * likely to want to relitigate:** a successful biometric unlock is
 * sufficient for LOCAL app access, independent of whether the subsequent
 * access-token refresh network call succeeds.
 *
 * `apps/mobile` is the only offline-capable client, built specifically for
 * a patient who "logs in public restrooms and while traveling" (CLAUDE.md).
 * If unlocking required a live network round trip to succeed, the app
 * would be unusable in exactly the situations it exists to handle. A
 * missing or stale access token blocks only the sync push/pull network
 * calls themselves (P2.S2b) — never local entry, never reading local
 * history, never anything this app can do without the network. See
 * `apps/mobile/README.md` "Architecture notes for the next sprint".
 */
export interface AuthContextValue {
  readonly phase: AuthPhase;
  readonly accessToken: string | undefined;
  /** Runs the biometric/passcode prompt and, on success, transitions to `authenticated` — see this file's header comment for what a concurrent refresh failure does and does not affect. */
  readonly unlock: () => Promise<BiometricUnlockOutcome>;
  /** Called by `app/login.tsx` once the OIDC code exchange succeeds. Persists the refresh token (if the provider returned one) and transitions to `authenticated`. */
  readonly completeLogin: (tokens: OidcTokens) => Promise<void>;
  readonly signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [phase, setPhase] = useState<AuthPhase>('checking');
  const [accessToken, setAccessToken] = useState<string | undefined>(undefined);
  const config = useMemo(() => getOidcClientConfig(), []);
  const discovery = useAutoDiscovery(config.issuer);

  useEffect(() => {
    let cancelled = false;
    hasStoredRefreshToken().then((hasToken) => {
      if (cancelled) return;
      setPhase(deriveAuthPhase({ hasStoredRefreshToken: hasToken, unlockedThisSession: false }));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const completeLogin = useCallback(async (tokens: OidcTokens): Promise<void> => {
    if (tokens.refreshToken !== undefined) {
      await setRefreshToken(tokens.refreshToken);
    }
    setAccessToken(tokens.accessToken);
    setPhase('authenticated');
  }, []);

  const unlock = useCallback(async (): Promise<BiometricUnlockOutcome> => {
    // `expo-local-authentication`'s `promptMessage` is rendered by the
    // operating system's own biometric sheet, not by this app's JSX tree —
    // there is no node for the `i18next/no-literal-string` lint rule (which
    // only scans JSX) to catch here. It still comes from the catalog: the
    // text is user-facing regardless of which layer renders it, and
    // CLAUDE.md's "no hardcoded user-facing strings" rule is not scoped to
    // what a lint rule happens to reach.
    const outcome = await authenticate(i18next.t('mobile:login.unlockPromptMessage'));
    if (outcome.outcome !== 'success') return outcome;

    setPhase('authenticated');

    // Best-effort only — see this file's header comment. A failure here
    // (offline, expired refresh token, provider unreachable) never
    // reverts the phase transition above; it only means `accessToken`
    // stays unset until the next successful attempt, which blocks a
    // sync network call and nothing else.
    if (discovery) {
      const storedRefreshToken = await getRefreshToken();
      if (storedRefreshToken) {
        try {
          const tokens = await refreshAccessToken(discovery, config, storedRefreshToken);
          setAccessToken(tokens.accessToken);
          if (tokens.refreshToken !== undefined) {
            await setRefreshToken(tokens.refreshToken);
          }
        } catch {
          // Deliberately swallowed — see header comment. Nothing PHI-bearing
          // or security-sensitive may be logged from a catch here in any
          // case (CLAUDE.md "never log PHI"; this app has no crash-reporting
          // sink at all per docs/sync-contract.md §10's BAA note), and a
          // failed refresh has a defined, safe fallback: the next screen
          // that actually needs a network call surfaces its own failure.
        }
      }
    }

    return outcome;
  }, [discovery, config]);

  const signOut = useCallback(async (): Promise<void> => {
    await clearRefreshToken();
    setAccessToken(undefined);
    setPhase('signedOut');
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ phase, accessToken, unlock, completeLogin, signOut }),
    [phase, accessToken, unlock, completeLogin, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('useAuth() must be called within an AuthProvider (see app/_layout.tsx).');
  }
  return value;
}
