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

import { errSerializer, reqSerializer, resSerializer } from './serializers';

describe('reqSerializer', () => {
  it('strips the query string from the logged path — dates and other query params are HIPAA identifiers', () => {
    const result = reqSerializer({
      id: 7,
      method: 'GET',
      url: '/api/v1/observations?from=2026-09-01&to=2026-09-05',
      path: '/api/v1/observations',
    });

    expect(result.path).toBe('/api/v1/observations');
    expect(JSON.stringify(result)).not.toContain('2026-09-01');
  });

  it('falls back to stripping the query string from url when path is unavailable', () => {
    const result = reqSerializer({
      id: 1,
      method: 'GET',
      url: '/api/v1/health?noisy=true',
    });

    expect(result.path).toBe('/api/v1/health');
  });

  it('includes the matched route pattern, not a resolved id, when present', () => {
    const result = reqSerializer({
      id: 1,
      method: 'GET',
      url: '/api/v1/observations/abc-123',
      path: '/api/v1/observations/abc-123',
      route: { path: '/api/v1/observations/:id' },
    });

    expect(result.route).toBe('/api/v1/observations/:id');
  });

  it('emits only the documented fields', () => {
    const result = reqSerializer({ id: 1, method: 'GET', url: '/api/v1/health' });

    expect(Object.keys(result).sort()).toEqual(['id', 'method', 'path', 'route']);
  });
});

describe('resSerializer', () => {
  it('emits only statusCode', () => {
    const result = resSerializer({ statusCode: 200 });

    expect(result).toEqual({ statusCode: 200 });
  });
});

describe('errSerializer', () => {
  it('emits only the fixed field set, dropping everything else', () => {
    const error = Object.assign(new Error('boom'), {
      code: 'E_TEST',
      statusCode: 400,
      // These are the shapes that must never reach the log: a rejected
      // clinical value on a NestJS validation error, and Prisma's
      // query/params/meta, which can carry PHI-shaped column values.
      response: { message: ['bloodGlucose must not exceed 2000'] },
      meta: { column: 'output_volume_ml', value: 9999 },
      query: 'INSERT INTO observations ...',
      params: ['patient-123', 9999],
    });

    const result = errSerializer(error);

    expect(result).toEqual({
      type: 'Error',
      message: 'boom',
      code: 'E_TEST',
      statusCode: 400,
      stack: expect.any(String),
    });
    expect(result).not.toHaveProperty('response');
    expect(result).not.toHaveProperty('meta');
    expect(result).not.toHaveProperty('query');
    expect(result).not.toHaveProperty('params');
  });

  it('does not throw on a non-object input', () => {
    expect(() => errSerializer('a plain string error')).not.toThrow();
    expect(() => errSerializer(undefined)).not.toThrow();
    expect(() => errSerializer(null)).not.toThrow();
  });

  it('omits fields the error does not have, rather than inventing them', () => {
    const result = errSerializer({});

    expect(result.type).toBeUndefined();
    expect(result.message).toBeUndefined();
    expect(result.code).toBeUndefined();
    expect(result.statusCode).toBeUndefined();
    expect(result.stack).toBeUndefined();
  });
});
