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

const HERE = dirname(fileURLToPath(import.meta.url));
const THIS_FILE = basename(fileURLToPath(import.meta.url));

/**
 * "Thresholds are injected data, never constants" (CLAUDE.md, docs/testing.md
 * "Threshold injection": "A test that hardcodes an expected bound is
 * asserting the wrong thing — parameterize it"). volumetric.spec.ts proves
 * injection behaviourally (a different injected value changes the
 * outcome); this test proves the complementary static fact — that the
 * rule-evaluation modules themselves contain no numeric literal a
 * threshold could have been typed into instead of read from
 * `VolumetricValidationThresholds`.
 *
 * S4 (this sprint's review) replaced a hardcoded three-element file list
 * with a directory scan minus an explicit, justified allowlist: the
 * structural risk was that a future `weight.ts` or `heartRate.ts` rule
 * module would silently go unscanned by accident, not by adversarial
 * intent. A directory-wide scan also incidentally closes the "hardcode the
 * threshold in a new sibling file and import it" evasion — that sibling
 * file is itself unscanned only if someone deliberately adds it to the
 * allowlist below, which requires the same justification thresholds.ts,
 * types.ts and index.ts already carry in comments.
 *
 * This static check is a supplement, not the primary guarantee — the
 * behavioural injection tests in volumetric.spec.ts (a different injected
 * threshold changes the outcome for the same input) are the stronger
 * property: they would fail even for a threshold hardcoded via a route
 * this static scan cannot see (e.g. a value read from an un-typed
 * environment variable). Keep both.
 */
const ALLOWLISTED_NON_RULE_FILES = new Set([
  // Legitimately names the threshold SHAPE and never assigns one a value.
  'thresholds.ts',
  // Type-only: interfaces and type aliases, no runtime literal is possible.
  'types.ts',
  // A barrel: re-exports only, no rule-evaluation logic of its own.
  'index.ts',
]);

function isSpecOrTypeTestFile(fileName: string): boolean {
  return fileName.endsWith('.spec.ts') || fileName.endsWith('.type-test.ts');
}

const ruleModuleFileNames = readdirSync(HERE)
  .filter((name) => name.endsWith('.ts'))
  .filter((name) => name !== THIS_FILE)
  .filter((name) => !isSpecOrTypeTestFile(name))
  .filter((name) => !ALLOWLISTED_NON_RULE_FILES.has(name));

function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""');
}

/**
 * Matches every JS/TS numeric literal FORM, not just plain decimals — the
 * three evasions a reviewer found by running the original pattern against
 * adversarial input: a numeric separator (`2_000`), an exponent (`1e3`),
 * a hex literal (`0x7D0`), and a BigInt literal (`2000n`) all previously
 * slipped through a pattern that only recognised `\d+(\.\d+)?`.
 */
const NUMERIC_LITERAL_PATTERN =
  /\b0[xX][0-9a-fA-F_]+n?\b|\b0[bB][01_]+n?\b|\b0[oO][0-7_]+n?\b|(?<![\w.$])\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d[\d_]*)?n?(?![\w$])/g;

/**
 * Normalises any of the literal forms above to a JS number, so "is this
 * literal zero" (the one exempt value — see tier1.ts's
 * `checkValueIsPositive` comment) is decided on VALUE, not on which of the
 * many equivalent spellings of zero a literal happens to use.
 */
function literalNumericValue(literal: string): number {
  const withoutSeparators = literal.replace(/_/g, '');
  const withoutBigIntSuffix = withoutSeparators.endsWith('n')
    ? withoutSeparators.slice(0, -1)
    : withoutSeparators;
  return Number(withoutBigIntSuffix);
}

describe('threshold injection — no hardcoded numeric thresholds in the rule-evaluation modules', () => {
  it('discovers at least the known rule modules — proof the directory scan is not accidentally empty', () => {
    expect(ruleModuleFileNames).toEqual(
      expect.arrayContaining(['tier1.ts', 'tier2.ts', 'volumetric.ts']),
    );
  });

  it.each(ruleModuleFileNames)('%s contains no numeric literal other than 0', (fileName) => {
    const source = stripCommentsAndStrings(readFileSync(join(HERE, fileName), 'utf8'));
    const numericLiterals = source.match(NUMERIC_LITERAL_PATTERN) ?? [];
    const suspicious = numericLiterals.filter((literal) => literalNumericValue(literal) !== 0);

    expect(
      suspicious,
      `${fileName} appears to contain a hardcoded numeric threshold: ${suspicious.join(', ')}. ` +
        'Thresholds must come from VolumetricValidationThresholds, injected by the caller, never a literal in the rule module.',
    ).toEqual([]);
  });

  describe("adversarial literal forms are all caught (regression coverage for this sprint's review)", () => {
    it.each([
      ['numeric separator', '2_000'],
      ['exponent', '1e3'],
      ['hex', '0x7D0'],
      ['BigInt suffix', '2000n'],
    ])('%s literal %s is detected as non-zero', (_label, literal) => {
      const matches = literal.match(NUMERIC_LITERAL_PATTERN) ?? [];
      expect(matches.length).toBeGreaterThan(0);
      expect(literalNumericValue(matches[0] as string)).not.toBe(0);
    });

    it('the exempt literal "0" in any of its forms is still recognised as zero', () => {
      for (const zero of ['0', '0x0', '0_0', '0.0']) {
        const matches = zero.match(NUMERIC_LITERAL_PATTERN) ?? [];
        expect(matches.length).toBeGreaterThan(0);
        expect(literalNumericValue(matches[0] as string)).toBe(0);
      }
    });
  });
});
