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

import { ESTIMATION_METHOD_CODE, type EstimationMethodCode } from './estimationMethod.js';

describe('AC 2.5 AC2 — Estimation technique SNOMED code (D4, resolved)', () => {
  /**
   * SNOMED CT `414135002` |Estimated (qualifier value)|, per ADR-0018.
   *
   * Pinned to the literal rather than compared against the constant itself,
   * which would assert nothing. Changing this value is a data MIGRATION, not
   * an edit: rows already written carry the old code and nothing detects the
   * disagreement until FHIR export or EHR integration, which is the failure
   * mode D4 existed to avoid.
   */
  it('is resolved to the code ADR-0018 records', () => {
    expect(ESTIMATION_METHOD_CODE).toEqual({ resolved: true, code: '414135002' });
  });

  /**
   * The union survives resolution. It is what makes an unresolved code
   * unrepresentable at a call site rather than merely unlikely, and the
   * next unresolved terminology code should copy the shape.
   */
  it('B4 — still a discriminated union, so a future unresolved code has this shape to copy', () => {
    const unresolved: EstimationMethodCode = { resolved: false };

    expect(unresolved).not.toHaveProperty('code');
  });

  it('B4 — a caller must narrow on `resolved` before reading a code (compile-time proof)', () => {
    function readCodeOrNull(value: EstimationMethodCode): string | null {
      // @ts-expect-error — `code` does not exist on the `{ resolved: false }` arm; a caller must narrow first.
      const impossible: string = value.code;
      void impossible;

      return value.resolved ? value.code : null;
    }

    // Both arms, exercised explicitly. The published constant is resolved
    // now, so the unresolved arm needs a literal to keep being covered —
    // and it must stay covered: it is the arm that makes a future
    // unverified code unreadable without narrowing.
    expect(readCodeOrNull({ resolved: false })).toBeNull();
    expect(readCodeOrNull({ resolved: true, code: '12345-6' })).toBe('12345-6');
    expect(readCodeOrNull(ESTIMATION_METHOD_CODE)).toBe('414135002');
  });
});
