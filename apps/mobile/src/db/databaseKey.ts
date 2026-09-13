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

import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

/**
 * The SQLCipher key for the local clinical database (ADR-0014).
 *
 * ## Why the database is encrypted at all
 *
 * `apps/mobile` is the only offline-capable client, which makes it the one
 * place in this system where PHI rests on hardware nobody in the covered
 * entity controls. Every `observations` row and every `sync_queue.payload`
 * holds clinical values, and without SQLCipher they sit in a plain SQLite
 * file readable with `sqlite3` on a rooted device, a device handed to a
 * repair shop, or a forensic extraction.
 *
 * The consequence that decides it: encryption at rest per the HHS guidance
 * is the breach-notification safe harbour. A lost phone holding an
 * encrypted store is not a reportable breach; the same phone holding a
 * plaintext one is. Leaving it off converts every lost patient phone into
 * an incident-response event.
 *
 * ## Why the key lives in SecureStore, and NOT behind biometrics
 *
 * `expo-secure-store` puts it in the iOS keychain / Android keystore,
 * hardware-backed where available, so the key is not sitting in the same
 * sandbox as the file it protects.
 *
 * Deliberately WITHOUT `requireAuthentication`, unlike the refresh token
 * (`auth/tokenStorage.ts`) which sets it precisely for the OS invalidation
 * on biometric enrolment change. The asymmetry is the point: an
 * invalidated refresh token costs a re-login, and an invalidated database
 * key costs the patient every unsynced entry they have — permanently, with
 * no recovery path, because the ciphertext becomes undecryptable. A
 * patient who adds a fingerprint must not lose their diary.
 *
 * `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` for the same two reasons as the
 * token: the key must be readable while the device is locked in a pocket
 * (a background sync has to open the database), and it must never migrate
 * to another device through a backup — a migrated key alongside a migrated
 * database file would reconstitute the whole diary on someone else's
 * phone.
 */
const DATABASE_KEY_KEY = 'ostomy.db.key';

const DATABASE_KEY_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

/** 32 bytes, hex-encoded. SQLCipher takes a passphrase; this one is never human-typed. */
const KEY_BYTES = 32;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Returns the database key, generating and storing one on first run.
 *
 * Generated on the device from `expo-crypto`'s CSPRNG, never derived from
 * anything guessable — not the patient's subject, not the install id. A key
 * derived from an identifier an attacker can also obtain is not a key.
 *
 * This must be called before the database is first opened, and the same
 * value must be returned for the lifetime of the install: losing it means
 * the existing ciphertext can never be read again.
 */
export async function getOrCreateDatabaseKey(): Promise<string> {
  const existing = await SecureStore.getItemAsync(DATABASE_KEY_KEY, DATABASE_KEY_OPTIONS);
  if (existing) {
    return existing;
  }

  const key = toHex(Crypto.getRandomBytes(KEY_BYTES));
  await SecureStore.setItemAsync(DATABASE_KEY_KEY, key, DATABASE_KEY_OPTIONS);
  return key;
}

/**
 * Discards the key.
 *
 * Called only as part of destroying the database itself (see
 * `db/purge.ts`). Order matters and is the caller's responsibility: delete
 * the file first, then the key. Dropping the key while the file remains
 * leaves an undecryptable database that the next `getOrCreateDatabaseKey`
 * will generate a fresh, non-matching key for, and SQLCipher reports that
 * as a generic "file is not a database" error rather than anything that
 * names the cause.
 */
export async function clearDatabaseKey(): Promise<void> {
  await SecureStore.deleteItemAsync(DATABASE_KEY_KEY, DATABASE_KEY_OPTIONS);
}
