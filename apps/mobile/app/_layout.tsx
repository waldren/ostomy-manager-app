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

// Side-effect import: initializes the single i18next instance
// (ADR-0006) before any screen renders and calls `useTranslation()`.
import '../src/i18n/i18n';

import { Stack } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AuthProvider } from '../src/auth/AuthContext';
import { DatabaseProvider } from '../src/db/DatabaseProvider';
import { SyncProvider } from '../src/sync/SyncProvider';

/**
 * Root layout (Expo Router). Everything under `app/` renders inside these
 * three providers — `AuthProvider` (checking/signedOut/locked/authenticated),
 * `DatabaseProvider` (the local `expo-sqlite` connection, opened and fully
 * migrated once here, never per-screen), and `SyncProvider` (the background
 * push/pull worker). `headerShown: false`: this sprint's two screens
 * (`login`, `home`) render their own headings, and a default React Navigation
 * header would either duplicate that or show a route's file name as a title —
 * not patient-facing copy from the catalog either way.
 *
 * `SyncProvider` is innermost of the three because it reads both of the
 * others, and it wraps the navigator rather than sitting beside it so a cycle
 * survives navigation: the worker must keep running while the patient moves
 * between screens, and an unmount mid-push would leave operations `in_flight`
 * until the next launch.
 */
export default function RootLayout(): React.JSX.Element {
  return (
    // `SafeAreaProvider` outermost: `src/ui/Screen` renders a
    // `SafeAreaView` and every screen goes through it, so without this the
    // insets resolve to zero and content renders under the notch and the
    // home indicator. It only looked fine before because every screen
    // centred its content and never reached the edges.
    <SafeAreaProvider>
      <AuthProvider>
        <DatabaseProvider>
          <SyncProvider>
            <Stack screenOptions={{ headerShown: false }} />
          </SyncProvider>
        </DatabaseProvider>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
