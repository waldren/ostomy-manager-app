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

import { Redirect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '../src/auth/AuthContext';
import { isBiometricUnlockAvailable } from '../src/auth/biometricUnlock';
import { useOidcLogin } from '../src/auth/useOidcLogin';

/**
 * One route rendering two states — "signed out" (full OIDC login) and
 * "locked" (biometric unlock of an already-stored session) — rather than
 * a third route, matching this sprint's exit criteria ("routes between at
 * least a login screen and a placeholder home screen"). See
 * `src/auth/authPhase.ts` for why these are exactly the two
 * pre-authenticated phases that exist.
 */
export default function Login(): React.JSX.Element {
  const { phase, unlock, completeLogin } = useAuth();
  const { t } = useTranslation('mobile');
  const { isReady, login } = useOidcLogin();
  const [error, setError] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    if (phase !== 'locked') return;
    let cancelled = false;
    isBiometricUnlockAvailable().then((available) => {
      if (!cancelled) setBiometricAvailable(available);
    });
    return () => {
      cancelled = true;
    };
  }, [phase]);

  const handleSignIn = useCallback(async () => {
    setError(false);
    try {
      const tokens = await login();
      if (tokens) await completeLogin(tokens);
    } catch {
      // Never log the error: it may embed a query string carrying an
      // authorization code or provider-side detail, and this app has no
      // sanctioned diagnostic sink for auth failures (docs/sync-contract.md
      // §10's BAA note applies to any future crash reporter equally).
      setError(true);
    }
  }, [login, completeLogin]);

  const handleUnlock = useCallback(async () => {
    setError(false);
    const outcome = await unlock();
    if (outcome.outcome === 'failed') setError(true);
    // 'unavailable' is rendered by the branch below, not as an error.
  }, [unlock]);

  if (phase === 'authenticated') {
    return <Redirect href="/home" />;
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title} accessibilityRole="header">
        {t('login.title')}
      </Text>

      {phase === 'locked' ? (
        <>
          <Text style={styles.heading}>{t('login.lockedHeading')}</Text>
          <Text style={styles.body}>{t('login.lockedBody')}</Text>
          {biometricAvailable === false ? (
            <>
              <Text style={styles.body}>{t('login.unlockUnavailableBody')}</Text>
              <PrimaryButton label={t('login.signInInsteadButton')} onPress={handleSignIn} />
            </>
          ) : (
            <PrimaryButton label={t('login.unlockButton')} onPress={handleUnlock} />
          )}
        </>
      ) : (
        <>
          <Text style={styles.heading}>{t('login.signedOutHeading')}</Text>
          <Text style={styles.body}>{t('login.signedOutBody')}</Text>
          <PrimaryButton
            label={t('login.signInButton')}
            onPress={handleSignIn}
            disabled={!isReady}
          />
        </>
      )}

      {error ? (
        <>
          <Text style={styles.errorText} accessibilityLiveRegion="polite">
            {t('login.errorBody')}
          </Text>
          <PrimaryButton label={t('login.tryAgainButton')} onPress={handleSignIn} />
        </>
      ) : null}
    </View>
  );
}

function PrimaryButton({
  label,
  onPress,
  disabled,
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
}): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.button,
        disabled && styles.buttonDisabled,
        pressed && styles.buttonPressed,
      ]}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
    gap: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 8,
  },
  heading: {
    fontSize: 20,
    fontWeight: '600',
    textAlign: 'center',
  },
  body: {
    fontSize: 17,
    textAlign: 'center',
  },
  errorText: {
    fontSize: 17,
    textAlign: 'center',
    color: '#8a1c1c',
  },
  button: {
    // Comfortably exceeds the WCAG 2.1 AA / platform 44x44 minimum touch
    // target — this patient population skews older and post-surgical.
    minHeight: 52,
    borderRadius: 12,
    backgroundColor: '#0a5c36',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  buttonPressed: {
    opacity: 0.85,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 17,
    fontWeight: '600',
  },
});
