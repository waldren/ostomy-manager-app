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

/**
 * Local database schema (P2.S2a). Additive, numbered migrations only —
 * `./migrations.ts` tracks the applied version in `schema_migrations`, the
 * same discipline `apps/api/prisma/migrations` uses server-side, so a
 * later sprint adds a migration rather than editing one of these in place.
 *
 * Deliberately partial, matching the slice this sprint scaffolds:
 * `observations` (mirroring `apps/api/prisma/schema.prisma`'s
 * `Observation` model and `docs/sync-contract.md` §7.2's wire payload) and
 * the sync bookkeeping tables (`sync_queue`, `sync_cursor`). No local
 * `profiles` table yet — v1's mobile write path only ever handles
 * `Observation` (docs/sync-contract.md §7.2: "The only entity type P2
 * exchanges"), and adding one speculatively would be exactly the
 * unexercised-migration-path risk `docs/sync-contract.md` and
 * `apps/api/prisma/schema.prisma` both warn against.
 *
 * No Add Output screen or sync worker consumes this schema yet — that is
 * P2.S2b's job, deliberately left out of this sprint. See
 * `apps/mobile/README.md` "Architecture notes for the next sprint" for the
 * seam this schema is designed to hand off cleanly.
 */

/**
 * Migration 1 — `observations` and the sync bookkeeping tables.
 *
 * Numeric-precision note (mirrors `apps/api/prisma/schema.prisma`'s own
 * "Numeric precision (ADR-0005)" comment, adapted to SQLite): the canonical
 * value is stored as `TEXT`, not `REAL`. SQLite's `REAL` is an IEEE-754
 * double, same as a JSON number — the DECIMAL(12,4) values this column
 * holds (at most 12 significant digits) are almost always exactly
 * representable and round-trip cleanly in practice, but "almost always" is
 * not the standard ADR-0005 sets for a value that feeds a summed Daily Net
 * Fluid Balance. Storing the decimal string exactly as entered/received
 * removes the question entirely: no binary rounding step exists between
 * "what the server or patient wrote" and "what this column holds." The
 * wire payload's `valueQuantity.value` is a JSON number (§7.3) — converting
 * to and from that number at the wire boundary, not at rest, is the sync
 * worker's job (P2.S2b), matching the same string-at-rest /
 * number-on-the-wire split `ServerSequence` already uses for the same
 * reason (§7.3).
 *
 * `entered_measurement_system` and `value_quantity_unit` are constrained
 * with `CHECK`, mirroring the server schema's own CHECK constraints
 * (`p1-s3-schema-coverage.md`) — belt-and-suspenders, since every write
 * path in this app is expected to go through `../units`
 * (`@ostomy/core/units`) and `../validation`, never write these columns by
 * hand, but a schema-level constraint fails loudly in a test rather than
 * producing a row this app cannot make sense of later.
 */
const MIGRATION_1_INITIAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY NOT NULL,
  resource_type TEXT NOT NULL DEFAULT 'Observation',
  code TEXT NOT NULL,
  value_quantity_value TEXT NOT NULL,
  value_quantity_unit TEXT NOT NULL CHECK (value_quantity_unit IN ('mL', 'kg')),
  effective_datetime TEXT NOT NULL,
  method TEXT,
  status TEXT NOT NULL DEFAULT 'final',
  entered_measurement_system TEXT NOT NULL CHECK (entered_measurement_system IN ('metric', 'imperial')),
  client_updated_at TEXT NOT NULL,
  server_sequence TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_observations_code_effective
  ON observations (code, effective_datetime);

CREATE INDEX IF NOT EXISTS idx_observations_deleted_at
  ON observations (deleted_at);

