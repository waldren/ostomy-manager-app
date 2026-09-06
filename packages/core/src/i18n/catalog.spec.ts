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

import { TIER1_RULE_CODE, TIER2_RULE_CODE } from '../validation/index.js';
import { en, NAMESPACES } from './index.js';

describe('i18n catalog structure (ADR-0006)', () => {
  it('declares validationErrors, validationWarnings and redFlags as separate namespaces, not adjacent keys in one', () => {
    expect(NAMESPACES).toContain('validationErrors');
    expect(NAMESPACES).toContain('validationWarnings');
    expect(NAMESPACES).toContain('redFlags');
    // Structurally separate objects, not the same object referenced twice.
    expect(en.validationErrors).not.toBe(en.validationWarnings);
    expect(en.validationWarnings).not.toBe(en.redFlags);
    expect(en.validationErrors).not.toBe(en.redFlags);
  });

  it('every Tier 1 rule code has exactly one validationErrors entry, and never appears in validationWarnings or redFlags', () => {
    const tier1Codes = Object.values(TIER1_RULE_CODE).sort();
    expect(Object.keys(en.validationErrors).sort()).toEqual(tier1Codes);
    for (const code of tier1Codes) {
      expect(en.validationWarnings).not.toHaveProperty(code);
      expect(en.redFlags).not.toHaveProperty(code);
    }
  });

  it('every Tier 2 rule code has exactly one validationWarnings entry, and never appears in validationErrors or redFlags', () => {
    const tier2Codes = Object.values(TIER2_RULE_CODE).sort();
    expect(Object.keys(en.validationWarnings).sort()).toEqual(tier2Codes);
    for (const code of tier2Codes) {
      expect(en.validationErrors).not.toHaveProperty(code);
      expect(en.redFlags).not.toHaveProperty(code);
    }
  });

  it('the red-flag namespace is reserved and empty — no red-flag copy exists until P7, and none is fabricated here', () => {
    expect(en.redFlags).toEqual({});
  });

  it('the clinical-caveats namespace is reserved and empty — no caveat copy exists until P7, and none is fabricated here (S6)', () => {
    expect(en.clinicalCaveats).toEqual({});
  });

  it('warning copy asks for confirmation and never states a blocking instruction, and never scolds (nits: extended deny-list)', () => {
    const denyList =
      /\b(must|required|invalid|error|too (?:high|low|much|many)|incorrect|wrong|failed|are you sure|you (?:should|need to|must))\b/;
    for (const message of Object.values(en.validationWarnings)) {
      expect(message.toLowerCase()).not.toMatch(denyList);
    }
  });

  it('no catalog key contains a digit — values interpolate into messages, identifiers never do (ADR-0006)', () => {
    for (const namespace of Object.values(en)) {
      for (const key of Object.keys(namespace)) {
        expect(key).not.toMatch(/\d/);
      }
    }
  });
});
