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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../config/env.schema';
import type { PrismaService } from '../prisma/prisma.service';
import { READINESS_CACHE_MS, ReadinessService } from './readiness.service';

const PATIENT_JWKS = 'http://keycloak:8080/realms/patient/protocol/openid-connect/certs';
const ADMIN_JWKS = 'http://keycloak:8080/realms/admin/protocol/openid-connect/certs';

const config = {
  oidc: { jwksUri: PATIENT_JWKS },
  adminOidc: { jwksUri: ADMIN_JWKS },
} as AppConfig;

const jwks = (keys: unknown[]) => new Response(JSON.stringify({ keys }), { status: 200 });
const aKey = { kty: 'RSA', kid: 'k1', n: 'AQAB', e: 'AQAB' };

function makeService(options: {
  database?: () => Promise<unknown>;
  fetch?: (url: string) => Promise<Response>;
}) {
  const queryRaw = vi.fn(options.database ?? (() => Promise.resolve([{ '?column?': 1 }])));
  const fetchFn = vi.fn(options.fetch ?? (() => Promise.resolve(jwks([aKey]))));
  const prisma = { $queryRaw: queryRaw } as unknown as PrismaService;
  const service = new ReadinessService(config, prisma, fetchFn as unknown as typeof fetch);
  return { service, queryRaw, fetchFn };
}

describe('ReadinessService', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is ready when the database answers and both issuers publish keys', async () => {
    const { service, fetchFn } = makeService({});

    await expect(service.check()).resolves.toEqual({
      ready: true,
      checks: { database: 'ok', patientIssuer: 'ok', adminIssuer: 'ok' },
    });
    expect(fetchFn.mock.calls.map(([url]) => url).sort()).toEqual([ADMIN_JWKS, PATIENT_JWKS]);
  });

  it('is not ready when the database fails, and says which check failed', async () => {
    const { service } = makeService({ database: () => Promise.reject(new Error('down')) });

    await expect(service.check()).resolves.toEqual({
      ready: false,
      checks: { database: 'failed', patientIssuer: 'ok', adminIssuer: 'ok' },
    });
  });

  it.each([
    ['answers an error status', () => Promise.resolve(new Response('', { status: 503 }))],
    ['publishes no keys', () => Promise.resolve(jwks([]))],
    ['answers something that is not JSON', () => Promise.resolve(new Response('<html>'))],
    ['cannot be reached', () => Promise.reject(new TypeError('fetch failed'))],
  ])('is not ready when an issuer %s', async (_name, answer) => {
    const { service } = makeService({
      fetch: (url) => (url === ADMIN_JWKS ? answer() : Promise.resolve(jwks([aKey]))),
    });

    await expect(service.check()).resolves.toEqual({
      ready: false,
      checks: { database: 'ok', patientIssuer: 'ok', adminIssuer: 'failed' },
    });
  });

  it('reuses one answer for a few seconds, so an unauthenticated caller cannot turn it into load', async () => {
    const { service, queryRaw, fetchFn } = makeService({});

    await Promise.all([service.check(), service.check(), service.check()]);
    vi.setSystemTime(Date.now() + READINESS_CACHE_MS - 1);
    await service.check();
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);

    vi.setSystemTime(Date.now() + 1);
    await service.check();
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it('times out a database that never answers, rather than hanging the probe', async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { service } = makeService({ database: () => new Promise(() => {}) });

    const result = service.check();
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(result).resolves.toMatchObject({ ready: false, checks: { database: 'failed' } });
  });
});
