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

import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';

import { APP_CONFIG } from '../config/config.tokens';
import type { AppConfig } from '../config/env.schema';
import { PHI_REDACTION_PATHS } from './redaction';

/**
 * The structured (Pino) logger, wired so that "never log PHI"
 * (docs/security-hipaa.md) is true by construction rather than by someone
 * remembering to filter a field later:
 *
 *  - `serializers.req`/`serializers.res` name the exact fields captured —
 *    method, url, status, request id. There is no `body` field to redact
 *    because one is never assembled. Request headers (which carry the
 *    Authorization bearer token and any cookies) are likewise never included.
 *  - `redact` is a second, defence-in-depth layer for the paths in
 *    `./redaction.ts`, in case a future handler logs an object by hand.
 *  - `autoLogging` covers every request/response pair structurally, so a
 *    later handler inherits safe logging without adding anything itself —
 *    this is the pattern the audit interceptor (P1.S5) and every PHI
 *    endpoint after it builds on.
 */
@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        pinoHttp: {
          level: config.logLevel,
          redact: {
            paths: [...PHI_REDACTION_PATHS],
            censor: '[REDACTED]',
          },
          serializers: {
            req: (req: { id?: unknown; method: string; url: string }) => ({
              id: req.id,
              method: req.method,
              url: req.url,
            }),
            res: (res: { statusCode: number }) => ({
              statusCode: res.statusCode,
            }),
          },
        },
      }),
    }),
  ],
  exports: [PinoLoggerModule],
})
export class LoggingModule {}
