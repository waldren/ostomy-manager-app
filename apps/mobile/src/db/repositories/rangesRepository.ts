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

import type { SqliteExecutor } from '../executor';

/**
 * The patient's target ranges on this device (P4.S3 slice 4). See local
 * migration 10 in `../schema.ts` for why there are two tables and why neither
 * mirrors the server's rows.
 */

/** The two provenances a patient's own action produces, in the sync spelling (`docs/sync-contract.md` §7.6). */
export type PatientRangeProvenance = 'patient_set' | 'patient_confirmed_suggestion';

export type CachedRangeProvenance = 'physician_set' | PatientRangeProvenance | 'clinical_default';

/** One stored patient row, as much as a status update must echo back. */
export interface CachedPatientRange {
  readonly id: string;
  readonly lowValue: number | null;
  readonly highValue: number | null;
  readonly targetValue: number | null;
  readonly unit: string;
  readonly provenance: PatientRangeProvenance;
}

export interface CachedRangeBasis {
  readonly ostomyType: 'colostomy' | 'ileostomy';
  readonly daysPostOp: number;
  readonly minDaysPostOp: number;
  readonly maxDaysPostOp: number | null;
  /** The suggestion's own bounds — null when the server did not send them. */
  readonly lowValue: number | null;
  readonly highValue: number | null;
}

/** One range type's resolved answer, as `GET /api/v1/ranges` gave it. */
export interface CachedRange {
  readonly rangeType: string;
  readonly unit: string;
  readonly lowValue: number | null;
  readonly highValue: number | null;
  readonly provenance: CachedRangeProvenance;
  readonly isActiveThreshold: boolean;
  readonly divergesFromPhysician: boolean;
  readonly basis: CachedRangeBasis | null;
  readonly patientRange: CachedPatientRange | null;
  readonly proposal: CachedPatientRange | null;
  readonly limits: { readonly minValue: number; readonly maxValue: number } | null;
}

export interface RangeCache {
  readonly ranges: readonly CachedRange[];
  readonly fetchedAt: string;
}

/**
 * Both spellings: the read's enum names, and the sync spelling this repository
 * stores the decoded copy in.
 */
const PROVENANCE_SPELLINGS: Readonly<Record<string, CachedRangeProvenance>> = {
  PHYSICIAN_SET: 'physician_set',
  PATIENT_SET: 'patient_set',
  PATIENT_CONFIRMED_SUGGESTION: 'patient_confirmed_suggestion',
  CLINICAL_DEFAULT: 'clinical_default',
  physician_set: 'physician_set',
  patient_set: 'patient_set',
  patient_confirmed_suggestion: 'patient_confirmed_suggestion',
  clinical_default: 'clinical_default',
};

function decodeProvenance(raw: unknown): CachedRangeProvenance | undefined {
  return typeof raw === 'string' && Object.hasOwn(PROVENANCE_SPELLINGS, raw)
    ? PROVENANCE_SPELLINGS[raw]
    : undefined;
}

/**
 * Decodes the `ranges` array of a `GET /api/v1/ranges` response, field by
 * field, or returns `undefined` if any entry is not what that read promises.
 *
 * All or nothing: a partial list would show some ranges and silently drop
 * others, and "you have no target range for urine" is a claim. The three
 * fields P4.S3 added (`patientRange`, `proposal`, `limits`, and the basis's
 * bounds) read as null when absent, so a server that predates them still
 * yields a usable, read-only answer.
 */
export function decodeRanges(raw: unknown): CachedRange[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const decoded: CachedRange[] = [];
  for (const entry of raw) {
    const range = decodeRange(entry);
    if (range === undefined) return undefined;
    decoded.push(range);
  }
  return decoded;
}

function decodeRange(raw: unknown): CachedRange | undefined {
  if (!isRecord(raw)) return undefined;
  const provenance = decodeProvenance(raw.provenance);
  if (
    typeof raw.rangeType !== 'string' ||
    typeof raw.unit !== 'string' ||
    !isBound(raw.lowValue) ||
    !isBound(raw.highValue) ||
    provenance === undefined ||
    typeof raw.isActiveThreshold !== 'boolean' ||
    typeof raw.divergesFromPhysician !== 'boolean'
  ) {
    return undefined;
  }

  const basis = raw.basis === null ? null : decodeBasis(raw.basis);
  const patientRange = decodeOptionalRow(raw.patientRange);
  const proposal = decodeOptionalRow(raw.proposal);
  const limits = decodeLimits(raw.limits);
  if (basis === undefined || patientRange === undefined || proposal === undefined) return undefined;
  if (limits === undefined) return undefined;

  return {
    rangeType: raw.rangeType,
    unit: raw.unit,
    lowValue: raw.lowValue,
    highValue: raw.highValue,
    provenance,
    isActiveThreshold: raw.isActiveThreshold,
    divergesFromPhysician: raw.divergesFromPhysician,
    basis,
    patientRange,
    proposal,
    limits,
  };
}

