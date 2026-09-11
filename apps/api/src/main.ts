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

// NestJS's DI container relies on this being loaded before anything else.
import 'reflect-metadata';

import path from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import pino from 'pino';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { ConfigValidationError } from './config/config-validation.error';
import { loadConfig } from './config/load-config';
import { CREDENTIAL_REDACTION_PATHS, PHI_SHAPED_REDACTION_PATHS } from './logging/redaction';
import { errSerializer } from './logging/serializers';
import { applyJsonBodyLimit } from './http/body-limit';
import { buildOpenApiDocument } from './openapi/build-openapi-document';
import { writeOpenApiDocument } from './openapi/write-openapi-document';
import { PrismaService } from './prisma/prisma.service';

const API_PREFIX = 'api/v1';

async function bootstrap(): Promise<void> {
  // Validated before Nest touches anything. A missing or malformed variable
  // must fail loudly here — never degrade into "auth silently allows
  // everything" three layers into module instantiation.
  const config = loadConfig();

  let app: INestApplication | undefined;
  try {
    // Buffered until `app.useLogger` below swaps in the real Pino logger, so
    // Nest's own startup log lines go through the same serializers and
    // redaction as everything else, rather than the default console logger.
    app = await NestFactory.create(AppModule.register(config), { bufferLogs: true });
    app.useLogger(app.get(Logger));

    // P1.S5 (B4, ADR-0011): the boot-time privilege self-check
    // `PrismaService` has carried since P1.S3 without anything calling it.
    // `PrismaModule` only entered `AppModule`'s graph in this same sprint
    // (see that module's comment) — this is the first point in the process
    // lifecycle with both a real DI container to pull `PrismaService` from
    // and a genuine reason for every boot to touch the database. A positive
    // result here means the connected role can defeat SRS §5.2's
    // append-only audit guarantee, which must fail startup outright, before
    // `app.listen()` ever opens a port — never be logged and continued past.
    await app.get(PrismaService).assertRuntimeRoleIsNotOverPrivileged();

    // Coupled to SYNC_PUSH_MAX_OPERATIONS — see `applyJsonBodyLimit`.
    applyJsonBodyLimit(app);
    app.setGlobalPrefix(API_PREFIX);

    if (config.nodeEnv !== 'production') {
      // Built by the same function `openapi:generate` uses, so the document
      // served here and the one the typed client is generated from cannot
      // diverge (openapi/build-openapi-document.ts).
      const document = buildOpenApiDocument(app);
      SwaggerModule.setup('api-docs', app, document);

      // Best-effort only: a read-only container filesystem is normal
      // hardening, and the dev stack itself runs with NODE_ENV=development,
      // so an unguarded write here would mean the API never starts in the
      // one environment where this branch runs. Nothing depends on this
      // file any more — P2.S1a moved emission to `pnpm --filter @ostomy/api
      // openapi:generate` (openapi/emit-openapi.ts), which needs neither a
      // listening port nor a reachable database — so a failure here is a
      // developer convenience lost, not a broken build.
      try {
        writeOpenApiDocument(document, path.join(process.cwd(), 'openapi.json'));
      } catch (error) {
        app
          .get(Logger)
          .warn(
            `Failed to write OpenAPI document to disk; continuing without it: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
      }
    }

    await app.listen(config.port);
  } catch (error) {
    // A partially-created app (e.g. a DB pool opened by a later sprint's
    // module) must not be left dangling on a failed boot.
    await app?.close();
    throw error;
  }
}

bootstrap().catch((error: unknown) => {
  // Config validation must fail loudly, before a network listener ever
  // opens — a misconfigured issuer must never degrade into "auth silently
  // allows everything". No Nest application exists yet at this point (this
  // branch fires for a `loadConfig()` failure or any error `bootstrap()`
  // rethrows after closing a partial app), so this cannot reuse
  // `LoggingModule`'s configured logger — it builds its own `pino()`
  // instance instead, wired with the same named redaction paths and `err`
  // serializer as every other log line in this app, which is real
  // protection for a credential or PHI value that arrives as a *structured
  // field* (e.g. `err.meta`, `err.params`).
  //
  // It is NOT protection for a credential embedded inside an error's own
  // `message` *string* — `redact.paths` matches object paths, not
  // substrings, and `errSerializer` allow-lists `message` through verbatim
  // by design (see logging/serializers.ts). A P1.S3 database connection
  // error whose message happens to interpolate a connection string with a
  // password would still be logged in full. If that ever needs closing,
  // it has to be a message-scrubbing step in errSerializer (or upstream, at
  // whatever throws), not an addition to the redaction path lists here.
  const bootstrapLogger = pino({
    redact: {
      paths: [...CREDENTIAL_REDACTION_PATHS, ...PHI_SHAPED_REDACTION_PATHS],
      censor: '[REDACTED]',
    },
    serializers: { err: errSerializer },
  });
  if (error instanceof ConfigValidationError) {
    bootstrapLogger.fatal(error.message);
  } else {
    bootstrapLogger.fatal({ err: error }, 'Fatal error during API startup');
  }
  process.exitCode = 1;
});
