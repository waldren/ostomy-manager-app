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
import type { LocalProfile } from '../src/db/repositories/profileRepository';
import { withProfile } from '../src/onboarding/withProfile';
import { useDatabaseState } from '../src/db/DatabaseProvider';
import { countByStatus } from '../src/db/repositories/syncQueueRepository';
import { tryCountUnsyncedEntries } from '../src/db/unsyncedCount';
import { useCachedThresholds } from '../src/entry/useCachedThresholds';
import { deviceTimeZone, now as clockNow } from '../src/lib/utils/clock';
import { decideQuickAdd } from '../src/quickadd/quickAddAction';
import { draftHrefFor } from '../src/quickadd/draftParams';
import { logQuickAdd } from '../src/quickadd/logQuickAdd';
import { QuickAddWidgets } from '../src/quickadd/QuickAddWidgets';
import { useQuickAddSuggestions } from '../src/quickadd/useQuickAddSuggestions';
import type { QuickAddSuggestion } from '../src/quickadd/quickAddSuggestions';
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
 *
 * ## Quick-Add (P3.S4, SRS §3.1)
 *
 * Above the four entry buttons, because a shortcut below them is a shortcut to
 * scroll to. It renders nothing at all when there is nothing to suggest, so a
 * patient on their first day meets exactly the screen they met before.
 *
 * A tap either logs or opens the draft — `decideQuickAdd` owns that choice and
 * `quickAddAction.ts` has the reasoning. The two paths converge on the same
 * confirmation this screen already shows for a form save (`?saved=1`), because
 * a patient has no way to tell which code path saved their entry and should not
 * be shown two different confirmations for one outcome.
 */
