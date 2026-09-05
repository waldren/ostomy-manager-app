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

import type { Request } from 'express';
import { describe, expect, it } from 'vitest';

import { getRequestId } from './request-id';

describe('getRequestId', () => {
  it('stringifies a numeric request id assigned by pino-http', () => {
    const request = { id: 42 } as unknown as Request;

    expect(getRequestId(request)).toBe('42');
  });

  it('passes through a string request id unchanged', () => {
    const request = { id: 'a1b2c3' } as unknown as Request;

    expect(getRequestId(request)).toBe('a1b2c3');
  });

  it('returns undefined when no id has been assigned', () => {
    const request = {} as unknown as Request;

    expect(getRequestId(request)).toBeUndefined();
  });
});
