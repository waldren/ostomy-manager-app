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

    // CORS, from an explicit allowlist, and only when one is configured.
    //
    // `apps/web` is served from a different origin than this API in every
    // environment — port 8088 vs 3000 in development, S3+CloudFront vs the
    // load balancer in production — so without this the browser discards
    // every response and the SPA shows a load failure while this API's
    // access log shows 200. That is precisely what blocked Gate B clause 6:
    // apps/web had NEVER loaded data from this API in a browser, because
    // its own suite mocks `fetch` and so asserted against a stand-in for
    // the broken thing.
    //
    // Three deliberate choices:
    //
    // 1. No wildcard, and no way to configure one (`env.schema.ts`). This
    //    API serves PHI, and `Access-Control-Allow-Origin: *` would let any
    //    page read a patient's clinical values given a token obtained by
    //    any means.
    // 2. `credentials: false`. Tokens travel in the `Authorization` header,
    //    never in cookies, so nothing here needs credentialed requests.
    //    Enabling it would attach ambient cookie authority to cross-origin
    //    requests for no benefit this design uses.
    // 3. Not enabled at all when the allowlist is empty, rather than
    //    enabled-with-nothing-allowed. An API with no CORS headers is the
    //    behaviour every non-browser client already expects, and it keeps
    //    the default for a new deployment "no cross-origin access".
    if (config.corsAllowedOrigins.length > 0) {
      app.enableCors({
        origin: config.corsAllowedOrigins,
        methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Authorization', 'Content-Type'],
        credentials: false,
        // Cache the preflight so a history view does not pay an extra
        // round trip per request. Ten minutes is Chrome's cap.
        maxAge: 600,
      });
    }
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
