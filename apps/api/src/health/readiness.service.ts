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

import { Inject, Injectable } from '@nestjs/common';

import { APP_CONFIG } from '../config/config.tokens';
import type { AppConfig } from '../config/env.schema';
import { PrismaService } from '../prisma/prisma.service';

export type CheckResult = 'ok' | 'failed';

export interface Readiness {
  ready: boolean;
  checks: {
    database: CheckResult;
    patientIssuer: CheckResult;
    adminIssuer: CheckResult;
  };
}

/** How long one dependency may take before it counts as down. */
export const READINESS_CHECK_TIMEOUT_MS = 2_000;

/**
 * How long one answer is reused. The endpoint is unauthenticated and each
 * answer costs a query and two outbound requests, so without this anyone could
 * turn it into load on the database and the issuer. An external monitor
 * polling once a minute never notices five seconds.
 */
export const READINESS_CACHE_MS = 5_000;

export const READINESS_FETCH = Symbol('READINESS_FETCH');

/**
 * Whether this process can serve a patient: the database answers, and both
 * issuers publish signing keys (ADR-0022 item 15). Liveness (`/health`)
 * answers 200 while PostgreSQL or Keycloak is down, which is what an outage
 * monitor must not be pointed at.
 *
 * Only the keys are fetched, never a token, and nothing about either answer is
 * logged or returned beyond ok/failed.
 */
@Injectable()
export class ReadinessService {
  private cached: { at: number; result: Promise<Readiness> } | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(READINESS_FETCH) private readonly fetchFn: typeof fetch,
  ) {}

  check(): Promise<Readiness> {
    const at = Date.now();
    if (this.cached === undefined || at - this.cached.at >= READINESS_CACHE_MS) {
      // The promise is cached, not the answer, so concurrent callers share
      // one round of checks rather than each starting their own.
      this.cached = { at, result: this.runChecks() };
    }
    return this.cached.result;
  }

  private async runChecks(): Promise<Readiness> {
    const [database, patientIssuer, adminIssuer] = await Promise.all([
      this.checkDatabase(),
      this.checkJwks(this.config.oidc.jwksUri),
      this.checkJwks(this.config.adminOidc.jwksUri),
    ]);
    return {
      ready: database === 'ok' && patientIssuer === 'ok' && adminIssuer === 'ok',
      checks: { database, patientIssuer, adminIssuer },
    };
  }

  private async checkDatabase(): Promise<CheckResult> {
    try {
      await withTimeout(this.prisma.$queryRaw`SELECT 1`);
      return 'ok';
    } catch {
      return 'failed';
    }
  }

  private async checkJwks(uri: string): Promise<CheckResult> {
    try {
      const response = await this.fetchFn(uri, {
        signal: AbortSignal.timeout(READINESS_CHECK_TIMEOUT_MS),
      });
      if (!response.ok) return 'failed';
      const body = (await response.json()) as { keys?: unknown };
      return Array.isArray(body.keys) && body.keys.length > 0 ? 'ok' : 'failed';
    } catch {
      return 'failed';
    }
  }
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), READINESS_CHECK_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
