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

import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useAuth } from '../src/auth/AuthContext';
import { useDatabaseState } from '../src/db/DatabaseProvider';
import { countByStatus } from '../src/db/repositories/syncQueueRepository';
import { tryCountUnsyncedEntries } from '../src/db/unsyncedCount';
import { useSyncStatus } from '../src/sync/SyncProvider';
import { BodyText } from '../src/ui/BodyText';
import { Button } from '../src/ui/Button';
import { Heading } from '../src/ui/Heading';
import { Screen } from '../src/ui/Screen';

/**
 * Home. Entry point to the Add Output screen and the correction inbox, plus
 * one honest signal about what has and has not been sent.
 *
 * ## Sign-out asks first when entries would be lost
 *
 * Sign-out purges the local database (ADR-0014) — file deleted, SQLCipher
 * key destroyed — so anything unsent goes with it. `AuthContext` has carried
 * a "KNOWN GAP" comment about this since P2.S2a, deferred until a sync
 * worker existed to make "wait and it will send" true advice. It does now.
 *
 * The prompt is a confirmation, not a block: a patient handing their phone
 * to someone else must always be able to sign out, immediately, and the
 * destructive option is right there. What changes is that they are told the
 * cost first, with a number rather than "you may lose data" — they cannot
 * see the queue, so a vague warning is not something they can act on.
 */
