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

/** The real-data gate (ADR-0022 item 1), against the committed checklist itself. */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { isSignature, parseReadiness, READINESS_PATH, requireAllSigned } from './readiness.ts';
import { SELFHOST_ROOT } from '../src/compose-file.ts';

const committed = readFileSync(path.join(SELFHOST_ROOT, '../..', READINESS_PATH), 'utf8');

/** The committed checklist with every row's sign-off cell replaced. */
const withSignOff = (cell: (id: string) => string) =>
  committed.replace(
    /^(\| (RD-\d+) \|.*\| )([^|]*)( \|)$/gm,
    (_line, start: string, id: string, _old, end: string) => `${start}${cell(id)}${end}`,
  );

describe('the committed readiness checklist', () => {
  it('parses into its RD rows, in order, with no gaps', () => {
    const rows = parseReadiness(committed);
    expect(rows.length).toBeGreaterThanOrEqual(24);
    expect(rows.map((row) => row.id)).toEqual(rows.map((_row, index) => `RD-${index + 1}`));
  });

  it('refuses a real host today, naming every unsigned row', () => {
    expect(() => requireAllSigned(committed, 'v1.0.0')).toThrow(/24 of 24 items unsigned/);
    expect(() => requireAllSigned(committed, 'v1.0.0')).toThrow(
      /RD-1 {2}The clinical numbers are ratified/,
    );
  });

  it('passes once every row carries a dated name', () => {
    expect(
      requireAllSigned(
        withSignOff(() => 'Pat Officer, 2026-11-01'),
        'v1.0.0',
      ),
    ).toHaveLength(24);
  });

  it('names exactly the rows still unsigned', () => {
    const one = withSignOff((id) => (id === 'RD-7' ? '—' : 'Pat Officer, 2026-11-01'));
    expect(() => requireAllSigned(one, 'v1.0.0')).toThrow(/1 of 24 items unsigned[\s\S]*RD-7 /);
  });
});

describe('isSignature', () => {
  it.each(['Pat Officer, 2026-11-01', 'Dr. A. Clinician-Reviewer, 2027-02-28'])(
    'accepts %s',
    (cell) => {
      expect(isSignature(cell)).toBe(true);
    },
  );

  it.each([
    '—',
    '',
    'TBD',
    'Pat Officer',
    'Pat Officer 2026-11-01',
    'Pat Officer, 2026-02-30',
    'Pat Officer, 26-11-01',
    ', 2026-11-01',
    '1234, 2026-11-01',
    '<!-- Pat Officer -->, 2026-11-01',
    'Pat Officer, 2026-11-01 (pending)',
  ])('refuses %j', (cell) => {
    expect(isSignature(cell)).toBe(false);
  });
});

describe('a checklist this cannot read fails closed', () => {
  it.each([
    ['no table', '# Real-data readiness\n\nNothing here.\n'],
    [
      'a header with no rows',
      '| ID | Item | Evidence required | Signed off |\n|---|---|---|---|\n\nAfter.\n',
    ],
    [
      'a row with a cell missing',
      '| ID | Item | Evidence required | Signed off |\n|---|---|---|---|\n| RD-1 | x | Pat, 2026-11-01 |\n',
    ],
    [
      'a duplicated ID',
      '| ID | Item | Evidence required | Signed off |\n|---|---|---|---|\n| RD-1 | a | b | Pat O, 2026-11-01 |\n| RD-1 | a | b | Pat O, 2026-11-01 |\n',
    ],
  ])('%s', (_name, markdown) => {
    expect(() => requireAllSigned(markdown, 'v1.0.0')).toThrow();
  });

  // A blank line ends a Markdown table. Read naively, every row after it
  // would go unchecked, and the gate would pass with RD-7 unsigned.
  it.each([
    ['a blank line', '\n'],
    [
      'a heading',
      '\n## More\n\n| ID | Item | Evidence required | Signed off |\n|---|---|---|---|\n',
    ],
  ])('refuses rows split from the table by %s', (_name, split) => {
    const signed = withSignOff((id) => (id === 'RD-7' ? '—' : 'Pat Officer, 2026-11-01'));
    const rd7 = /^\| RD-7 \|.*$/m.exec(signed)![0];
    const moved = signed
      .replace(`${rd7}\n`, '')
      .replace(/^(\| RD-24 \|.*)$/m, (row) => `${row}\n${split}${rd7}`);
    expect(moved).not.toBe(signed);
    expect(() => requireAllSigned(moved, 'v1.0.0')).toThrow(/outside the one table[\s\S]*RD-7/);
  });

  // GitHub renders each of these as a row of the table above it, so each
  // must be read as one rather than skipped.
  it.each([
    ['with no leading pipe', (row: string) => row.replace(/^\| /, '')],
    ['with its ID in bold', (row: string) => row.replace('| RD-7 |', '| **RD-7** |')],
    ['with its ID in code', (row: string) => row.replace('| RD-7 |', '| `RD-7` |')],
  ])('refuses a row moved outside the table %s', (_name, reshape) => {
    const signed = withSignOff((id) => (id === 'RD-7' ? '—' : 'Pat Officer, 2026-11-01'));
    const rd7 = /^\| RD-7 \|.*$/m.exec(signed)![0];
    const moved = signed
      .replace(`${rd7}\n`, '')
      .replace(/^(\| RD-24 \|.*)$/m, (row) => `${row}\n\n${reshape(rd7)}`);
    expect(() => requireAllSigned(moved, 'v1.0.0')).toThrow(/outside the one table/);
  });

  // The gate reads the tag, which never has to pass CI's own check of this.
  it('refuses a checklist with an unsigned row deleted', () => {
    const signed = withSignOff((id) => (id === 'RD-7' ? '—' : 'Pat Officer, 2026-11-01'));
    const deleted = signed.replace(/^\| RD-7 \|.*\n/m, '');
    expect(() => requireAllSigned(deleted, 'v1.0.0')).toThrow(/expected RD-7 where RD-8 is/);
  });
});
