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
import { CREDENTIAL_REDACTION_PATHS, PHI_SHAPED_REDACTION_PATHS } from './redaction';
import { errSerializer, reqSerializer, resSerializer } from './serializers';

/**
 * The structured (Pino) logger, wired so that "never log PHI"
 * (docs/security-hipaa.md) is true by construction rather than by someone
 * remembering to filter a field later:
 *
 *  - `serializers.req`/`serializers.res`/`serializers.err` (`./serializers.ts`)
 *    each name an exact, fixed field set. There is no `body` field to redact
 *    because one is never assembled, request headers (which carry the
 *    Authorization bearer token and any cookies) are never included, and the
 *    error serializer allow-lists rather than copying every own property of
 *    an exception.
 *  - `redact` is a second, defence-in-depth layer — a credential list and a
 *    separate PHI-shaped-field list, see `./redaction.ts` for why they are
 *    two lists and what "defence-in-depth" means given pino's single-level
 *    wildcard limitation.
 *  - `autoLogging` is set explicitly (rather than left to the library
 *    default) so every request/response pair is covered structurally — this
 *    is the pattern the audit interceptor (P1.S5) and every PHI endpoint
 *    after it builds on.
 */
@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        pinoHttp: {
          level: config.logLevel,
          autoLogging: true,
          redact: {
            paths: [...CREDENTIAL_REDACTION_PATHS, ...PHI_SHAPED_REDACTION_PATHS],
            censor: '[REDACTED]',
          },
          serializers: {
            req: reqSerializer,
            res: resSerializer,
            err: errSerializer,
          },
        },
      }),
    }),
  ],
  exports: [PinoLoggerModule],
})
export class LoggingModule {}
