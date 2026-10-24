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
 * P4.S5 slice 3 (#158): summarises the phone's measurements.
 *
 *   node scripts/perf/summarise-marks.mjs <file>... [--json out.json]
 *
 * Reads what `phone-baseline.sh` collected: `perf:<name> <ms>` lines from
 * logcat, and `TotalTime: <ms>` lines from `am start -W` (reported as
 * `cold-start`). Prints, per name, n and nearest-rank p50/p95 (p99 only from
 * 100 samples, where it is not simply the maximum), the same convention as
 * `api-baseline.mjs`.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const jsonAt = args.indexOf('--json');
const jsonPath = jsonAt === -1 ? undefined : args[jsonAt + 1];
const files = args.filter((_, i) => jsonAt === -1 || (i !== jsonAt && i !== jsonAt + 1));
if (files.length === 0) {
  process.stderr.write('usage: summarise-marks.mjs <file>... [--json out.json]\n');
  process.exit(2);
}

const samples = new Map();
const add = (name, ms) => samples.set(name, [...(samples.get(name) ?? []), ms]);

for (const file of files) {
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const mark = line.match(/perf:([a-z0-9-]+) (\d+(?:\.\d+)?)\s*$/);
    if (mark !== null) add(mark[1], Number(mark[2]));
    const start = line.match(/TotalTime: (\d+)/);
    if (start !== null) add('cold-start', Number(start[1]));
  }
}

const round = (ms) => Math.round(ms * 10) / 10;
const results = [...samples.entries()].map(([name, values]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  return {
    name,
    n: sorted.length,
    min: round(sorted[0]),
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    p99: sorted.length >= 100 ? round(at(0.99)) : null,
    max: round(sorted.at(-1)),
    samples: values.map(round),
  };
});

for (const row of results) {
  console.log(
    [
      row.name.padEnd(20),
      `n=${row.n}`,
      `min=${row.min}`,
      `p50=${row.p50}`,
      `p95=${row.p95}`,
      `p99=${row.p99 ?? '-'}`,
      `max=${row.max}`,
    ].join('  '),
  );
}
if (jsonPath !== undefined) writeFileSync(jsonPath, `${JSON.stringify(results, null, 2)}\n`);
