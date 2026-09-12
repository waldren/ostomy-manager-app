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
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '../src/auth/AuthContext';

/**
 * The router's entry point. Reads `expo-secure-store` once
 * (`AuthProvider`'s mount effect) and redirects — this is a **local**
 * read, resolved in milliseconds, never a network wait: SRS §4.5's "a
 * spinner waiting on connectivity is a defect" does not apply to this
 * screen, because nothing here waits on connectivity.
 */
export default function Index(): React.JSX.Element {
  const { phase } = useAuth();
  const { t } = useTranslation('mobile');

  if (phase === 'checking') {
    return (
      <View style={styles.container}>
        <ActivityIndicator accessibilityLabel={t('common.loadingLabel')} />
        <Text style={styles.loadingText}>{t('common.loadingLabel')}</Text>
      </View>
    );
  }

  return <Redirect href={phase === 'authenticated' ? '/home' : '/login'} />;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  loadingText: {
    fontSize: 17,
  },
});
