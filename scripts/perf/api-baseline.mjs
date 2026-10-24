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
 *   node scripts/perf/api-baseline.mjs [--samples 200] [--json out.json]
 *
 * Against the LOCAL development stack only. It provisions two synthetic
 * patients of its own (never the emulator's), gives each 90 days of history
 * through the sync push the phone uses, then times each operation
 * sequentially after a warm-up:
 *
 * - `POST /sync/push`, one operation and a 50-operation batch (the phone's
 *   write path: §5.1's "save" reaches the server this way, after the fact);
 * - `POST /observations` (the direct write path);
 * - `GET /sync/delta` from 0 to the end, at the server's default page size,
 *   which is what a new or reinstalled phone does on first sync;
 * - `GET /observations` over 30 and over 90 days, the read a history view
 *   would make.
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
 * subjects named `perf-<kind>-<run id>`. `scripts/dev-reset.sh` removes them.
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
const BATCH_SIZE = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Entries a day: `colostomy-baseline`'s density, and twice it (#158 decision 6). */
const DENSITIES = { typical: 15, heavy: 30 };

class Refused extends Error {}

function parseArgs(argv) {
  const args = { samples: 200, warmup: 20, json: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--samples') args.samples = Number(value);
    else if (flag === '--warmup') args.warmup = Number(value);
    else if (flag === '--json') args.json = value;
    else throw new Refused(`unknown argument ${flag}`);
    i += 1;
  }
  if (!Number.isInteger(args.samples) || args.samples < 20) {
    throw new Refused('--samples must be an integer of at least 20, or p95 means nothing');
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
  for (;;) {
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
      throttledWaits += 1;
      const retryAfter = Number(response.headers.get('retry-after'));
      await sleep((Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60) * 1000);
      continue;
    }
    return {
      status: response.status,
      body: text.length > 0 ? JSON.parse(text) : undefined,
      bytes: text.length,
      ms,
    };
  }
}

/** The same gate `admin-config.mjs` uses: only the dev stack reports a build commit. */
async function assertDevelopmentStack() {
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

/** One synthetic entry, on the wire exactly as the phone sends it (docs/sync-contract.md §7.2). */
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

async function provision(kind, runId) {
  const subject = `perf-${kind}-${runId}`;
  const token = await mintToken(subject);
  const surgeryDate = new Date(Date.now() - (HISTORY_DAYS + 30) * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const response = await call('POST', '/onboarding', token, {
    ostomyType: 'ileostomy',
    surgeryDate,
    measurementSystem: 'metric',
  });
  if (response.status !== 201)
    throw new Refused(`onboarding ${subject} answered ${response.status}`);
  return { kind, subject, token };
}

function assertAccepted(response, label) {
  if (response.status !== 200) throw new Refused(`${label} answered HTTP ${response.status}`);
  const results = response.body?.results ?? [];
  const refused = results.filter((result) => result.status !== 'accepted');
  if (refused.length > 0) {
    throw new Refused(
      `${label}: ${refused.length} operation(s) not accepted, first: ${JSON.stringify(refused[0])}`,
    );
  }
}

function summarise(name, samples, extra = {}) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  const round = (ms) => Math.round(ms * 10) / 10;
  return {
    name,
    n: sorted.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    p99: round(at(0.99)),
    max: round(sorted.at(-1)),
    mean: round(sorted.reduce((sum, ms) => sum + ms, 0) / sorted.length),
    ...extra,
  };
}

/** Warm up, then `samples` runs of `fn`, which returns the milliseconds it measured. */
async function measure(name, fn, { samples, warmup }, extra) {
  for (let i = 0; i < warmup; i += 1) await fn();
  const timings = [];
  for (let i = 0; i < samples; i += 1) timings.push(await fn());
  return summarise(name, timings, extra);
}

/** Every delta page from 0, at the server's default page size, as a new phone pulls. */
async function fullPull(token) {
  let since = '0';
  let pages = 0;
  let bytes = 0;
  let changes = 0;
  let ms = 0;
  for (;;) {
    const response = await call('GET', `/sync/delta?since=${since}`, token);
    if (response.status !== 200) throw new Refused(`delta answered ${response.status}`);
    ms += response.ms;
    pages += 1;
    bytes += response.bytes;
    changes += response.body.changes.length;
    since = response.body.cursor;
    if (!response.body.hasMore) return { pages, bytes, changes, ms };
  }
}

/** A plain aligned table: the numbers first, any shape notes after. */
function formatTable(rows) {
  const columns = ['name', 'n', 'p50', 'p95', 'p99', 'max', 'mean'];
  const notes = (row) =>
    Object.entries(row)
      .filter(([key]) => !columns.includes(key))
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
  const cells = [
    columns.concat('notes'),
    ...rows.map((row) => columns.map((key) => String(row[key])).concat(notes(row))),
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
  const buildCommit = await assertDevelopmentStack();
  const runId = randomUUID().slice(0, 8);
  const now = Date.now();
  const results = [];
  const log = (line) => process.stderr.write(`${line}\n`);

  log(`API ${API_URL} at ${buildCommit}, run ${runId}`);
  const patients = [];
  for (const [kind, perDay] of Object.entries(DENSITIES)) {
    const patient = await provision(kind, runId);
    const operations = history(perDay, now);
    const batchTimings = [];
    for (let i = 0; i < operations.length; i += BATCH_SIZE) {
      const batch = operations.slice(i, i + BATCH_SIZE);
      const result = await call('POST', '/sync/push', patient.token, { operations: batch });
      assertAccepted(result, `seeding ${patient.subject}`);
      if (batch.length === BATCH_SIZE) batchTimings.push(result.ms);
    }
    results.push(summarise(`POST /sync/push, ${BATCH_SIZE} operations (${kind})`, batchTimings));
    log(`seeded ${patient.subject}: ${operations.length} entries over ${HISTORY_DAYS} days`);
    patients.push({ ...patient, entries: operations.length });
  }

  // Reads first, so the history they measure is exactly the seeded one.
  for (const patient of patients) {
    const { ms: _first, ...shape } = await fullPull(patient.token);
    results.push(
      await measure(
        `GET /sync/delta, full first pull (${patient.kind})`,
        async () => (await fullPull(patient.token)).ms,
        { samples: Math.max(20, Math.round(args.samples / 10)), warmup: 2 },
        shape,
      ),
    );
    for (const days of [30, 90]) {
      const from = new Date(now - days * DAY_MS).toISOString();
      const to = new Date(now).toISOString();
      const path = `/observations?effectiveDateTimeFrom=${from}&effectiveDateTimeTo=${to}&limit=500`;
      const probe = await call('GET', path, patient.token);
      if (probe.status !== 200) throw new Refused(`list answered ${probe.status}`);
      const returned = probe.body.observations.length;
      results.push(
        await measure(
          `GET /observations, ${days} days (${patient.kind})`,
          async () => (await call('GET', path, patient.token)).ms,
          args,
          {
            returned,
            bytes: probe.bytes,
            // The list caps a page at 500 and has no cursor: a window holding more
            // than that cannot be read in one request (a finding for P5.S1).
            truncated: returned >= 500,
          },
        ),
      );
    }
  }

  const typical = patients[0];
  results.push(
    await measure(
      'POST /sync/push, 1 operation',
      async () => {
        const response = await call('POST', '/sync/push', typical.token, {
          operations: [entry(0, new Date(now - DAY_MS / 2))],
        });
        assertAccepted(response, 'single push');
        return response.ms;
      },
      args,
    ),
  );
  results.push(
    await measure(
      'POST /observations',
      async () => {
        const { payload } = entry(0, new Date(now - DAY_MS / 2));
        const response = await call('POST', '/observations', typical.token, payload);
        if (response.status !== 201)
          throw new Refused(`POST /observations answered ${response.status}`);
        return response.ms;
      },
      args,
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
