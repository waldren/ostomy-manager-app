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

import * as SecureStore from 'expo-secure-store';

/**
 * Which patient the local database belongs to.
 *
 * ## The defect this exists to prevent
 *
 * Nothing in the local schema is scoped to a patient: `observations`,
 * `sync_queue` and `sync_cursor` have no subject column, and `sync_cursor`
 * is a hardcoded single row. That is a reasonable design for a single-user
 * device — but only if the app enforces that the device really is
 * single-user, which it previously did not.
 *
 * Without this, on a shared, handed-down, or clinic-issued phone:
 *
 * 1. Patient A signs out. Their entire diary stays on disk — "sign out" is
 *    the affordance a patient uses precisely when they want their data off
 *    a device.
 * 2. Patient B signs in. `listObservationsByCode` filters on LOINC code
 *    only, so B's history screen renders A's entries. A direct
 *    patient-to-patient PHI disclosure.
 * 3. The sync worker drains A's leftover `sync_queue` rows using B's
 *    token. The server takes `patientId` and `actorId` from the OIDC
 *    subject of the presented token and NEVER from the payload
 *    (`docs/sync-contract.md` 2) — correctly, since that is the field
 *    that would otherwise carry the attack. So A's clinical values are
 *    written into B's record, and the audit row names B as the author of
 *    an entry B never made.
 *
 * The third is the one that decides the design. An audit log is supposed
 * to be the authoritative reconstruction of who did what; a false entry in
 * it is worse than a missing one, because nothing downstream has any
 * reason to doubt it, and ADR-0011 makes the table append-only by grant so
 * it cannot be corrected afterwards either.
 *
 * ## Why the subject is stored, rather than a column added
 *
 * Adding a subject column to each table would fix the read path and leave
 * the data on disk — it hides A's diary from B rather than removing it,
 * and does nothing for exposure 1. Owning the whole database by subject
 * and destroying it on a change is what actually satisfies "sign out means
 * my data is gone".
 *
 * Stored in `expo-secure-store` rather than the database itself, because
 * it has to be readable BEFORE the database is opened: the decision it
 * drives is whether to open that file at all.
 *
 * The value is an opaque OIDC subject identifier, not a name, MRN, or
 * anything else that describes the patient.
 */
const DATABASE_OWNER_KEY = 'ostomy.db.ownerSubject';

const OWNER_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

export async function getDatabaseOwner(): Promise<string | null> {
  return SecureStore.getItemAsync(DATABASE_OWNER_KEY, OWNER_OPTIONS);
}

export async function setDatabaseOwner(subject: string): Promise<void> {
  await SecureStore.setItemAsync(DATABASE_OWNER_KEY, subject, OWNER_OPTIONS);
}

export async function clearDatabaseOwner(): Promise<void> {
  await SecureStore.deleteItemAsync(DATABASE_OWNER_KEY, OWNER_OPTIONS);
}
