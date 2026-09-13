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

import { useAuth } from '../src/auth/AuthContext';
import { useDatabaseState } from '../src/db/DatabaseProvider';
import { countByStatus } from '../src/db/repositories/syncQueueRepository';
import { BodyText } from '../src/ui/BodyText';
import { Button } from '../src/ui/Button';
import { Heading } from '../src/ui/Heading';
import { Screen } from '../src/ui/Screen';

/**
 * The placeholder home screen this sprint's exit criteria calls for.
 * Deliberately not the Add Output screen — what it renders beyond a welcome
 * message is one honest signal that the local database and sync queue are
 * real and live.
 */
export default function Home(): React.JSX.Element {
  const { phase, signOut } = useAuth();
  const { t } = useTranslation('mobile');
  const database = useDatabaseState();
  const [pendingCount, setPendingCount] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (database.status !== 'ready') return;
    let cancelled = false;
    countByStatus(database.executor)
      .then((counts) => {
        // `rejected` counts too. A rejected operation is still an unsynced
        // entry the patient made — `docs/sync-contract.md` §9 keeps it
        // locally for correction rather than dropping it — so omitting it
        // would report "everything sent" while the patient's entries sat in
        // a correction inbox.
        if (!cancelled) setPendingCount(counts.queued + counts.inFlight + counts.rejected);
      })
      .catch(() => {
        // Leaves the count unknown rather than crashing the screen. The
        // previous code had no catch at all, so a purge-invalidated
        // executor produced an unhandled rejection and the line silently
        // vanished with no indication anything had gone wrong.
        if (!cancelled) setPendingCount(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [database]);

  if (phase !== 'authenticated') {
    return <Redirect href="/login" />;
  }

  if (database.status === 'error') {
    return (
      <Screen>
        <Heading>{t('common.startupErrorHeading')}</Heading>
        <BodyText>{t('common.startupErrorBody')}</BodyText>
        <Button label={t('common.startupErrorButton')} onPress={() => void signOut()} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Heading>{t('home.welcomeHeading')}</Heading>
      <BodyText>{t('home.placeholderBody')}</BodyText>

      {pendingCount !== undefined ? (
        <BodyText tone="muted">
          {pendingCount === 0
            ? t('home.pendingCountNone')
            : t('home.pendingCount', { count: pendingCount })}
        </BodyText>
      ) : null}

      <Button
        label={t('home.signOutButton')}
        onPress={() => void signOut()}
        variant="destructive"
        hint={t('home.signOutHint')}
      />
    </Screen>
  );
}
