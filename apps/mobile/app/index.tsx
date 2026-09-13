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
import { ActivityIndicator } from 'react-native';

import { useAuth } from '../src/auth/AuthContext';
import { BodyText } from '../src/ui/BodyText';
import { Screen } from '../src/ui/Screen';

/** Routes to the right screen once the auth phase is known. */
export default function Index(): React.JSX.Element {
  const { phase } = useAuth();
  const { t } = useTranslation('mobile');

  if (phase === 'checking') {
    return (
      <Screen>
        {/*
          The indicator is hidden from assistive technology and the text
          carries the name. Both used to expose the same string, so
          VoiceOver read "Loading your diary" twice.
        */}
        <ActivityIndicator accessible={false} importantForAccessibility="no" />
        <BodyText>{t('common.loadingLabel')}</BodyText>
      </Screen>
    );
  }

  return <Redirect href={phase === 'authenticated' ? '/home' : '/login'} />;
}