CREATE TABLE IF NOT EXISTS sync_queue (
  local_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL UNIQUE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation_type TEXT NOT NULL CHECK (operation_type IN ('create', 'update', 'delete')),
  client_timestamp TEXT NOT NULL,
  payload TEXT,
  enqueued_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'in_flight', 'rejected')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempted_at TEXT,
  rejected_reason_code TEXT,
  rejected_field TEXT,
  rejected_at TEXT,
  CHECK (
    (operation_type = 'delete' AND payload IS NULL) OR
    (operation_type != 'delete' AND payload IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_sync_queue_status
  ON sync_queue (status, local_seq);

CREATE INDEX IF NOT EXISTS idx_sync_queue_entity
  ON sync_queue (entity_type, entity_id);

CREATE TABLE IF NOT EXISTS sync_cursor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cursor TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/**
 * `docs/sync-contract.md` §5.1: "`since=0` requests everything — the
 * initial sync of a newly installed or reinstalled app." Seeding this row
 * at migration time, rather than leaving the table empty and having every
 * reader special-case "no row yet," means "no cursor yet" and "cursor is
 * 0" are the same state everywhere this is read.
 *
 * Built with a template literal rather than a bound parameter because
 * `SqliteExecutor.execAsync` (used for DDL/multi-statement batches, unlike
 * `runAsync`) accepts no bind parameters at all — this is `expo-sqlite`'s
 * own API split, not a choice made here. Safe regardless: `seededAt` is
 * this app's own ISO-8601 clock reading (`../lib/utils/clock.ts`), never
 * user input, so there is nothing to inject.
 */
function seedInitialSyncCursor(seededAt: string): string {
  return `INSERT OR IGNORE INTO sync_cursor (id, cursor, updated_at) VALUES (1, '0', '${seededAt}');`;
}

export interface SchemaMigration {
  readonly version: number;
  readonly description: string;
  readonly sql: (params: { seededAt: string }) => string;
}

/**
 * Migration 7: voided urine, and the first local row that may carry no
 * volume.
 *
 * AC 12.1 AC2 lets a patient who cannot measure save a COLOUR ALONE, so
 * `value_quantity_value` and `value_quantity_unit` stop being NOT NULL.
 * SQLite cannot relax a NOT NULL in place, and cannot drop a column a CHECK
 * references, so the table is recreated — the same approach migration 2
 * took and for the same reason.
 *
 * ## What the recreation must not lose
 *
 * Every column and both indexes, copied explicitly rather than by
 * `SELECT *`, so a future column added above this migration cannot be
 * silently dropped by it. `id` is the sync entity id and `server_sequence`
 * the delta cursor's anchor: regenerating or omitting either would make
 * this device re-pull rows it already has, or worse, push rows the server
 * would treat as new (`docs/sync-contract.md` §3.7).
 *
 * ## The CHECK constraints come too
 *
 * Mirroring the server's, as migration 1's comment explains: every write
 * path here is expected to go through `@ostomy/core`, but a schema-level
 * constraint fails loudly in a test rather than producing a row this app
 * cannot later make sense of. The value/unit pairing and the
 * urine-colour-only rule are both expressed, so a local row cannot reach a
 * state the server would refuse.
 */
const MIGRATION_7_VOIDED_URINE = `
CREATE TABLE observations_new (
  id TEXT PRIMARY KEY NOT NULL,
  resource_type TEXT NOT NULL DEFAULT 'Observation',
  code TEXT NOT NULL,
  -- Nullable since P3.S2. NULL means the entry recorded a colour instead of
  -- an amount; it does NOT mean a void of zero, and anything summing these
  -- must skip it rather than coerce it.
  value_quantity_value TEXT,
  value_quantity_unit TEXT CHECK (value_quantity_unit IS NULL OR value_quantity_unit IN ('mL', 'kg')),
  -- The chosen step of the pale-to-dark scale, as a urine_color value-set
  -- member code. Never display text: the label comes from the i18n catalog.
  urine_color_code TEXT,
  effective_datetime TEXT NOT NULL,
  method TEXT,
  status TEXT NOT NULL DEFAULT 'final',
  entered_measurement_system TEXT NOT NULL CHECK (entered_measurement_system IN ('metric', 'imperial')),
  entered_timezone TEXT NOT NULL,
  local_date TEXT NOT NULL,
  fluid_type_code TEXT,
  client_updated_at TEXT NOT NULL,
  server_sequence TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- A volume and its unit travel together, both directions.
  CHECK ((value_quantity_value IS NULL) = (value_quantity_unit IS NULL)),
  -- Only voided urine may omit the volume, and only when a colour replaces
  -- it. Anything else with no volume records nothing at all.
  CHECK (value_quantity_value IS NOT NULL OR (code = '9187-6' AND urine_color_code IS NOT NULL)),
  -- A colour belongs to nothing but voided urine.
  CHECK (urine_color_code IS NULL OR code = '9187-6'),
  -- No Measured/Estimated qualifier without a value to qualify (ADR-0018).
  CHECK (method IS NULL OR value_quantity_value IS NOT NULL)
);

INSERT INTO observations_new (
  id, resource_type, code, value_quantity_value, value_quantity_unit,
  urine_color_code, effective_datetime, method, status,
  entered_measurement_system, entered_timezone, local_date, fluid_type_code,
  client_updated_at, server_sequence, deleted_at, created_at, updated_at
)
SELECT
  id, resource_type, code, value_quantity_value, value_quantity_unit,
  NULL, effective_datetime, method, status,
  entered_measurement_system, entered_timezone, local_date, fluid_type_code,
  client_updated_at, server_sequence, deleted_at, created_at, updated_at
FROM observations;

DROP TABLE observations;
ALTER TABLE observations_new RENAME TO observations;

CREATE INDEX IF NOT EXISTS idx_observations_code_effective
  ON observations (code, effective_datetime);

CREATE INDEX IF NOT EXISTS idx_observations_deleted_at
  ON observations (deleted_at);

CREATE INDEX IF NOT EXISTS idx_observations_local_date
  ON observations (local_date);

-- Migration 3's index, which the DROP above removes and nothing else
-- recreates -- including on a fresh install, where 3 runs before this
-- migration. This migration's own comment claimed "both indexes"; there were
-- three. A daily view queries (code, local_date) together, which is what this
-- composite serves and the single-column one above does not.
CREATE INDEX IF NOT EXISTS idx_observations_code_local_date
  ON observations (code, local_date);
`;

/**
 * Applied in ascending `version` order by `./migrations.ts`. Append a new
 * entry for a schema change; never edit an entry a shipped build may have
 * already applied — the same rule `apps/api/prisma/migrations` follows.
 */
/**
 * Migration 2: the wire payload leaves the queue.
 *
 * `sync_queue.payload` froze a fully-serialised wire object at ENQUEUE
 * time. That duplicated state the `observations` row already held, and it
 * made the queue unamendable: a change to `docs/sync-contract.md` — which
 * is normative and does change — could never reach an operation already
 * sitting in the queue.
 *
 * ADR-0016 is the concrete case, and it is already accepted. Every
 * observation must carry the device's IANA timezone and a derived
 * `local_date`. With payloads frozen, every queued-but-unpushed operation
 * would go up missing that field, the server would reject it Tier 1, and
 * the patient would find correction-inbox entries naming a field no entry
 * form contains — a rejection they cannot act on, which is precisely what
 * `docs/sync-contract.md` §4 warns against. Back-filling with the device's
 * CURRENT zone is the re-derivation ADR-0012 and ADR-0016 both forbid,
 * because it is wrong exactly for the patient who travelled.
 *
 * So the queue now holds identity, ordering and state only. The payload is
 * built at push time from the `observations` row, which is the single
 * source of truth it always should have been.
 *
 * Done before the queue can contain anything real. Once it can, this
 * migration has to preserve payloads it can no longer interpret.
 *
 * SQLite cannot drop a column with a CHECK constraint referencing it, so
 * the table is recreated. `local_seq` is preserved explicitly:
 * `docs/sync-contract.md` §3.2 orders a push by it, and regenerating it
 * would reorder operations that must not be reordered.
 */
const MIGRATION_2_PAYLOAD_AT_PUSH_TIME = `
CREATE TABLE sync_queue_new (
  -- AUTOINCREMENT, matching migration 1. Without it SQLite reuses rowids
  -- after the highest rows are deleted, so local_seq stops being a
  -- never-reused identifier and becomes merely monotonic among surviving
  -- rows. Nothing depends on the stronger property yet; §3.7's idempotency
  -- and any "last pushed local_seq" watermark would, and weakening it
  -- silently inside a migration whose comment says ordering depends on it
  -- is worse than changing it on purpose.
  local_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL UNIQUE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation_type TEXT NOT NULL CHECK (operation_type IN ('create', 'update', 'delete')),
  client_timestamp TEXT NOT NULL,
  enqueued_at TEXT NOT NULL,
  -- 'in_flight' — the value the SQL stores, NOT the camelCase name the
  -- TypeScript side uses. This table was transcribed from the type rather
  -- than from migration 1, which wrote 'inFlight' here: a constraint no
  -- code path can satisfy. markInFlight would have thrown on every push,
  -- and a device holding an in_flight row would have failed this migration
  -- on every launch and never opened its database again.
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'in_flight', 'rejected')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempted_at TEXT,
  rejected_reason_code TEXT,
  rejected_field TEXT,
  rejected_at TEXT
);

INSERT INTO sync_queue_new (
  local_seq, operation_id, entity_type, entity_id, operation_type,
  client_timestamp, enqueued_at, status, attempt_count,
  last_attempted_at, rejected_reason_code, rejected_field, rejected_at
)
SELECT
  local_seq, operation_id, entity_type, entity_id, operation_type,
  client_timestamp, enqueued_at, status, attempt_count,
  last_attempted_at, rejected_reason_code, rejected_field, rejected_at
FROM sync_queue;

DROP TABLE sync_queue;
ALTER TABLE sync_queue_new RENAME TO sync_queue;

-- Both indexes went with the DROP. Recreated under their ORIGINAL names so
-- a database migrated through here is indistinguishable from a fresh one —
-- otherwise migration 3 would face two different shapes.
CREATE INDEX IF NOT EXISTS idx_sync_queue_status
  ON sync_queue (status, local_seq);

CREATE INDEX IF NOT EXISTS idx_sync_queue_entity
  ON sync_queue (entity_type, entity_id);
`;

/**
 * Migration 3: the entry zone and the patient's local day (ADR-0016).
 *
 * The server requires `enteredTimezone` on every observation payload
 * (`docs/sync-contract.md` §7.2), so an entry queued without one is
 * rejected Tier 1 on push. Stored locally as well as sent because an
 * offline daily total has to group by the patient's day before the entry
 * has ever synced — and a device that derived the day differently from the
 * server would show one total on the phone and another on the web, with
 * nothing detecting the disagreement.
 *
 * `local_date` is derived here AND server-side from the same shared helper
 * (`@ostomy/core/units`), which is what keeps the two from drifting.
 *
 * SQLite has no DATE type; `YYYY-MM-DD` as TEXT sorts and compares
 * correctly, which is all this column is used for.
 */
const MIGRATION_3_ENTRY_ZONE_AND_LOCAL_DATE = `
ALTER TABLE observations ADD COLUMN entered_timezone TEXT NOT NULL DEFAULT 'UTC';
ALTER TABLE observations ADD COLUMN local_date TEXT NOT NULL DEFAULT '1970-01-01';

CREATE INDEX IF NOT EXISTS idx_observations_code_local_date
  ON observations (code, local_date);
`;

/**
 * Migration 4: the cached validation thresholds.
 *
 * CLAUDE.md: "Numeric thresholds are admin-managed configuration, not
 * constants in code", and `@ostomy/core/validation` enforces it structurally
 * by taking them as an injected argument. This app must also validate
 * **offline**, where no fetch is possible — so the values have to rest
 * somewhere on the device, and this is that somewhere.
 *
 * A single row, like `sync_cursor`, for the same reason: "no thresholds yet"
 * and "thresholds are X" being one state rather than two removes a
 * special case from every reader.
 *
 * Deliberately NOT seeded with defaults. A seeded row is a hardcoded
 * threshold wearing a database costume — it would satisfy the injection
 * interface while making the rule it exists to enforce false, and an entry
 * screen validating against invented numbers is worse than one that says it
 * cannot validate yet. `fetched_at` being NULL is how a reader tells "never
 * fetched" from "fetched and this is the answer", and the entry screen
 * refuses to save against a never-fetched cache.
 *
 * Reaching the device is not a problem in practice: signing in requires a
 * network round-trip, so by the time a patient can log anything this app has
 * been online at least once.
 *
 * Stored as TEXT, not REAL, for migration 1's reason — these are decimal
 * configuration values compared against clinical quantities, and a binary
 * rounding step between "what the admin set" and "what the client compares
 * against" is a difference nobody would ever look for.
 */
const MIGRATION_4_THRESHOLD_CACHE = `
CREATE TABLE IF NOT EXISTS validation_thresholds_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  stoma_output_soft_warning_ml TEXT NOT NULL,
  max_clock_skew_ms TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
`;

/**
 * Migration 5: the cached value-set members.
 *
 * Same argument as migration 4's threshold cache, one step further. Value sets
 * are admin-managed configuration and members are **retired, never deleted**
 * (CLAUDE.md), so this app cannot hold a hardcoded list of fluid types, meal
 * tags or container sizes — a retired member must stop being offered while
 * still resolving in history. And the entry screens must render **offline**,
 * where nothing can be fetched, so the last-known members rest here.
 *
 * Deliberately NOT seeded, for the threshold cache's reason: a seeded default
 * is a hardcoded value set wearing a database costume. An empty table means
 * "never fetched", and a screen with no members to offer says so rather than
 * offering an invented list.
 *
 * `numeric_value` is TEXT for migration 1's reason — a container size is a
 * decimal that gets written into `observations.value_quantity_value`, and a
 * binary rounding step between what an admin configured and what the patient's
 * entry records is one nobody would ever look for.
 *
 * No `status` column: this table holds ACTIVE members only, because that is
 * all the endpoint returns. Storing retired ones would mean every reader had
 * to filter, and forgetting once would offer a patient a retired option.
 */
const MIGRATION_5_VALUE_SET_CACHE = `
CREATE TABLE IF NOT EXISTS value_set_members_cache (
  value_set_key TEXT NOT NULL,
  code TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  numeric_value TEXT,
  numeric_unit TEXT,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (value_set_key, code)
);

CREATE INDEX IF NOT EXISTS idx_value_set_members_cache_set
  ON value_set_members_cache (value_set_key, sort_order);
`;

/**
 * Migration 6: fluid intake and meals reach the device (P3.S1, SRS AC 2.3/2.4).
 *
 * Two additions that look unrelated and are not: both are entry types the
 * patient logs offline, so both need a local home before a screen can confirm
 * a save from the local write (§9.5).
 *
 * **`observations.fluid_type_code`** mirrors the server column added in the
 * same sprint. Nullable for the two different reasons storage deliberately
 * does not distinguish — "the patient did not categorise" on an intake row,
 * "not applicable" on stoma output — which follows from `code`, exactly as it
 * does server-side.
 *
 * **`meals`** is the first app-native synced entity on this device. It carries
 * the same sync bookkeeping as `observations` because it is subject to the
 * same contract: `client_updated_at` for last-write-wins, `server_sequence`
 * stamped from a push receipt or a delta row, `deleted_at` for tombstones.
 * Anything that differs from the observations table here is a bug.
 *
 * `tag_codes` is stored as a JSON array in TEXT. SQLite has no array type, and
 * the alternative — a join table — would need its own sync identity, which
 * docs/sync-contract.md has no concept of; the wire carries tags inside the
 * meal's own payload (§7.4) for that reason, and the local shape follows the
 * wire rather than inventing a second model.
 *
 * `size` is CHECK-constrained to the three wire values, mirroring the server's
 * enum. Belt and braces, like `entered_measurement_system`'s: every write path
 * goes through `../db/offlineWrites.ts`, but a schema-level constraint fails
 * loudly in a test rather than producing a row this app cannot render.
 */
const MIGRATION_6_INTAKE_AND_MEALS = `
ALTER TABLE observations ADD COLUMN fluid_type_code TEXT;

CREATE TABLE IF NOT EXISTS meals (
  id TEXT PRIMARY KEY NOT NULL,
  description TEXT,
  size TEXT NOT NULL CHECK (size IN ('small', 'medium', 'large')),
  tag_codes TEXT NOT NULL DEFAULT '[]',
  effective_datetime TEXT NOT NULL,
  entered_timezone TEXT NOT NULL,
  local_date TEXT NOT NULL,
  client_updated_at TEXT NOT NULL,
  server_sequence TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_meals_local_date
  ON meals (local_date);

CREATE INDEX IF NOT EXISTS idx_meals_deleted_at
  ON meals (deleted_at);
`;

export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  {
    version: 1,
    description: 'observations, sync_queue, sync_cursor',
    sql: ({ seededAt }) => `${MIGRATION_1_INITIAL_SCHEMA}\n${seedInitialSyncCursor(seededAt)}`,
  },
  {
    version: 2,
    description: 'sync_queue drops payload; the wire object is built at push time',
    sql: () => MIGRATION_2_PAYLOAD_AT_PUSH_TIME,
  },
  {
    version: 3,
    description: 'observations gain entered_timezone and local_date (ADR-0016)',
    sql: () => MIGRATION_3_ENTRY_ZONE_AND_LOCAL_DATE,
  },
  {
    version: 4,
    description: 'validation_thresholds_cache — admin-managed thresholds, available offline',
    sql: () => MIGRATION_4_THRESHOLD_CACHE,
  },
  {
    version: 5,
    description: 'value_set_members_cache — admin-managed value sets, available offline',
    sql: () => MIGRATION_5_VALUE_SET_CACHE,
  },
  {
    version: 6,
    description: 'fluid intake (observations.fluid_type_code) and the local meals table',
    sql: () => MIGRATION_6_INTAKE_AND_MEALS,
  },
  {
    version: 7,
    description: 'voided urine: nullable volume, urine_color_code (SRS AC 12.1 AC2)',
    sql: () => MIGRATION_7_VOIDED_URINE,
  },
];