function decodeBasis(raw: unknown): CachedRangeBasis | undefined {
  if (!isRecord(raw)) return undefined;
  const { ostomyType, daysPostOp, minDaysPostOp, maxDaysPostOp } = raw;
  if (ostomyType !== 'colostomy' && ostomyType !== 'ileostomy') return undefined;
  if (typeof daysPostOp !== 'number' || typeof minDaysPostOp !== 'number') return undefined;
  if (maxDaysPostOp !== null && typeof maxDaysPostOp !== 'number') return undefined;
  const lowValue = raw.lowValue ?? null;
  const highValue = raw.highValue ?? null;
  if (!isBound(lowValue) || !isBound(highValue)) return undefined;
  return { ostomyType, daysPostOp, minDaysPostOp, maxDaysPostOp, lowValue, highValue };
}

/** `undefined` means malformed; an absent or null field is `null`. */
function decodeOptionalRow(raw: unknown): CachedPatientRange | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) return undefined;
  const decoded = decodeProvenance(raw.provenance);
  const provenance =
    decoded === 'patient_set' || decoded === 'patient_confirmed_suggestion' ? decoded : undefined;
  if (
    typeof raw.id !== 'string' ||
    typeof raw.unit !== 'string' ||
    !isBound(raw.lowValue) ||
    !isBound(raw.highValue) ||
    !isBound(raw.targetValue) ||
    provenance === undefined
  ) {
    return undefined;
  }
  return {
    id: raw.id,
    lowValue: raw.lowValue,
    highValue: raw.highValue,
    targetValue: raw.targetValue,
    unit: raw.unit,
    provenance,
  };
}

function decodeLimits(raw: unknown): CachedRange['limits'] | undefined {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) return undefined;
  if (typeof raw.minValue !== 'number' || typeof raw.maxValue !== 'number') return undefined;
  return { minValue: raw.minValue, maxValue: raw.maxValue };
}

function isBound(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The cached answer, or `undefined` before the first successful fetch.
 *
 * No default, for the threshold cache's reason: a range invented here would be
 * a clinical value nobody chose, shown to a patient as theirs.
 */
export async function readRangeCache(executor: SqliteExecutor): Promise<RangeCache | undefined> {
  const rows = await executor.getAllAsync<{ ranges_json: string; fetched_at: string }>(
    'SELECT ranges_json, fetched_at FROM range_cache WHERE id = 1;',
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.ranges_json);
  } catch {
    return undefined;
  }
  const ranges = decodeRanges(parsed);
  return ranges === undefined ? undefined : { ranges, fetchedAt: row.fetched_at };
}

/** Replaces the cached answer. Called only from the sync worker's refresh. */
export async function writeRangeCache(
  executor: SqliteExecutor,
  ranges: readonly CachedRange[],
  fetchedAt: string,
): Promise<void> {
  await executor.runAsync(
    `INSERT INTO range_cache (id, ranges_json, fetched_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET ranges_json = excluded.ranges_json, fetched_at = excluded.fetched_at;`,
    [JSON.stringify(ranges), fetchedAt],
  );
}

/**
 * One change this device made, for one queued operation: the full §7.6
 * payload, less what the server assigns. See local migration 10 for why a row
 * is per operation rather than per range.
 */
export interface RangeWrite {
  readonly operationId: string;
  /** The range row the change creates or updates — the operation's `entityId`. */
  readonly id: string;
  readonly rangeType: string;
  /** Canonical values as exact decimal strings, migration 1's rule for every clinical number at rest. */
  readonly lowValue: string | null;
  readonly highValue: string | null;
  readonly targetValue: string | null;
  readonly unit: string;
  readonly provenance: PatientRangeProvenance;
  /** The status THIS operation sets — `active` on a create. */
  readonly status: 'active' | 'superseded' | 'dismissed';
  readonly writtenAt: string;
}

interface RangeWriteRawRow {
  operation_id: string;
  range_id: string;
  range_type: string;
  low_value: string | null;
  high_value: string | null;
  target_value: string | null;
  unit: string;
  provenance: string;
  status: string;
  written_at: string;
}

