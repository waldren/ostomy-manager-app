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

import { describe, expect, it } from 'vitest';

import { Unreachable } from './errors.ts';
import { pipe, run } from './process.ts';

const node = (script: string) => ({ command: process.execPath, args: ['-e', script] });

// Far more than an OS pipe buffer holds, so a producer nobody reads blocks.
const FLOOD = node(
  'const chunk = Buffer.alloc(1 << 20); let n = 0;' +
    'const go = () => { while (n < 200) { n++; if (!process.stdout.write(chunk)) return process.stdout.once("drain", go); } };' +
    'go();',
);

describe('pipe', () => {
  it('passes the producer’s output to the consumer, and reports both exit codes', async () => {
    const result = await pipe(
      node('process.stdout.write("hello")'),
      node(
        'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => process.stdout.write(s.toUpperCase()))',
      ),
    );
    expect(result.producer.code).toBe(0);
    expect(result.consumer).toMatchObject({ code: 0, stdout: 'HELLO' });
  });

  // ssh exiting mid-transfer: the network dropped, or the host refused.
  it('settles when the consumer exits before reading everything, rather than hanging', async () => {
    const result = await pipe(FLOOD, node('process.exit(3)'));
    expect(result.consumer.code).toBe(3);
    expect(result.producer.code).not.toBe(0);
  }, 20_000);

  it('rejects as unreachable when either side is not installed', async () => {
    await expect(pipe(FLOOD, { command: 'ostomy-no-such-command', args: [] })).rejects.toThrow(
      Unreachable,
    );
    await expect(pipe({ command: 'ostomy-no-such-command', args: [] }, node(''))).rejects.toThrow(
      Unreachable,
    );
  }, 20_000);
});

describe('run', () => {
  it('feeds input and collects output', async () => {
    const result = await run(node('process.stdin.pipe(process.stdout)'), { input: 'x' });
    expect(result).toMatchObject({ code: 0, stdout: 'x' });
  });
});