function HomeScreen({ profile }: { readonly profile: LocalProfile }): React.JSX.Element {
  const { phase, signOut } = useAuth();
  const { t } = useTranslation(['mobile', 'common']);
  const database = useDatabaseState();
  const { isRunning, lastRejected, lastStop, recoverStaleCursor, requestSync } = useSyncStatus();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const params = useLocalSearchParams<{ saved?: string }>();

  const cachedThresholds = useCachedThresholds(database);
  const { suggestions, reload: reloadSuggestions } = useQuickAddSuggestions(database);
  // Destructured so the callbacks below depend on these VALUES rather than on
  // `profile`, whose identity the gate controls.
  const { measurementSystem, surgeryDate } = profile;

  const [pendingCount, setPendingCount] = useState<number | undefined>(undefined);
  const [quickAddFailed, setQuickAddFailed] = useState(false);
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

  // `isRunning` is what refreshes these counts after a sync cycle settles,
  // without this screen polling: it is set in the cycle's `finally`, so it
  // falls back to `false` once per cycle whatever the outcome.
  //
  // `lastRejected` alone was the dependency and it was not enough. It changes
  // only when a cycle parks something for correction, so the ordinary case —
  // a clean push — left the count frozen at whatever it was when the entry
  // was saved. An emulator pass for #122 found the home screen still reading
  // "1 entry has not been sent yet" minutes after the row was on the server,
  // and it never cleared: nothing else remounts this screen. That is the
  // worst direction for this particular message to be wrong in, because a
  // patient reads it as "my care team does not have this", and a patient who
  // learns it is meaningless will ignore it on the day it is true.
  //
  // `lastRejected` stays in the list: it is cumulative-per-cycle rather than
  // a toggle, so it also moves on a cycle whose rejection count changes, and
  // dropping it would narrow what triggers a refresh for no gain.
  useEffect(() => refreshCounts(), [refreshCounts, isRunning, lastRejected]);

  /**
   * Opens the entry form for a suggestion, pre-filled.
   *
   * Epic 3's second Quick-Add story, and also the fallback for a tap that does
   * not validate cleanly — which is why it is one function rather than two.
   */
  const openDraft = useCallback(
    (suggestion: QuickAddSuggestion) => {
      const href = draftHrefFor(suggestion, measurementSystem);
      // `undefined` means the code has no entry screen, which cannot happen
      // for the three codes `QUICK_ADD_CODES` generates over. Doing nothing is
      // the right answer anyway: navigating to a route that does not exist
      // would leave the patient on a blank screen.
      if (href !== undefined) router.push(href);
    },
    [measurementSystem],
  );

  const onQuickAdd = useCallback(
    async (suggestion: QuickAddSuggestion) => {
      if (database.status !== 'ready') return;

      const decision = decideQuickAdd({
        suggestion,
        thresholds: cachedThresholds?.thresholds ?? null,
        // No local profile table yet, so no surgery date to bound against —
        // the same position every entry screen is in until P4.S1.
        surgeryDate,
        enteredTimezone: deviceTimeZone(),
        now: clockNow(),
      });

      if (decision.kind === 'open-draft') {
        openDraft(suggestion);
        return;
      }

      setQuickAddFailed(false);
      try {
        await logQuickAdd(database.executor, suggestion, measurementSystem, clockNow);
      } catch {
        // The local write IS the save, so a failure here means nothing was
        // recorded. Said plainly rather than swallowed — and the patient is
        // left on this screen with the entry buttons, not sent to a
        // confirmation for something that did not happen.
        setQuickAddFailed(true);
        return;
      }

      // Committed. Ask the worker to run and never wait on it (§9.5), then
      // re-read the suggestions so the repeat count behind the widget matches
      // the diary the patient just added to.
      requestSync();
      reloadSuggestions();
      refreshCounts();
      router.replace('/home?saved=1');
    },
    [
      database,
      cachedThresholds,
      measurementSystem,
      surgeryDate,
      openDraft,
      requestSync,
      reloadSuggestions,
      refreshCounts,
    ],
  );

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
        it means.

        P4.S1 makes this actionable, which it deliberately was not before: there
        was no onboarding screen, so a "try again" would have been an offer for a
        condition that does not resolve by trying. Now there is one, and reaching
        this state while the device HOLDS a profile means the server lost it — a
        development reset, or an ADR-0017 purge — so re-provisioning is exactly
        the fix. `again=1` is what keeps the onboarding route from bouncing
        straight back here, and it pre-fills from the local row so the patient
        confirms rather than retypes.
      */}
      {lastStop?.kind === 'not-provisioned' ? (
        <View accessibilityLiveRegion="polite">
          <Heading level={2}>{t('common:notProvisioned.heading')}</Heading>
          <BodyText>{t('common:notProvisioned.body')}</BodyText>
          <BodyText tone="muted">{t('common:notProvisioned.contact')}</BodyText>
          <Button
            label={t('common:notProvisioned.finishSetupButton')}
            onPress={() => {
              router.push('/onboarding?again=1');
            }}
          />
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

      {quickAddFailed ? (
        <BodyText tone="error">{t('mobile:home.quickAddFailedBody')}</BodyText>
      ) : null}

      {params.saved === '1' ? (
        // §9.5: this confirms the LOCAL write, which has already committed.
        // `accessibilityLiveRegion` on the surrounding text is what makes it
        // announced rather than silently appearing above the fold.
        <BodyText tone="muted">{t('common:entry.savedConfirmation')}</BodyText>
      ) : null}

      <QuickAddWidgets
        suggestions={suggestions}
        measurementSystem={measurementSystem}
        onLog={(suggestion) => {
          void onQuickAdd(suggestion);
        }}
        onEdit={openDraft}
      />

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
        <BodyText
          tone="muted"
          // Announced, because this line now changes WHILE the screen is open.
          // Before the refresh fix above it was frozen after mount, so there
          // was nothing to announce; a sync cycle completing is an async status
          // change and a screen-reader user would otherwise never learn their
          // entries went out. `polite` on purpose — urgency in this app is
          // reserved for the red-flag prompt.
          live="polite"
        >
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

/**
 * The profile arrives as a prop, never read inside — see `withProfile`. Two
 * fields come off it, and a fallback for either would be worse than not
 * rendering: `measurementSystem` is what every amount is rendered AND recorded
 * as (ADR-0012, permanent per row), and `surgeryDate` is the Tier 1 lower bound
 * that silently stops applying when it is absent.
 */
export default withProfile(HomeScreen);
