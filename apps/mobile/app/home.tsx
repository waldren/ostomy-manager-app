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
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '../src/auth/AuthContext';
import { useDatabase } from '../src/db/DatabaseProvider';
import { countByStatus } from '../src/db/repositories/syncQueueRepository';

/**
 * The placeholder home screen this sprint's exit criteria calls for.
 * Deliberately not the Add Output screen (P2.S2b, out of scope here) —
 * what it renders beyond a welcome message is one honest signal that the
 * local database and sync queue this sprint built are real and live: the
 * number of locally-queued entries still waiting to sync, read from the
 * same `sync_queue` table `docs/sync-contract.md` describes.
 */
export default function Home(): React.JSX.Element {
  const { phase, signOut } = useAuth();
  const { t } = useTranslation('mobile');
  const executor = useDatabase();
  const [queuedCount, setQueuedCount] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (!executor) return;
    let cancelled = false;
    countByStatus(executor).then((counts) => {
      if (!cancelled) setQueuedCount(counts.queued + counts.inFlight);
    });
    return () => {
      cancelled = true;
    };
  }, [executor]);

  if (phase !== 'authenticated') {
    return <Redirect href="/login" />;
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title} accessibilityRole="header">
        {t('home.title')}
      </Text>
      <Text style={styles.heading}>{t('home.welcomeHeading')}</Text>
      <Text style={styles.body}>{t('home.placeholderBody')}</Text>
      {queuedCount !== undefined ? (
        <Text style={styles.body}>{t('home.queuedCountLabel', { count: queuedCount })}</Text>
      ) : null}
      <Pressable
        onPress={signOut}
        accessibilityRole="button"
        accessibilityLabel={t('home.signOutButton')}
        style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
      >
        <Text style={styles.buttonText}>{t('home.signOutButton')}</Text>
      </Pressable>
    </View>
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
  button: {
    minHeight: 52,
    borderRadius: 12,
    backgroundColor: '#5c1c1c',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
    marginTop: 16,
  },
  buttonPressed: {
    opacity: 0.85,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 17,
    fontWeight: '600',
  },
});
