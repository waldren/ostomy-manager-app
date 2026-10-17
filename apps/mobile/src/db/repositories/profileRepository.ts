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

import type { ApiClient } from '@ostomy/core/api-client';
import type { MeasurementSystem } from '@ostomy/core/units';

import type { SqliteExecutor } from '../executor';

/**
 * The patient's own profile, as this device knows it (P4.S1, SRS §3.0).
 *
 * Three fields, because SRS §3.0 makes exactly three mandatory and says why in
 * the same bullet: "a newly discharged patient may be setting the app up in a
 * hospital bed; a long mandatory setup flow is where they abandon it."
 *
 * Written once, by provisioning, from the server's response — never assembled
 * from what the patient typed. Two of these are read on paths with no network
 * available, which is why they rest here at all: `surgeryDate` is the Tier 1
 * lower bound every offline entry is checked against, and `measurementSystem`
 * decides what every amount on every screen renders as.
 */
export interface LocalProfile {
  readonly ostomyType: OstomyType;
  /**
   * `YYYY-MM-DD`. A calendar date, not an instant — the column is `@db.Date`
   * server-side and the wire carries ten characters.
   *
   * Kept as that string rather than a `Date`, because a `Date` here would be an
   * instant at UTC midnight that every reader then has to remember not to shift
   * into its own zone. Callers that need the Tier 1 bound convert once, at the
   * point of use, where the intent is visible.
   */
  readonly surgeryDate: string;
  readonly measurementSystem: MeasurementSystem;
  /**
   * The server's `Profile.id`: the `entityId` a sync edit names
   * (`docs/sync-contract.md` §7.5). Absent on a row written before P4.S3, when
   * the server published no id, until `ProfileProvider` fetches it once. Never
   * the patient's id, and never placed in a URL, a log or analytics (§7.5).
   */
  readonly serverId?: string;
}

/**
 * v1 covers colostomy and ileostomy only — urostomy was cut in SRS Phase 4
 * Appendix A, because a urostomy's stoma output IS urine and that is a different
 * data model rather than a third enum value.
 *
 * The TYPE comes from the generated client, which is generated from the API's own
 * zod schema, so there is one definition of what the server will accept and this
 * app cannot store a value it would refuse.
 *
 * The ARRAY's only job is the runtime row-parse guard below — a list of strings
 * to test an unknown column against. It is deliberately NOT what the onboarding
 * screen iterates: `satisfies` catches a misspelt member but not a missing one,
 * so an array is the wrong thing to drive "which choices does the patient see".
 * That screen builds its choices from a `Record<OstomyType, …>` of label keys,
 * where a type the server accepts and the screen does not offer fails to compile.
 */
export type OstomyType = Parameters<ApiClient['onboarding']['provision']>[0]['ostomyType'];
export const OSTOMY_TYPES = ['colostomy', 'ileostomy'] as const satisfies readonly OstomyType[];

interface ProfileRawRow {
  ostomy_type: string;
  surgery_date: string;
  measurement_system: string;
  fetched_at: string;
  server_id: string | null;
  client_updated_at: string | null;
}

function isOstomyType(value: string): value is OstomyType {
  return (OSTOMY_TYPES as readonly string[]).includes(value);
}

function isMeasurementSystem(value: string): value is MeasurementSystem {
  return value === 'metric' || value === 'imperial';
}

/**
 * The profile, or `undefined` when this device has none.
 *
 * `undefined` is load-bearing: it is what routes a signed-in patient to
 * onboarding rather than the dashboard, so it must mean exactly "no profile
 * here" and never "a row I could not make sense of". A row whose enums do not
 * parse is therefore treated as no row at all, the same decision
 * `thresholdsRepository` makes about an unparseable number and for the same
 * reason — the alternative is a profile with a silently wrong measurement
 * system, which renders every amount in the app in the wrong units with nothing
 * reporting it.
 *
 * The CHECK constraints in migration 8 make that state unreachable through this
 * app's own writes. This is the branch for the row that arrived some other way:
 * a hand-edited database, or a future migration that widened an enum this build
 * predates.
 */