function decodeRangeWrite(row: RangeWriteRawRow): RangeWrite {
  return {
    operationId: row.operation_id,
    id: row.range_id,
    rangeType: row.range_type,
    lowValue: row.low_value,
    highValue: row.high_value,
    targetValue: row.target_value,
    unit: row.unit,
    // The table's CHECK constraints hold these to exactly these spellings.
    provenance: row.provenance as PatientRangeProvenance,
    status: row.status as RangeWrite['status'],
    writtenAt: row.written_at,
  };
}

export async function insertRangeWrite(executor: SqliteExecutor, write: RangeWrite): Promise<void> {
  await executor.runAsync(
    `INSERT INTO range_writes (
      operation_id, range_id, range_type, low_value, high_value, target_value,
      unit, provenance, status, written_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      write.operationId,
      write.id,
      write.rangeType,
      write.lowValue,
      write.highValue,
      write.targetValue,
      write.unit,
      write.provenance,
      write.status,
      write.writtenAt,
    ],
  );
}

/** The change a queued operation carries, which is what its push payload is built from. */
export async function getRangeWriteForOperation(
  executor: SqliteExecutor,
  operationId: string,
): Promise<RangeWrite | undefined> {
  const rows = await executor.getAllAsync<RangeWriteRawRow>(
    'SELECT * FROM range_writes WHERE operation_id = ?;',
    [operationId],
  );
  const row = rows[0];
  return row === undefined ? undefined : decodeRangeWrite(row);
}

export async function deleteRangeWriteForOperation(
  executor: SqliteExecutor,
  operationId: string,
): Promise<void> {
  await executor.runAsync('DELETE FROM range_writes WHERE operation_id = ?;', [operationId]);
}

/** A change to lay over the cached answer, and whether it is still waiting to be sent. */
export interface OverlayRangeWrite extends RangeWrite {
  /** Still queued or being sent. False once the push settled it and only the refresh is outstanding. */
  readonly pending: boolean;
}

/**
 * The changes the cached answer does not reflect yet, in the order the patient
 * made them.
 *
 * Every row here is either still waiting to be sent, or was settled by a push
 * since the cached answer was fetched; `refreshRanges` deletes the rest. So
 * this needs no timestamp comparison at all: the device's own clock, which can
 * jump backwards, decides nothing.
 *
 * A change the server REFUSED is left out, per operation: it is in the
 * correction inbox, and showing it here too would tell the patient a value is
 * in use that the server would not accept. A later change to the same range is
 * a different operation and is shown.
 *
 * Ordered by insertion, which is the order the patient acted in, rather than by
 * `written_at`, for the same reason.
 */
export async function listOverlayRangeWrites(
  executor: SqliteExecutor,
): Promise<OverlayRangeWrite[]> {
  const rows = await executor.getAllAsync<RangeWriteRawRow & { queue_status: string | null }>(
    `SELECT w.*, q.status AS queue_status FROM range_writes w
     LEFT JOIN sync_queue q ON q.operation_id = w.operation_id
     WHERE q.status IS NULL OR q.status IN ('queued', 'in_flight')
     ORDER BY w.rowid ASC;`,
  );
  return rows.map((row) => ({ ...decodeRangeWrite(row), pending: row.queue_status !== null }));
}

/** Changes whose operation has left the queue — settled by a push, waiting only for a newer cached answer. */
export async function listSettledRangeWriteOperations(executor: SqliteExecutor): Promise<string[]> {
  const rows = await executor.getAllAsync<{ operation_id: string }>(
    `SELECT w.operation_id FROM range_writes w
     WHERE NOT EXISTS (SELECT 1 FROM sync_queue q WHERE q.operation_id = w.operation_id);`,
  );
  return rows.map((row) => row.operation_id);
}

/**
 * Replaces the cached answer and forgets the changes it now reflects, together.
 *
 * `reflected` must be the changes that were already settled BEFORE the read
 * that produced `ranges` was sent. A change settled after that read began may
 * not be in it, and forgetting it would flick the screen back to the old
 * value until the next refresh.
 */
export async function replaceRangeCache(
  executor: SqliteExecutor,
  ranges: readonly CachedRange[],
  fetchedAt: string,
  reflected: readonly string[],
): Promise<void> {
  await executor.withTransactionAsync(async () => {
    await writeRangeCache(executor, ranges, fetchedAt);
    for (const operationId of reflected) {
      await deleteRangeWriteForOperation(executor, operationId);
    }
  });
}
