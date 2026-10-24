#!/usr/bin/env node
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
 * P4.S5 slice 1 (#158): API latency baseline for SRS §5.1.
 *
 *   node scripts/perf/api-baseline.mjs [--samples 200] [--warmup 20]
 *                                      [--json out.json] [--allow-remote]
 *
 * Against the LOCAL development stack. It provisions two synthetic patients of
 * its own (never the emulator's), gives each 90 days of history through the
 * sync push the phone uses, then times each operation sequentially:
 *
 * - `GET /sync/delta` from 0 to the end, at the server's default page size,
 *   which is what a new or reinstalled phone does on first sync;
 * - `GET /observations` over 30 and over 90 days, the read a history view
 *   would make;
 * - `POST /sync/push` with 1 operation (one saved entry, pushed later), 50
 *   (a steady-state batch), and 500 (the phone's own batch ceiling,
 *   `DEFAULT_MAX_OPERATIONS_PER_BATCH`);
 * - `POST /observations` (the direct write path).
 *
 * The seeding pushes are timed too, and reported as what they are: 50-operation
 * batches with no warm-up, in order, while the patient's history grows from
 * empty to full. Their raw timings, in order, are in the JSON so a trend with
 * history size can be seen rather than guessed.
 *
 * Sequential on purpose: §5.1 is about one patient's experience, not
 * throughput, and concurrency would measure the database pool instead. Each
 * sample includes reading the whole response body.
 *
 * Docker on one desktop is not Fargate and RDS. These are RELATIVE numbers,
 * for comparing operations and catching an order-of-magnitude problem; P4.S6's
 * staging spike is what speaks for production.
 *
 * Writes synthetic rows and their audit rows to the dev database, under
 * subjects named `perf-<kind>-<run id>`, and makes dozens of `since=0` pulls,
 * each of which the API records in its security log (docs/sync-contract.md
 * §2). `scripts/dev-reset.sh` removes the rows.
 */

import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const API_URL = process.env.API_URL ?? 'http://localhost:3000';
// The issuer the API expects. The mock IdP bakes the Host header it is called
// by into `iss`, so this must be the address the API compares against.
const ISSUER = process.env.OIDC_ISSUER ?? 'http://localhost:8090/patient-issuer';
const AUDIENCE = process.env.OIDC_AUDIENCE ?? 'ostomy-patient-app';

const STOMA_OUTPUT = '79560-9';
const FLUID_INTAKE = '9000-1';
const VOIDED_URINE = '9187-6';
const MEASURED = '258104002';
const ESTIMATED = '414135002';
const ZONE = 'America/Chicago';

const HISTORY_DAYS = 90;
const SEED_BATCH_SIZE = 50;
/** The phone's batch ceiling: `apps/mobile/src/sync/SyncProvider.tsx`'s `DEFAULT_MAX_OPERATIONS_PER_BATCH`. */
const PHONE_BATCH_SIZE = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Below this many samples, nearest-rank p99 is just the maximum, so it is not reported. */
const MIN_SAMPLES_FOR_P99 = 100;
/** A server that answers 429 forever would otherwise hang the run. */
const MAX_THROTTLED_WAITS_PER_REQUEST = 30;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Entries a day: `colostomy-baseline`'s density, and twice it (#158 decision 6). */
const DENSITIES = { typical: 15, heavy: 30 };

class Refused extends Error {}

function parseArgs(argv) {
  const args = { samples: 200, warmup: 20, json: undefined, allowRemote: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--allow-remote') {
      args.allowRemote = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Refused(`${flag} needs a value`);
    if (flag === '--samples') args.samples = Number(value);
    else if (flag === '--warmup') args.warmup = Number(value);
    else if (flag === '--json') args.json = value;
    else throw new Refused(`unknown argument ${flag}`);
    i += 1;
  }
  if (!Number.isInteger(args.samples) || args.samples < 20) {
    throw new Refused('--samples must be an integer of at least 20, or p95 means nothing');
  }
  if (!Number.isInteger(args.warmup) || args.warmup < 0) {
    throw new Refused('--warmup must be a non-negative integer');
  }
  return args;
}

/** How many times the sync rate limiter made this run wait. Reported, never timed. */
let throttledWaits = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One request, timed: `ms` covers the attempt that answered, including reading
 * the whole body.
 *
 * A `429` is waited out and retried, and the wait is not in `ms`. The sync
 * endpoints allow 60 requests a minute per patient (`sync-throttle.ts`), and
 * this script makes far more than a phone does, so without this it would
 * measure the limiter rather than the latency.
 */
async function call(method, path, token, body) {
  for (let waits = 0; ; waits += 1) {
    const start = performance.now();
    const response = await fetch(`${API_URL}/api/v1${path}`, {
      method,
      headers: {
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    const ms = performance.now() - start;
    if (response.status === 429) {
      if (waits >= MAX_THROTTLED_WAITS_PER_REQUEST) {
        throw new Refused(`${method} ${path} was still rate-limited after ${waits} waits`);
      }
      throttledWaits += 1;
      const retryAfter = Number(response.headers.get('retry-after'));
      await sleep((Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60) * 1000);
      continue;
    }
    return {
      status: response.status,
      body: text.length > 0 ? JSON.parse(text) : undefined,
      bytes: Buffer.byteLength(text),
      ms,
    };
  }
}

/**
 * Local only, unless asked otherwise.
 *
 * Two checks, because each alone is weak. The host must be this machine, which
 * stops a mistyped `API_URL` writing thousands of rows somewhere real; and the
 * API must report a build commit, which only the dev stack does. Neither is a
 * security boundary. `--allow-remote` lifts the first for P9.S4's own run
 * against staging, deliberately and visibly.
 */
async function assertDevelopmentStack(allowRemote) {
  const host = new URL(API_URL).hostname;
  if (!allowRemote && !LOCAL_HOSTS.has(host)) {
    throw new Refused(`${API_URL} is not this machine; pass --allow-remote to run against it`);
  }
  let health;
  try {
    health = await call('GET', '/health');
  } catch (cause) {
    throw new Refused(`could not reach ${API_URL}: ${cause.message}`);
  }
  if (typeof health.body?.buildCommit !== 'string' || health.body.buildCommit === '') {
    throw new Refused(`${API_URL} reported no build commit, so it is not the development stack`);
  }
  return health.body.buildCommit;
}

/** Minted by the development mock IdP, which checks no password. */
async function mintToken(subject) {
  const response = await fetch(`${ISSUER}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      username: subject,
      password: 'unchecked-by-the-mock-idp',
      client_id: AUDIENCE,
      scope: 'openid',
    }),
  });
  if (!response.ok) throw new Refused(`the mock IdP refused a token: HTTP ${response.status}`);
  return (await response.json()).access_token;
}

/**
 * A request as a patient. A run is long (the rate limiter sees to that), so an
 * expired token is re-minted once and the request repeated, rather than the
 * run dying an hour in.
 */
async function asPatient(patient, method, path, body) {
  const response = await call(method, path, patient.token, body);
  if (response.status !== 401) return response;
  patient.token = await mintToken(patient.subject);
  return call(method, path, patient.token, body);
}

/** One synthetic entry, on the wire as the phone sends it (docs/sync-contract.md §7.2, `pushOperations.ts`). */
function entry(index, at) {
  const kind = index % 15;
  const id = randomUUID();
  const base = {
    resourceType: 'Observation',
    id,
    status: 'final',
    effectiveDateTime: at.toISOString(),
    enteredMeasurementSystem: 'metric',
    enteredTimezone: ZONE,
    // Always present on the phone's wire, possibly null (§7.2).
    fluidTypeCode: null,
  };
  let payload;
  if (kind < 6) {
    payload = {
      ...base,
      code: STOMA_OUTPUT,
      valueQuantity: { value: 150 + (index % 7) * 25, unit: 'mL' },
      method: MEASURED,
    };
  } else if (kind < 13) {
    payload = {
      ...base,
      code: FLUID_INTAKE,
      valueQuantity: { value: 250, unit: 'mL' },
      method: ESTIMATED,
    };
  } else {
    payload = {
      ...base,
      code: VOIDED_URINE,
      valueQuantity: { value: 300, unit: 'mL' },
      method: MEASURED,
    };
  }
  return {
    operationId: randomUUID(),
    entityType: 'Observation',
    entityId: id,
    operationType: 'create',
    clientTimestamp: new Date().toISOString(),
    payload,
  };
}

/** `perDay` entries a day for the last 90 days, oldest first, none in the future. */
function history(perDay, now) {
  const operations = [];
  let index = 0;
  for (let day = HISTORY_DAYS; day >= 1; day -= 1) {
    const dayStart = now - day * DAY_MS;
    for (let n = 0; n < perDay; n += 1) {
      operations.push(entry(index, new Date(dayStart + ((n + 1) * DAY_MS) / (perDay + 1))));
      index += 1;
    }
  }
  return operations;
}

/** `count` fresh entries from the last day, for the write measurements. */
function freshEntries(count, now) {
  return Array.from({ length: count }, (_, i) =>
    entry(i, new Date(now - DAY_MS / 2 + (i * DAY_MS) / (4 * count))),
  );
}

async function provision(kind, runId) {
  const subject = `perf-${kind}-${runId}`;
  const patient = { kind, subject, token: await mintToken(subject) };
  const surgeryDate = new Date(Date.now() - (HISTORY_DAYS + 30) * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const response = await asPatient(patient, 'POST', '/onboarding', {
    ostomyType: 'colostomy',
    surgeryDate,
    measurementSystem: 'metric',
  });
  if (response.status !== 201) {
    throw new Refused(`onboarding ${subject} answered ${response.status}`);
  }
  return patient;
}

/**
 * One result per operation, in order, every one `accepted` (§3.4). A fresh
 * UUID create has no other correct answer, so anything else is a seeding
 * failure, and a short or missing `results` would otherwise read as success.
 */
async function push(patient, operations, label) {
  const response = await asPatient(patient, 'POST', '/sync/push', { operations });
  if (response.status !== 200) throw new Refused(`${label} answered HTTP ${response.status}`);
  const results = response.body?.results;
  if (!Array.isArray(results) || results.length !== operations.length) {
    throw new Refused(
      `${label}: ${operations.length} operations sent, ${Array.isArray(results) ? results.length : 'no'} results`,
    );
  }
  results.forEach((result, i) => {
    if (result.operationId !== operations[i].operationId || result.status !== 'accepted') {
      throw new Refused(`${label}: operation ${i} answered ${JSON.stringify(result)}`);
    }
  });
  return response.ms;
}

function summarise(name, samples, extra = {}) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  const round = (ms) => Math.round(ms * 10) / 10;
  return {
    name,
    n: sorted.length,
    min: round(sorted[0]),
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    // Nearest-rank p99 of fewer than 100 samples is the maximum, so it is withheld.
    p99: sorted.length >= MIN_SAMPLES_FOR_P99 ? round(at(0.99)) : null,
    max: round(sorted.at(-1)),
    mean: round(sorted.reduce((sum, ms) => sum + ms, 0) / sorted.length),
    ...extra,
    // In the order they were taken, so a trend or a cluster of slow samples can be seen.
    samples: samples.map(round),
  };
}

/** Warm up, then `samples` runs of `fn`, which returns the milliseconds it measured. */
async function measure(name, fn, { samples, warmup }, extra = {}) {
  for (let i = 0; i < warmup; i += 1) await fn();
  const timings = [];
  for (let i = 0; i < samples; i += 1) timings.push(await fn());
  return summarise(name, timings, { warmup, ...extra });
}

/** Every delta page from 0, at the server's default page size, as a new phone pulls. */
async function fullPull(patient) {
  let since = '0';
  let pages = 0;
  let bytes = 0;
  let changes = 0;
  let ms = 0;
  for (;;) {
    const response = await asPatient(patient, 'GET', `/sync/delta?since=${since}`);
    if (response.status !== 200) throw new Refused(`delta answered ${response.status}`);
    ms += response.ms;
    pages += 1;
    bytes += response.bytes;
    changes += response.body.changes.length;
    since = response.body.cursor;
    if (!response.body.hasMore) return { pages, bytes, changes, ms };
  }
}

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

/** A plain aligned table: the numbers first, any shape notes after. */
function formatTable(rows) {
  const columns = ['name', 'n', 'min', 'p50', 'p95', 'p99', 'max', 'mean'];
  const notes = (row) =>
    Object.entries(row)
      .filter(([key]) => !columns.includes(key) && key !== 'samples')
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
  const cells = [
    columns.concat('notes'),
    ...rows.map((row) =>
      columns.map((key) => (row[key] === null ? '-' : String(row[key]))).concat(notes(row)),
    ),
  ];
  const widths = cells[0].map((_, i) => Math.max(...cells.map((line) => line[i].length)));
  return cells
    .map((line) =>
      line
        .map((cell, i) =>
          i === 0 || i === line.length - 1 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]),
        )
        .join('  '),
    )
    .join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const buildCommit = await assertDevelopmentStack(args.allowRemote);
  const runId = randomUUID().slice(0, 8);
  const now = Date.now();
  const results = [];
  const log = (line) => process.stderr.write(`${line}\n`);

  log(`API ${API_URL} at ${buildCommit}, run ${runId}`);
  const patients = [];
  for (const [kind, perDay] of Object.entries(DENSITIES)) {
    const patient = await provision(kind, runId);
    const operations = history(perDay, now);
    const timings = [];
    for (let i = 0; i < operations.length; i += SEED_BATCH_SIZE) {
      const batch = operations.slice(i, i + SEED_BATCH_SIZE);
      const ms = await push(patient, batch, `seeding ${patient.subject}`);
      if (batch.length === SEED_BATCH_SIZE) timings.push(ms);
    }
    const quarter = Math.max(1, Math.floor(timings.length / 4));
    results.push(
      summarise(`seeding push, ${SEED_BATCH_SIZE} operations, no warm-up (${kind})`, timings, {
        // Does a batch cost more as the history it lands on grows?
        firstQuarterMean: Math.round(mean(timings.slice(0, quarter))),
        lastQuarterMean: Math.round(mean(timings.slice(-quarter))),
      }),
    );
    log(`seeded ${patient.subject}: ${operations.length} entries over ${HISTORY_DAYS} days`);
    patients.push(patient);
  }

  // Reads first, so the history they measure is exactly the seeded one.
  for (const patient of patients) {
    const { ms: _first, ...shape } = await fullPull(patient);
    results.push(
      await measure(
        `GET /sync/delta, full first pull (${patient.kind})`,
        async () => (await fullPull(patient)).ms,
        // Each sample is 7 to 14 requests against the rate limiter, so fewer.
        { samples: 20, warmup: 2 },
        shape,
      ),
    );
    for (const days of [30, 90]) {
      const from = new Date(now - days * DAY_MS).toISOString();
      const to = new Date(now).toISOString();
      const path = `/observations?effectiveDateTimeFrom=${from}&effectiveDateTimeTo=${to}&limit=500`;
      const probe = await asPatient(patient, 'GET', path);
      if (probe.status !== 200) throw new Refused(`list answered ${probe.status}`);
      const returned = probe.body.observations.length;
      results.push(
        await measure(
          `GET /observations, ${days} days (${patient.kind})`,
          async () => (await asPatient(patient, 'GET', path)).ms,
          args,
          {
            returned,
            bytes: probe.bytes,
            // The list caps a page at 500 and has no cursor, so a full page is
            // the only sign a window held more (a finding for P5.S1).
            fullPage: returned >= 500,
          },
        ),
      );
    }
  }

  const typical = patients[0];
  results.push(
    await measure(
      'POST /sync/push, 1 operation',
      () => push(typical, freshEntries(1, now), 'single push'),
      args,
    ),
  );
  results.push(
    await measure(
      'POST /observations',
      async () => {
        const { payload } = freshEntries(1, now)[0];
        const response = await asPatient(typical, 'POST', '/observations', payload);
        if (response.status !== 201) {
          throw new Refused(`POST /observations answered ${response.status}`);
        }
        return response.ms;
      },
      args,
    ),
  );
  results.push(
    await measure(
      `POST /sync/push, ${SEED_BATCH_SIZE} operations (steady state)`,
      () => push(typical, freshEntries(SEED_BATCH_SIZE, now), 'batch push'),
      { samples: 30, warmup: 2 },
    ),
  );
  results.push(
    await measure(
      `POST /sync/push, ${PHONE_BATCH_SIZE} operations (the phone's ceiling)`,
      () => push(typical, freshEntries(PHONE_BATCH_SIZE, now), 'full batch push'),
      { samples: 10, warmup: 1 },
    ),
  );

  const report = {
    measuredAt: new Date(now).toISOString(),
    api: API_URL,
    buildCommit,
    runId,
    samples: args.samples,
    warmup: args.warmup,
    throttledWaits,
    results,
  };
  if (args.json !== undefined) writeFileSync(args.json, `${JSON.stringify(report, null, 2)}\n`);
  console.log(formatTable(results));
  log(`rate limiter waits: ${throttledWaits} (waited out, not timed)`);
}

main().catch((error) => {
  process.stderr.write(`api-baseline: ${error instanceof Refused ? error.message : error.stack}\n`);
  process.exitCode = 1;
});