export async function readProfile(executor: SqliteExecutor): Promise<LocalProfile | undefined> {
  const rows = await executor.getAllAsync<ProfileRawRow>('SELECT * FROM profiles WHERE id = 1;');
  const row = rows[0];
  if (row === undefined) return undefined;
  if (!isOstomyType(row.ostomy_type)) return undefined;
  if (!isMeasurementSystem(row.measurement_system)) return undefined;

  return {
    ostomyType: row.ostomy_type,
    surgeryDate: row.surgery_date,
    measurementSystem: row.measurement_system,
    ...(row.server_id === null ? {} : { serverId: row.server_id }),
  };
}

/**
 * When this device last EDITED its profile, or `null` when the row is the
 * server's version (migration 9). What a delta change is compared against.
 */
export async function readProfileClientUpdatedAt(
  executor: SqliteExecutor,
): Promise<string | null | undefined> {
  const rows = await executor.getAllAsync<Pick<ProfileRawRow, 'client_updated_at'>>(
    'SELECT client_updated_at FROM profiles WHERE id = 1;',
  );
  return rows[0] === undefined ? undefined : rows[0].client_updated_at;
}

/**
 * Replaces this device's copy with what the server returned.
 *
 * An upsert on the single row rather than an insert, because the same patient
 * re-provisioning — after a server-side purge, or a development reset — must not
 * fail on a primary-key collision and leave the device holding the old profile
 * while the server holds the new one.
 *
 * Takes the profile and the fetch time; never a value a screen composed. The
 * server is what decides whether a surgery date is acceptable, so writing the
 * patient's answer here before it has been accepted would put an unvalidated
 * Tier 1 bound on the device.
 */
export async function writeProfile(
  executor: SqliteExecutor,
  profile: LocalProfile,
  fetchedAt: string,
  clientUpdatedAt: string | null = null,
): Promise<void> {
  // `server_id` is kept when the incoming profile carries none, so a write from
  // an older-shaped source can never erase an id this device has learned.
  // `client_updated_at` is the server's version stamp when there is one (a delta
  // change), and NULL otherwise: a server-sourced row, which any later delta
  // change for it may replace.
  await executor.runAsync(
    `INSERT INTO profiles
       (id, ostomy_type, surgery_date, measurement_system, fetched_at, server_id, client_updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       ostomy_type = excluded.ostomy_type,
       surgery_date = excluded.surgery_date,
       measurement_system = excluded.measurement_system,
       fetched_at = excluded.fetched_at,
       server_id = COALESCE(excluded.server_id, profiles.server_id),
       client_updated_at = excluded.client_updated_at;`,
    [
      profile.ostomyType,
      profile.surgeryDate,
      profile.measurementSystem,
      fetchedAt,
      profile.serverId ?? null,
      clientUpdatedAt,
    ],
  );
}

/**
 * The patient's own edit (P4.S3), written to this device before it is sent.
 *
 * Unlike `writeProfile`, this is a value the patient composed on a screen —
 * which that function's comment refuses for provisioning, and the difference is
 * the point. Provisioning is ONLINE and the server is right there to decide; an
 * edit is offline-first like every entry, so the device holds it as the
 * patient's current answer (§9.5: the local write IS the confirmation) and the
 * server re-validates it when it is pushed. The screen applies the same
 * surgery-date rules first, from `surgeryDateParts.ts`.
 *
 * Only ever called by `enqueueProfileUpdate`, in the transaction that queues
 * the operation, so a row edited here always has its push queued.
 */
export async function updateProfileLocally(
  executor: SqliteExecutor,
  fields: Pick<LocalProfile, 'ostomyType' | 'surgeryDate' | 'measurementSystem'>,
  clientUpdatedAt: string,
): Promise<void> {
  await executor.runAsync(
    `UPDATE profiles SET
       ostomy_type = ?, surgery_date = ?, measurement_system = ?, client_updated_at = ?
     WHERE id = 1;`,
    [fields.ostomyType, fields.surgeryDate, fields.measurementSystem, clientUpdatedAt],
  );
}
