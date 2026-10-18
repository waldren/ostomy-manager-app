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

import { Directory, Paths } from 'expo-file-system';

/**
 * React Native's own HTTP disk cache: OkHttp's, which React Native creates in
 * the app's cache directory under this name.
 */
export const HTTP_CACHE_DIRECTORY_NAME = 'http-cache';

/**
 * Deletes React Native's HTTP disk cache (#152).
 *
 * Until the API sent `Cache-Control: no-store`, that cache held the profile,
 * the target ranges and every sync delta page in plain text: outside the
 * SQLCipher store (ADR-0014), outside its one-subject binding, and outside
 * `purgeLocalDatabase`. The API change stops new entries; it does nothing
 * about the ones a phone already has, so this removes them.
 *
 * Called from two places, for two different gaps:
 *
 * - **the purge**, because "this patient's data is no longer on this device"
 *   has to include every copy of it, not only the database;
 * - **every launch**, because a patient who updates and never signs out
 *   would otherwise keep the old entries indefinitely. With the API's
 *   `no-store` nothing is written back, so this is a no-op after the first.
 *
 * Never throws. It runs on the sign-out path and at startup, and a failure to
 * delete a cache must neither strand a patient signed in nor stop the app
 * opening; the next launch tries again.
 */
export function clearHttpCache(): void {
  try {
    const directory = new Directory(Paths.cache, HTTP_CACHE_DIRECTORY_NAME);
    if (directory.exists) directory.delete();
  } catch {
    // See above: retried on the next launch. Nothing is logged, because there
    // is nothing useful to say that does not describe what the files held.
  }
}
