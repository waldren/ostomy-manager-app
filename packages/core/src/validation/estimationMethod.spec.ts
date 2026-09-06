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

describe('AC 2.5 AC2 — Estimation technique SNOMED code (D4, unresolved)', () => {
  it('is not resolved to any code yet — do not invent one', () => {
    expect(ESTIMATION_METHOD_CODE).toEqual({ resolved: false });
  });

  it('B4 — the unresolved state has no `code` property to accidentally read or assign', () => {
    expect(ESTIMATION_METHOD_CODE).not.toHaveProperty('code');
  });

  it('B4 — a caller must narrow on `resolved` before reading a code (compile-time proof)', () => {
    function readCodeOrNull(value: EstimationMethodCode): string | null {
      // @ts-expect-error — `code` does not exist on the `{ resolved: false }` arm; a caller must narrow first.
      const impossible: string = value.code;
      void impossible;

      return value.resolved ? value.code : null;
    }

    expect(readCodeOrNull(ESTIMATION_METHOD_CODE)).toBeNull();
    expect(readCodeOrNull({ resolved: true, code: '12345-6' })).toBe('12345-6');
  });
});
