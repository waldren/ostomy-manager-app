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
 * `docs/sync-contract.md` §3.5 orders a push by it, and regenerating it
 * would reorder operations that must not be reordered.
 */
const MIGRATION_2_PAYLOAD_AT_PUSH_TIME = `
CREATE TABLE sync_queue_new (
  local_seq INTEGER PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation_type TEXT NOT NULL CHECK (operation_type IN ('create', 'update', 'delete')),
  client_timestamp TEXT NOT NULL,
  enqueued_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'inFlight', 'rejected')),
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
];
