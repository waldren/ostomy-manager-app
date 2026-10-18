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

import { quickAddRoutineKey, type QuickAddDecision } from '@ostomy/core/sync';
import { Redirect, router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, View, type Text } from 'react-native';

import { useAuth } from '../src/auth/AuthContext';
import { useDatabaseState } from '../src/db/DatabaseProvider';
import { enqueueQuickAddDecision } from '../src/db/offlineWrites';
import type { LocalProfile } from '../src/db/repositories/profileRepository';
import { now as clockNow } from '../src/lib/utils/clock';
import { useProfileState } from '../src/onboarding/ProfileProvider';
import { withProfile } from '../src/onboarding/withProfile';
import type { QuickAddSuggestion } from '../src/quickadd/quickAddSuggestions';
import { describeQuickAdd, quickAddStatus } from '../src/quickadd/QuickAddWidgets';
import { useQuickAddSuggestions } from '../src/quickadd/useQuickAddSuggestions';
import { useSyncStatus } from '../src/sync/SyncProvider';
import { BodyText } from '../src/ui/BodyText';
import { Button } from '../src/ui/Button';
import { Heading } from '../src/ui/Heading';
import { Screen } from '../src/ui/Screen';

/** What the patient just did, for the announcement and focus that follow the re-read. */
type Action = 'kept' | 'unkept' | 'removed' | 'restored';

const SPOKEN = 'long';
const REMOVED_PREFIX = 'removed:';
const SECTION_SHOWN = 'section:shown';
const SECTION_REMOVED = 'section:removed';

const routineKeyOf = (suggestion: QuickAddSuggestion) => quickAddRoutineKey(suggestion.routine);

/**
 * Keeping and removing Quick-Add buttons (P4.S3 slice 5b, SRS §3.10, Epic 15
 * story 3), reached from Settings. On the home screen these are the buttons
 * under "Log again", and the copy says so.
 *
 * ## Here rather than on the dashboard
 *
 * The dashboard's buttons are one tap each, and that is their whole point. A
 * "remove" beside every one of them would be one mis-tap from taking a
 * patient's routine away; here, removing is a deliberate visit, and the screen
 * that removes is the screen that brings back.
 *
 * ## Nothing done here is a dead end (#149 review)
 *
 * A button whose decision the patient has just undone may no longer qualify
 * for the home screen — a kept routine that stopped, or a removed one brought
 * back before it recurs. It stays listed here, saying it has left the home
 * screen, with "Keep" and "Remove" still beside it, until the patient leaves.
 * Otherwise "Stop keeping" would make a button vanish with no way to undo it.
 *
 * ## For a screen-reader user
 *
 * Every action removes or moves the button that was pressed, so focus goes to
 * the row's heading (or, for a removal, to the item in the removed list), and
 * an announcement says what happened. Both wait for the list to be re-read, so
 * they describe what is now on screen rather than guessing. Labels name the
 * kind of entry and are spoken with units in full.
 *
 * None of this is verified on a device yet.
 */
