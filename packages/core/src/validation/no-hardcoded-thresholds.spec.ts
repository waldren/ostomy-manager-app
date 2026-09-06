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

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));

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
 * Scoped to the rule-evaluation modules only — not thresholds.ts, which
 * legitimately names the SHAPE of a threshold without ever assigning one a
 * value, and not this file or volumetric.spec.ts, which legitimately use
 * example numbers as test fixtures.
 *
 * `0` is excluded: `rawValue <= 0` in tier1.ts is the structural invariant
 * "a real volume is positive," not an admin-configurable bound — see
 * tier1.ts's own comment on `checkValueIsPositive`.
 */
const RULE_MODULES = ['tier1.ts', 'tier2.ts', 'volumetric.ts'];

function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""');
}

describe('threshold injection — no hardcoded numeric thresholds in the rule-evaluation modules', () => {
  it.each(RULE_MODULES)('%s contains no numeric literal other than 0', (fileName) => {
    const source = stripCommentsAndStrings(readFileSync(join(HERE, fileName), 'utf8'));
    const numericLiterals = source.match(/(?<![\w.])\d+(?:\.\d+)?(?![\w])/g) ?? [];
    const suspicious = numericLiterals.filter((literal) => literal !== '0');

    expect(
      suspicious,
      `${fileName} appears to contain a hardcoded numeric threshold: ${suspicious.join(', ')}. ` +
        'Thresholds must come from VolumetricValidationThresholds, injected by the caller, never a literal in the rule module.',
    ).toEqual([]);
  });
});
