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

import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * "This package names shapes, never values."
 *
 * `src/validation/no-hardcoded-thresholds.spec.ts` makes the same static
 * check over the rule-evaluation modules, but it scans its own directory
 * and cannot see this one — extending it would mean editing a path
 * `react-web-developer` owns (ADR-0007), so this is the sibling rather
 * than a shared helper; factoring one out needs a dispatch to that owner.
 *
 * The values this guards against are specific and all named in
 * `docs/sync-contract.md` as configuration: `SYNC_PUSH_MAX_OPERATIONS`
 * (§3.3, environment configuration), the delta page size default and
 * maximum (§5.1), `sync_clock_skew_allowance_seconds` (§3.8, a
 * `validation_thresholds` row, ADR-0001 point 5), and the set of LOINC
 * codes a release accepts (§7.2, an admin-managed value set). Every one of
 * them is a plausible, well-meant addition to a types module — a constant
 * two consumers could share — and every one of them would put a clinical
 * or fleet-tunable bound behind a deploy.
 *
 * This is a supplement, not the primary guarantee: it cannot see a bound
 * that arrives as a string or an environment read. The primary guarantee
 * is that `apps/api` resolves all four from configuration, which its own
 * tests assert.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const THIS_FILE = basename(fileURLToPath(import.meta.url));

/**
 * Nothing is allowlisted. `src/validation`'s equivalent exempts
 * `thresholds.ts`, `types.ts` and `index.ts`; this directory has no file
 * that needs a numeric literal at all, so an exemption here would be
 * granting one before there is anything to grant it to.
 */
const ALLOWLISTED_FILES: ReadonlySet<string> = new Set<string>();

function isSpecOrTypeTestFile(fileName: string): boolean {
  return fileName.endsWith('.spec.ts') || fileName.endsWith('.type-test.ts');
}

const scannedFileNames = readdirSync(HERE)
  .filter((name) => name.endsWith('.ts'))
  .filter((name) => name !== THIS_FILE)
  .filter((name) => !isSpecOrTypeTestFile(name))
  .filter((name) => !ALLOWLISTED_FILES.has(name));

/**
 * Regex literals are stripped alongside comments and strings, which the
 * `src/validation` sibling does not need to do. The lexical shape patterns
 * in `identifiers.ts` (`{8}`, `{4}`, `{12}` in a UUID pattern) are
 * quantifiers describing a text format, not bounds — treating them as
 * thresholds would force an allowlist entry that then exempts the whole
 * file, which is strictly worse. `stripsARegexLiteral` below tests this
 * stripper directly, including that it does not swallow an ordinary
 * assignment.
 *
 * The leading-context group is what distinguishes a regex literal from a
 * division: a regex literal can only appear where an expression can start.
 */
const REGEX_LITERAL_PATTERN =
  /(^|[=(,:[!&|?{};+\-*%<>~^]|\breturn\b|\btypeof\b)(\s*)\/(?![*/])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n])+\/[dgimsuvy]*/g;

function stripCommentsStringsAndRegexes(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""')
    .replace(REGEX_LITERAL_PATTERN, '$1$2RE');
}

/** Same literal-form coverage as the `src/validation` sibling: separators, exponents, hex, binary, octal and BigInt suffixes all count. */
const NUMERIC_LITERAL_PATTERN =
  /\b0[xX][0-9a-fA-F_]+n?\b|\b0[bB][01_]+n?\b|\b0[oO][0-7_]+n?\b|(?<![\w.$])\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d[\d_]*)?n?(?![\w$])/g;

describe('src/sync names shapes, never values', () => {
  it('discovers the known wire-type modules — proof the directory scan is not accidentally empty', () => {
    expect(scannedFileNames).toEqual(
      expect.arrayContaining([
        'delta.ts',
        'fieldPaths.ts',
        'identifiers.ts',
        'index.ts',
        'payload.ts',
        'push.ts',
        'reasonCodes.ts',
      ]),
    );
  });

  it.each(scannedFileNames)('%s contains no numeric literal', (fileName) => {
    const source = stripCommentsStringsAndRegexes(readFileSync(join(HERE, fileName), 'utf8'));
    const literals = source.match(NUMERIC_LITERAL_PATTERN) ?? [];

    expect(
      literals,
      `${fileName} contains a numeric literal: ${literals.join(', ')}. ` +
        'SYNC_PUSH_MAX_OPERATIONS, the delta page size, sync_clock_skew_allowance_seconds and the ' +
        'accepted LOINC value set are all configuration read by apps/api, never constants here.',
    ).toEqual([]);
  });

  describe('the stripper this check depends on', () => {
    it('strips a regex literal, quantifiers included', () => {
      const stripped = stripCommentsStringsAndRegexes('const P = /^[0-9a-f]{8}-[0-9]{12}$/i;');
      expect(stripped.match(NUMERIC_LITERAL_PATTERN)).toBeNull();
    });

    it('does not swallow an ordinary numeric assignment', () => {
      const stripped = stripCommentsStringsAndRegexes('const MAX_OPERATIONS = 500;');
      expect(stripped.match(NUMERIC_LITERAL_PATTERN)).toEqual(['500']);
    });

    it('does not swallow a bound hidden in an adversarial literal form', () => {
      for (const source of [
        'const a = 2_000;',
        'const b = 1e3;',
        'const c = 0x7d0;',
        'const d = 2000n;',
      ]) {
        expect(
          stripCommentsStringsAndRegexes(source).match(NUMERIC_LITERAL_PATTERN),
        ).not.toBeNull();
      }
    });

    it('does not treat a division as a regex literal and hide the operands', () => {
      const stripped = stripCommentsStringsAndRegexes('const ratio = total / 1000;');
      expect(stripped.match(NUMERIC_LITERAL_PATTERN)).toEqual(['1000']);
    });
  });
});