export default function Home(): React.JSX.Element {
  const { phase, signOut } = useAuth();
  const { t } = useTranslation(['mobile', 'common']);
  const database = useDatabaseState();
  const { lastRejected, lastStop, recoverStaleCursor } = useSyncStatus();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const params = useLocalSearchParams<{ saved?: string }>();

  const [pendingCount, setPendingCount] = useState<number | undefined>(undefined);
  const [rejectedCount, setRejectedCount] = useState(0);
  const [confirmingSignOut, setConfirmingSignOut] = useState<number | undefined | 'unknown'>(
    undefined,
  );

  const refreshCounts = useCallback(() => {
    if (database.status !== 'ready') return () => undefined;
    let cancelled = false;
    countByStatus(database.executor)
      .then((counts) => {
        // `rejected` counts too. A rejected operation is still an unsynced
        // entry the patient made — `docs/sync-contract.md` §9 keeps it
        // locally for correction rather than dropping it — so omitting it
        // would report "everything sent" while the patient's entries sat in
        // a correction inbox.
        if (cancelled) return;
        setPendingCount(counts.queued + counts.inFlight + counts.rejected);
        setRejectedCount(counts.rejected);
      })
      .catch(() => {
        // Leaves the count unknown rather than crashing the screen.
        if (!cancelled) setPendingCount(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [database]);

  // `lastRejected` in the dependency list is what refreshes these counts
  // after a sync cycle settles, without this screen polling.
  useEffect(() => refreshCounts(), [refreshCounts, lastRejected]);

  const beginSignOut = useCallback(async () => {
    if (database.status !== 'ready') {
      // No readable database means no way to know what would be lost.
      // "Unknown" is its own answer and must not render as zero.
      setConfirmingSignOut('unknown');
      return;
    }
    const unsynced = await tryCountUnsyncedEntries(database.executor);
    if (unsynced === 0) {
      // Nothing to lose; no prompt. A confirmation with nothing behind it
      // trains people to dismiss the one that matters.
      void signOut();
      return;
    }
    setConfirmingSignOut(unsynced ?? 'unknown');
  }, [database, signOut]);

  if (phase !== 'authenticated') {
    return <Redirect href="/login" />;
  }

  if (database.status === 'error') {
    return (
      <Screen>
        <Heading>{t('mobile:common.startupErrorHeading')}</Heading>
        <BodyText>{t('mobile:common.startupErrorBody')}</BodyText>
        <Button label={t('mobile:common.startupErrorButton')} onPress={() => void signOut()} />
      </Screen>
    );
  }

  if (confirmingSignOut !== undefined) {
    return (
      <Screen>
        <Heading>{t('mobile:signOut.unsyncedHeading')}</Heading>
        <BodyText tone="error">
          {confirmingSignOut === 'unknown'
            ? t('mobile:signOut.checkFailedBody')
            : t('mobile:signOut.unsyncedBody', { count: confirmingSignOut })}
        </BodyText>
        {/*
          The non-destructive option is first, so it is the one reached first
          by a screen reader and by a thumb. Sign-out remains available and
          unconditional — this is a confirmation, never a block.
        */}
        <Button
          label={t('mobile:signOut.waitButton')}
          onPress={() => {
            setConfirmingSignOut(undefined);
          }}
        />
        <Button
          label={t('mobile:signOut.confirmButton')}
          variant="destructive"
          hint={t('mobile:home.signOutHint')}
          onPress={() => void signOut()}
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <Heading>{t('mobile:home.welcomeHeading')}</Heading>

      {/*
        sync-contract §5.4. The scheduler halts entirely on a stale cursor, so
        without somewhere to act on it this device would simply stop syncing
        and never say why. It sits above the entry buttons because it affects
        what the rest of this screen is showing.
      */}
      {/*
        No patient record on the server (#80). Above the entry buttons for the
        same reason the stale-cursor notice is: it changes what everything below
        it means. Nothing is offered to tap, because there is nothing the
        patient can do from here — and offering a "try again" for a condition
        that does not resolve by trying is what the old `UNAUTHENTICATED`
        mapping effectively did.
      */}
      {lastStop?.kind === 'not-provisioned' ? (
        <View accessibilityLiveRegion="polite">
          <Heading level={2}>{t('common:notProvisioned.heading')}</Heading>
          <BodyText>{t('common:notProvisioned.body')}</BodyText>
          <BodyText tone="muted">{t('common:notProvisioned.contact')}</BodyText>
        </View>
      ) : null}

      {lastStop?.kind === 'cursor-too-old' ? (
        <View accessibilityLiveRegion="polite">
          <Heading level={2}>{t('common:staleSync.heading')}</Heading>
          <BodyText>{t('common:staleSync.body')}</BodyText>
          <BodyText tone="muted">{t('common:staleSync.keepsUnsent')}</BodyText>
          <Button
            label={refreshing ? t('common:staleSync.working') : t('common:staleSync.button')}
            busy={refreshing}
            onPress={() => {
              void (async () => {
                setRefreshing(true);
                setRefreshFailed(false);
                try {
                  await recoverStaleCursor();
                } catch {
                  setRefreshFailed(true);
                } finally {
                  setRefreshing(false);
                }
              })();
            }}
          />
          {refreshFailed ? <BodyText tone="error">{t('common:staleSync.failed')}</BodyText> : null}
        </View>
      ) : null}

      {params.saved === '1' ? (
        // §9.5: this confirms the LOCAL write, which has already committed.
        // `accessibilityLiveRegion` on the surrounding text is what makes it
        // announced rather than silently appearing above the fold.
        <BodyText tone="muted">{t('common:entry.savedConfirmation')}</BodyText>
      ) : null}

      <Button
        label={t('mobile:home.addOutputButton')}
        onPress={() => {
          router.push('/add-output');
        }}
      />

      <Button
        label={t('mobile:home.addIntakeButton')}
        onPress={() => {
          router.push('/add-intake');
        }}
      />

      <Button
        label={t('mobile:home.addUrineButton')}
        onPress={() => {
          router.push('/add-urine');
        }}
      />

      <Button
        label={t('mobile:home.addMealButton')}
        onPress={() => {
          router.push('/add-meal');
        }}
      />

      {rejectedCount > 0 ? (
        <>
          <BodyText tone="error">
            {t('mobile:home.correctionsCount', { count: rejectedCount })}
          </BodyText>
          <Button
            label={t('mobile:home.correctionsButton')}
            variant="secondary"
            onPress={() => {
              router.push('/corrections');
            }}
          />
        </>
      ) : null}

      {pendingCount !== undefined ? (
        <BodyText tone="muted">
          {pendingCount === 0
            ? t('mobile:home.pendingCountNone')
            : t('mobile:home.pendingCount', { count: pendingCount })}
        </BodyText>
      ) : null}

      <Button
        label={t('mobile:home.signOutButton')}
        onPress={() => void beginSignOut()}
        variant="destructive"
        hint={t('mobile:home.signOutHint')}
      />
    </Screen>
  );
}