function QuickAddScreen({ profile }: { readonly profile: LocalProfile }): React.JSX.Element {
  const { phase } = useAuth();
  const { t } = useTranslation(['common', 'mobile']);
  const database = useDatabaseState();
  const { isRunning, requestSync } = useSyncStatus();
  const { refresh } = useProfileState();
  const { suggestions, removed, reload } = useQuickAddSuggestions(database, isRunning);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retries, setRetries] = useState(0);
  /** Rows the patient just undid a decision on that no longer qualify (see above). */
  const [lingering, setLingering] = useState<ReadonlyMap<string, QuickAddSuggestion>>(new Map());

  const headingRefs = useRef(new Map<string, Text | null>());
  const pending = useRef<{ action: Action; suggestion: QuickAddSuggestion } | undefined>(undefined);

  /** Absent only on a phone set up before P4.S3, until it has been online once. */
  const serverId = profile.serverId;

  const focus = useCallback((key: string) => {
    const node = headingRefs.current.get(key);
    if (node !== null && node !== undefined)
      AccessibilityInfo.sendAccessibilityEvent(node, 'focus');
  }, []);

  // After the re-read that follows an action: say what happened, keep an
  // undone row listed if it has left the home screen, and put focus back.
  useEffect(() => {
    const done = pending.current;
    if (done === undefined || suggestions === undefined) return;
    pending.current = undefined;

    const key = routineKeyOf(done.suggestion);
    const onHome = suggestions.some((suggestion) => routineKeyOf(suggestion) === key);
    if ((done.action === 'unkept' || done.action === 'restored') && !onHome) {
      setLingering((current) => new Map(current).set(key, { ...done.suggestion, pinned: false }));
    }

    const announcement = {
      kept: 'common:quickAdd.announceKept',
      removed: 'common:quickAdd.announceRemoved',
      unkept: onHome ? 'common:quickAdd.announceUnkept' : 'common:quickAdd.announceUnkeptGone',
      restored: onHome
        ? 'common:quickAdd.announceRestoredShown'
        : 'common:quickAdd.announceRestoredLater',
    }[done.action];
    AccessibilityInfo.announceForAccessibility(t(announcement));
    // On the next frame, once the row is where it now belongs.
    setTimeout(() => {
      focus(done.action === 'removed' ? `${REMOVED_PREFIX}${key}` : key);
    }, 0);
  }, [suggestions, removed, t, focus]);

  // After "Try again": say whether it worked, because otherwise nothing changes
  // on screen when it does not.
  useEffect(() => {
    if (retries === 0) return;
    AccessibilityInfo.announceForAccessibility(
      t(serverId === undefined ? 'common:quickAdd.stillNoConnection' : 'common:quickAdd.connected'),
    );
  }, [retries, serverId, t]);

  const decide = useCallback(
    (suggestion: QuickAddSuggestion, decision: QuickAddDecision, action: Action) => {
      if (database.status !== 'ready' || serverId === undefined) return;
      setBusy(true);
      setFailed(false);
      void (async () => {
        try {
          await enqueueQuickAddDecision(
            database.executor,
            { profileServerId: serverId, routine: suggestion.routine, decision },
            clockNow,
          );
        } catch {
          setFailed(true);
          setBusy(false);
          return;
        }
        const key = routineKeyOf(suggestion);
        // A decision moves the row out of the lingering list; the effect above
        // puts it back if it is undone again and still does not qualify.
        setLingering((current) => {
          if (!current.has(key)) return current;
          const next = new Map(current);
          next.delete(key);
          return next;
        });
        pending.current = { action, suggestion };
        reload();
        setBusy(false);
        requestSync();
      })();
    },
    [database, reload, requestSync, serverId],
  );

  if (phase !== 'authenticated') return <Redirect href="/login" />;

  const labelled = (list: readonly QuickAddSuggestion[]) =>
    list.flatMap((suggestion) => {
      // A button this release cannot name is not offered, as on the dashboard.
      // A decision about one stays stored and syncs; it just cannot be changed
      // from this phone until the release can name it.
      const label = describeQuickAdd(suggestion, profile.measurementSystem, t);
      const spoken = describeQuickAdd(suggestion, profile.measurementSystem, t, SPOKEN);
      return label === undefined || spoken === undefined ? [] : [{ suggestion, label, spoken }];
    });
  const shownList = suggestions ?? [];
  const removedKeys = new Set(removed.map(routineKeyOf));
  const shownKeys = new Set(shownList.map(routineKeyOf));
  const stillListed = [...lingering.values()].filter((suggestion) => {
    const key = routineKeyOf(suggestion);
    return !shownKeys.has(key) && !removedKeys.has(key);
  });
  const shown = labelled([...shownList, ...stillListed]);
  const gone = labelled(removed);
  const canDecide = serverId !== undefined && !busy;
  const setRef = (key: string) => (node: Text | null) => {
    headingRefs.current.set(key, node);
  };

  return (
    <Screen>
      <Heading>{t('common:quickAdd.manageHeading')}</Heading>
      <BodyText>{t('common:quickAdd.manageIntro')}</BodyText>

      {serverId === undefined ? (
        <View>
          <BodyText tone="warning" live="polite">
            {t('common:quickAdd.needsConnectionBody')}
          </BodyText>
          <Button
            label={t('common:settings.retryButton')}
            variant="secondary"
            busy={retrying}
            disabled={retrying}
            onPress={() => {
              setRetrying(true);
              void refresh().finally(() => {
                setRetrying(false);
                setRetries((count) => count + 1);
              });
            }}
          />
        </View>
      ) : null}
      {failed ? (
        <BodyText tone="error" live="assertive">
          {t('common:quickAdd.saveFailed')}
        </BodyText>
      ) : null}

      <Heading level={2} ref={setRef(SECTION_SHOWN)}>
        {t('common:quickAdd.shownHeading')}
      </Heading>
      {suggestions !== undefined && shown.length === 0 ? (
        <BodyText>
          {gone.length > 0
            ? t('common:quickAdd.manageEmptyAllRemoved')
            : t('common:quickAdd.manageEmpty')}
        </BodyText>
      ) : null}
      {shown.map(({ suggestion, label, spoken }) => {
        const key = routineKeyOf(suggestion);
        const left = !shownKeys.has(key);
        return (
          <View key={key} style={{ gap: 8 }}>
            <Heading level={2} ref={setRef(key)} accessibilityLabel={spoken}>
              {label}
            </Heading>
            <BodyText tone="muted">
              {left ? t('common:quickAdd.leftHome') : quickAddStatus(suggestion, t)}
            </BodyText>
            {suggestion.pinned ? (
              <Button
                label={t('common:quickAdd.unkeepButton')}
                accessibilityLabel={t('common:quickAdd.unkeepSpoken', { label: spoken })}
                hint={t('common:quickAdd.unkeepHint')}
                variant="secondary"
                disabled={!canDecide}
                onPress={() => {
                  decide(suggestion, 'none', 'unkept');
                }}
              />
            ) : (
              <Button
                label={t('common:quickAdd.keepButton')}
                accessibilityLabel={t('common:quickAdd.keepSpoken', { label: spoken })}
                hint={t('common:quickAdd.keepHint')}
                variant="secondary"
                disabled={!canDecide}
                onPress={() => {
                  decide(suggestion, 'pinned', 'kept');
                }}
              />
            )}
            <Button
              label={t('common:quickAdd.removeButton')}
              accessibilityLabel={t('common:quickAdd.removeSpoken', { label: spoken })}
              hint={t('common:quickAdd.removeHint')}
              variant="secondary"
              disabled={!canDecide}
              onPress={() => {
                decide(suggestion, 'hidden', 'removed');
              }}
            />
          </View>
        );
      })}

      {gone.length === 0 ? null : (
        <>
          <Heading level={2} ref={setRef(SECTION_REMOVED)}>
            {t('common:quickAdd.removedHeading')}
          </Heading>
          <BodyText>{t('common:quickAdd.removedIntro')}</BodyText>
          {gone.map(({ suggestion, label, spoken }) => {
            const key = routineKeyOf(suggestion);
            return (
              <View key={key} style={{ gap: 8 }}>
                <Heading
                  level={2}
                  ref={setRef(`${REMOVED_PREFIX}${key}`)}
                  accessibilityLabel={spoken}
                >
                  {label}
                </Heading>
                <Button
                  label={t('common:quickAdd.restoreButton')}
                  accessibilityLabel={t('common:quickAdd.restoreSpoken', { label: spoken })}
                  hint={t('common:quickAdd.restoreHint')}
                  variant="secondary"
                  disabled={!canDecide}
                  onPress={() => {
                    decide(suggestion, 'none', 'restored');
                  }}
                />
              </View>
            );
          })}
        </>
      )}

      <Button
        label={t('mobile:navigation.backButton')}
        variant="secondary"
        onPress={() => {
          if (router.canGoBack()) router.back();
          else router.replace('/settings');
        }}
      />
    </Screen>
  );
}

export default withProfile(QuickAddScreen);
