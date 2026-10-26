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
 * `docs/compliance/real-data-readiness.md`, read as the gate on
 * `init --classification real` (ADR-0022 item 1).
 *
 * The caller passes the file's text as it is inside the signed release tag,
 * never a working copy: the cell format is not a signature, and what makes a
 * sign-off one is that it was committed under a tag signed in the operator
 * environment (item 3).
 *
 * Everything here fails closed. A row whose cell is not exactly
 * `Name, YYYY-MM-DD` is unsigned, and a file this cannot read as the table it
 * expects refuses the gate rather than passing it with nothing to check.
 */
import { Refusal } from './errors.ts';

export const READINESS_PATH = 'docs/compliance/real-data-readiness.md';

export interface ReadinessRow {
  id: string;
  /** The item's first sentence, for the refusal message. */
  summary: string;
  signedOff: string;
  signed: boolean;
}

const HEADER = /^\|\s*ID\s*\|\s*Item\s*\|\s*Evidence required\s*\|\s*Signed off\s*\|\s*$/;
const ROW = /^\|\s*(RD-\d+)\s*\|/;
/**
 * A readiness row however it is written: with or without a leading pipe
 * (GitHub renders both as a table row) and with its ID bold or in code.
 */
const ROW_ANYWHERE = /^\s*\|?\s*[*`_]*RD-\d+\b[*`_]*\s*\|/;

/** `Name, YYYY-MM-DD`, with a date that exists. Nothing else counts. */
export function isSignature(cell: string): boolean {
  const match = /^([^,|<>]*\S),\s(\d{4})-(\d{2})-(\d{2})$/.exec(cell.trim());
  if (!match) return false;
  const [, name, year, month, day] = match;
  if (!/[A-Za-z]/.test(name!)) return false;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return (
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day)
  );
}

/** Splits a Markdown table row into its cells, without the outer pipes. */
function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

export function parseReadiness(markdown: string): ReadinessRow[] {
  const lines = markdown.split(/\r?\n/);
  const headerAt = lines.findIndex((line) => HEADER.test(line));
  if (headerAt === -1) {
    throw new Refusal(
      `${READINESS_PATH}: no readiness table (| ID | Item | Evidence required | Signed off |)`,
    );
  }
  const rows: ReadinessRow[] = [];
  const seen = new Set<string>();
  // The header, then the separator, then rows until the table ends.
  let end = lines.length;
  for (const [offset, line] of lines.slice(headerAt + 2).entries()) {
    if (!line.trim().startsWith('|')) {
      end = headerAt + 2 + offset;
      break;
    }
    const match = ROW.exec(line);
    const row = cells(line);
    if (!match || row.length !== 4) {
      throw new Refusal(`${READINESS_PATH}: a table row this cannot read: ${line.slice(0, 80)}`);
    }
    const id = match[1]!;
    if (seen.has(id)) throw new Refusal(`${READINESS_PATH}: ${id} appears twice`);
    seen.add(id);
    const signedOff = row[3]!;
    const summary = (/\*\*(.+?)\*\*/.exec(row[1]!)?.[1] ?? row[1]!).slice(0, 100);
    rows.push({ id, summary, signedOff, signed: isSignature(signedOff) });
  }
  if (rows.length === 0) throw new Refusal(`${READINESS_PATH}: the readiness table has no rows`);
  // A table split by a blank line or a heading would otherwise end the parse
  // early, and every row after the split would go unchecked: fail open.
  const outside = [...lines.slice(0, headerAt), ...lines.slice(end)].filter((line) =>
    ROW_ANYWHERE.test(line),
  );
  if (outside.length > 0) {
    throw new Refusal(
      `${READINESS_PATH}: readiness rows outside the one table, which this does not read:\n` +
        outside.map((line) => `  ${line.trim().slice(0, 80)}`).join('\n'),
    );
  }
  // A row is removed only by an ADR (ADR-0022 item 1), and the gate reads the
  // tag, which never has to pass CI. So deleting an unsigned row from a tag
  // must fail here, not pass. An ADR that retires a row changes this check.
  const gap = rows.findIndex((row, index) => row.id !== `RD-${index + 1}`);
  if (gap !== -1) {
    throw new Refusal(
      `${READINESS_PATH}: expected RD-${gap + 1} where ${rows[gap]!.id} is. ` +
        'Rows are numbered from RD-1 with no gaps, and one is removed only by an ADR.',
    );
  }
  return rows;
}

/** Refuses, naming every unsigned row, unless all are signed. */
export function requireAllSigned(markdown: string, releaseName: string): ReadinessRow[] {
  const rows = parseReadiness(markdown);
  const unsigned = rows.filter((row) => !row.signed);
  if (unsigned.length > 0) {
    throw new Refusal(
      `${releaseName}'s ${READINESS_PATH} has ${unsigned.length} of ${rows.length} items unsigned, ` +
        'so no real-data host can be initialised from it (ADR-0022 item 1):\n' +
        unsigned.map((row) => `  ${row.id}  ${row.summary}`).join('\n'),
    );
  }
  return rows;
}
