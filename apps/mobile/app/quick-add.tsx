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

import type { QuickAddDecision } from '@ostomy/core/sync';
import { Redirect, router } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, View } from 'react-native';

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

const KEPT = 'common:quickAdd.announceKept';
const UNKEPT = 'common:quickAdd.announceUnkept';
const REMOVED = 'common:quickAdd.announceRemoved';
const RESTORED = 'common:quickAdd.announceRestored';

/**
 * Keeping and removing Quick-Add buttons (P4.S3 slice 5b, SRS §3.10, Epic 15
 * story 3), reached from Settings.
 *
 * ## Here rather than on the dashboard
 *
 * The dashboard's buttons are one tap each, and that is their whole point. A
 * "remove" beside every one of them would be one mis-tap from taking a
 * patient's routine away; here, removing is a deliberate visit, and the screen
 * that removes is the screen that brings back.
 *
 * ## What a decision is
 *
 * Keep: the button stays even when the patient stops logging that entry.
 * Remove: it stays off the home screen even if they log it again. Each is a
 * decision ABOUT a routine (`docs/sync-contract.md` §7.7), saved here first
 * and synced, so it follows the patient to their other devices. There is no
 * "edit": an edited button would log a number the patient never entered.
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

  /** Absent only on a phone set up before P4.S3, until it has been online once. */
  const serverId = profile.serverId;

  const decide = useCallback(
    (suggestion: QuickAddSuggestion, decision: QuickAddDecision, announcementKey: string) => {
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
        reload();
        setBusy(false);
        // Said what changed: the button the patient pressed has just gone.
        AccessibilityInfo.announceForAccessibility(t(announcementKey));
        requestSync();
      })();
    },
    [database, reload, requestSync, serverId, t],
  );

  if (phase !== 'authenticated') return <Redirect href="/login" />;

  const labelled = (list: readonly QuickAddSuggestion[]) =>
    list.flatMap((suggestion) => {
      // A button this release cannot name is not offered, as on the dashboard.
      const label = describeQuickAdd(suggestion, profile.measurementSystem, t);
      return label === undefined ? [] : [{ suggestion, label }];
    });
  const shown = labelled(suggestions ?? []);
  const gone = labelled(removed);
  const canDecide = serverId !== undefined && !busy;

  return (
    <Screen>
      <Heading>{t('common:quickAdd.manageHeading')}</Heading>
      <BodyText>{t('common:quickAdd.manageIntro')}</BodyText>

      {serverId === undefined ? (
        <View accessibilityLiveRegion="polite">
          <BodyText tone="error">{t('common:settings.needsConnectionBody')}</BodyText>
          <Button
            label={t('common:settings.retryButton')}
            variant="secondary"
            busy={retrying}
            disabled={retrying}
            onPress={() => {
              setRetrying(true);
              void refresh().finally(() => {
                setRetrying(false);
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

      {suggestions !== undefined && shown.length === 0 ? (
        <BodyText>{t('common:quickAdd.manageEmpty')}</BodyText>
      ) : null}
      {shown.map(({ suggestion, label }) => (
        <View key={suggestion.key} style={{ gap: 8 }}>
          <Heading level={2}>{label}</Heading>
          <BodyText tone="muted">{quickAddStatus(suggestion, t)}</BodyText>
          {suggestion.pinned ? (
            <Button
              label={t('common:quickAdd.unkeepButton')}
              accessibilityLabel={t('common:quickAdd.unkeepSpoken', { label })}
              hint={t('common:quickAdd.unkeepHint')}
              variant="secondary"
              disabled={!canDecide}
              onPress={() => {
                decide(suggestion, 'none', UNKEPT);
              }}
            />
          ) : (
            <Button
              label={t('common:quickAdd.keepButton')}
              accessibilityLabel={t('common:quickAdd.keepSpoken', { label })}
              hint={t('common:quickAdd.keepHint')}
              variant="secondary"
              disabled={!canDecide}
              onPress={() => {
                decide(suggestion, 'pinned', KEPT);
              }}
            />
          )}
          <Button
            label={t('common:quickAdd.removeButton')}
            accessibilityLabel={t('common:quickAdd.removeSpoken', { label })}
            hint={t('common:quickAdd.removeHint')}
            variant="secondary"
            disabled={!canDecide}
            onPress={() => {
              decide(suggestion, 'hidden', REMOVED);
            }}
          />
        </View>
      ))}

      {gone.length === 0 ? null : (
        <>
          <Heading level={2}>{t('common:quickAdd.removedHeading')}</Heading>
          <BodyText>{t('common:quickAdd.removedIntro')}</BodyText>
          {gone.map(({ suggestion, label }) => (
            <View key={suggestion.key} style={{ gap: 8 }}>
              <BodyText>{label}</BodyText>
              <Button
                label={t('common:quickAdd.restoreButton')}
                accessibilityLabel={t('common:quickAdd.restoreSpoken', { label })}
                hint={t('common:quickAdd.restoreHint')}
                variant="secondary"
                disabled={!canDecide}
                onPress={() => {
                  decide(suggestion, 'none', RESTORED);
                }}
              />
            </View>
          ))}
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
