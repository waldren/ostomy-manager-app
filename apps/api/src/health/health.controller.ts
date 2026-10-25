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

import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { APP_CONFIG } from '../config/config.tokens';
import type { AppConfig } from '../config/env.schema';
import { ReadinessService, type Readiness } from './readiness.service';

interface ReadinessResponse {
  status: 'ready' | 'unready';
  checks: Readiness['checks'];
}

interface HealthResponse {
  status: 'ok';
  timestamp: string;
  /**
   * The commit this build came from — **development only**, `null` everywhere
   * else and whenever nothing stamped it.
   */
  buildCommit: string | null;
}

/**
 * Unauthenticated liveness (`/health`) and readiness (`/health/ready`).
 *
 * Liveness deliberately reports nothing beyond "the process is accepting
 * requests", and container health checks use it: a readiness failure is a
 * database or issuer outage, and restarting the API does not fix either.
 * Readiness is what an outage monitor watches (ADR-0022 item 15); see
 * `ReadinessService`.
 *
 * ## `buildCommit`, and why it is gated on the environment
 *
 * It exists because of #76: the development stack ran three merges behind
 * `main` with nothing surfacing it. The only way to tell was to inspect the
 * container by hand, and a deploy that never ran looks exactly like one that
 * did. Reporting the commit makes "what is actually running" answerable by
 * anyone who can reach the API.
 *
 * **It is withheld unless `NODE_ENV` is `development`, and that is not
 * defensive padding.** This endpoint is unauthenticated by design, and this
 * project is AGPL-3.0 — the source is public. An exact commit therefore tells
 * an unauthenticated caller precisely which known issues a deployment has not
 * yet taken, which is a real if modest gift to an attacker and one with no
 * corresponding benefit outside a developer's own stack. The staleness problem
 * being solved here is a development-environment problem; the answer should not
 * outlive it.
 *
 * `null` rather than an omitted key, for the reason `docs/sync-contract.md`
 * gives about `method`: an absent field cannot be told apart from a server too
 * old to implement it. A caller needs to distinguish "this build will not tell
 * you" from "this build does not know about the question".
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  // Explicit `@Inject()`, matching every other service in this app — see
  // `AuditService`'s constructor comment for why implicit type-based injection
  // resolves to `undefined` under this workspace's Vitest transform.
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ReadinessService) private readonly readiness: ReadinessService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Liveness check. Always unauthenticated.' })
  check(): HealthResponse {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      buildCommit: this.config.nodeEnv === 'development' ? (this.config.buildCommit ?? null) : null,
    };
  }

  /**
   * 503 when any dependency is down, with which one, as ok/failed only. Written
   * through `res` rather than thrown so the error sanitizer does not reduce the
   * answer to a bare code: the monitor and the operator need to know which.
   */
  @Get('ready')
  @ApiOperation({
    summary: 'Readiness: the database answers and both issuers publish keys. Unauthenticated.',
  })
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadinessResponse> {
    const { ready, checks } = await this.readiness.check();
    res.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ready ? 'ready' : 'unready', checks };
  }
}
