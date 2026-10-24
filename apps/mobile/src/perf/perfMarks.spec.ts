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
 * The P4.S5 perf marks (#158): silent without the build flag, and saying
 * nothing but a name and a number with it.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import type { SqliteExecutor } from '../db/executor';

type PerfMarks = typeof import('./perfMarks');
type HistoryProbe = typeof import('./historyProbe');

const MOBILE_ROOT = join(__dirname, '..', '..');
/** The whole of what a mark may print. */
const MARK_LINE = /^perf:[a-z0-9-]+ \d+\.\d$/;

let logSpy: jest.SpyInstance;
const originalFlag = process.env.EXPO_PUBLIC_PERF_MARKS;

/** A fresh copy of the modules, with the flag as a build would have inlined it. */
function load(flag: string | undefined): { marks: PerfMarks; probe: HistoryProbe } {
  if (flag === undefined) delete process.env.EXPO_PUBLIC_PERF_MARKS;
  else process.env.EXPO_PUBLIC_PERF_MARKS = flag;
  let loaded!: { marks: PerfMarks; probe: HistoryProbe };
  jest.isolateModules(() => {
    loaded = {
      marks: jest.requireActual<PerfMarks>('./perfMarks'),
      probe: jest.requireActual<HistoryProbe>('./historyProbe'),
    };
  });
  return loaded;
}

function recordingExecutor(): SqliteExecutor & { queries: unknown[][] } {
  const queries: unknown[][] = [];
  return {
    queries,
    getAllAsync: async (sql: string, params?: readonly unknown[]) => {
      queries.push([sql, ...(params ?? [])]);
      return [];
    },
  } as unknown as SqliteExecutor & { queries: unknown[][] };
}

beforeEach(() => {
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  logSpy.mockRestore();
  if (originalFlag === undefined) delete process.env.EXPO_PUBLIC_PERF_MARKS;
  else process.env.EXPO_PUBLIC_PERF_MARKS = originalFlag;
});

describe('without EXPO_PUBLIC_PERF_MARKS', () => {
  it.each([[undefined], ['0'], ['true']])('writes nothing when the flag is %s', async (flag) => {
    const { marks } = load(flag);

    marks.startSpan('save-write');
    marks.endSpan('save-write');
    const value = await marks.timeAsync('sync-cycle', async () => 42);

    expect(value).toBe(42);
    expect(marks.perfMarksEnabled()).toBe(false);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('runs no history query at all', async () => {
    const { probe } = load(undefined);
    const executor = recordingExecutor();

    await probe.runHistoryProbeOnce(executor);

    expect(executor.queries).toEqual([]);
    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe('with EXPO_PUBLIC_PERF_MARKS=1', () => {
  it('writes one line per span: the name and a duration, nothing else', () => {
    const { marks } = load('1');

    marks.startSpan('save-confirmed');
    marks.endSpan('save-confirmed');

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]).toHaveLength(1);
    expect(logSpy.mock.calls[0][0]).toMatch(MARK_LINE);
    expect(logSpy.mock.calls[0][0]).toMatch(/^perf:save-confirmed /);
  });

  it('writes nothing for a span that was never started, or already ended', () => {
    const { marks } = load('1');

    marks.endSpan('unlock-to-home');
    marks.startSpan('unlock-to-home');
    marks.endSpan('unlock-to-home');
    marks.endSpan('unlock-to-home');

    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it('times a step that fails, and still throws its error', async () => {
    const { marks } = load('1');

    await expect(
      marks.timeAsync('sync-cycle', async () => {
        throw new Error('offline');
      }),
    ).rejects.toThrow('offline');

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toMatch(/^perf:sync-cycle \d+\.\d$/);
  });

  it('runs the 90-day history read once per launch, for each code, and reports only its duration', async () => {
    const { probe } = load('1');
    const executor = recordingExecutor();

    await probe.runHistoryProbeOnce(executor);
    await probe.runHistoryProbeOnce(executor);

    expect(executor.queries.map((query) => query[1])).toEqual(['79560-9', '9000-1', '9187-6']);
    for (const query of executor.queries) {
      expect(query[0]).toMatch(/deleted_at IS NULL AND local_date >= \?/);
      expect(query[2]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toMatch(/^perf:history-90d-query \d+\.\d$/);
  });
});

describe('what makes the flag a build-time switch', () => {
  /**
   * Expo inlines `process.env.EXPO_PUBLIC_X` only when written exactly like
   * that. A bracket access or a destructure is left alone and reads
   * `undefined` on a device, so the marks would silently never fire.
   */
  it('reads the flag as a literal property access', () => {
    const source = readFileSync(join(__dirname, 'perfMarks.ts'), 'utf8');

    expect(source).toMatch(/process\.env\.EXPO_PUBLIC_PERF_MARKS === '1'/);
  });

  /**
   * `no-console` is an error in shipped code because the realistic PHI leak is
   * a handler logging a payload. The marks are the one exception, and they
   * stay the only one.
   */
  it('makes the perf marks the only place the app may write to the console', () => {
    const files = ['app', 'src'].flatMap((dir) => sourceFiles(join(MOBILE_ROOT, dir)));
    const exempted = files
      .filter((file) => /eslint-disable[^\n]*no-console/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(MOBILE_ROOT, file).replace(/\\/g, '/'));

    expect(exempted).toEqual(['src/perf/perfMarks.ts']);
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.spec\.tsx?$/.test(name) ? [path] : [];
  });
}
