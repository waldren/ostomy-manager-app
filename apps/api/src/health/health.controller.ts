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

import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { APP_CONFIG } from '../config/config.tokens';
import type { AppConfig } from '../config/env.schema';

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
 * Unauthenticated liveness check.
 *
 * Deliberately reports nothing beyond "the process is accepting requests".
 * There is no database, no object storage, and no OIDC provider dependency
 * in this sprint (P1.S1) — claiming readiness for any of those would be
 * dishonest. Add a separate `/health/ready` endpoint once P1.S2/P1.S3 give
 * this process dependencies actually worth checking; do not expand this one
 * to guess at them.
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
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Get()
  @ApiOperation({ summary: 'Liveness check. Always unauthenticated.' })
  check(): HealthResponse {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      buildCommit: this.config.nodeEnv === 'development' ? (this.config.buildCommit ?? null) : null,
    };
  }
}
