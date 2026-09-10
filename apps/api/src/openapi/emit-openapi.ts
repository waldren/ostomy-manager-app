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

/**
 * Writes `apps/api/openapi.json` without starting a server.
 *
 * `pnpm --filter @ostomy/api openapi:generate`
 *
 * Why this exists rather than reading the file `main.ts` drops at boot: that
 * one needs a bootable process — a database DSN it can reach for the
 * ADR-0011 privilege self-check, a writable working directory, and an open
 * port — none of which a CI job regenerating a typed client should need. The
 * document is a property of the module graph, not of a running process.
 * `NestFactory.create()` builds the graph and instantiates providers; no
 * request is served and `PrismaService` never connects, because its
 * connection is lazy by design (see that class's comment).
 *
 * The configuration below is synthetic and deliberately unreachable. It is
 * not a place to put real values: nothing here is contacted, and a real
 * issuer or DSN in a file that runs in CI is a credential in a repository.
 */
import 'reflect-metadata';

import path from 'node:path';

import { NestFactory } from '@nestjs/core';

import { AppModule } from '../app.module';
import type { AppConfig } from '../config/env.schema';
import { buildOpenApiDocument } from './build-openapi-document';
import { writeOpenApiDocument } from './write-openapi-document';

const GENERATOR_CONFIG: AppConfig = {
  // `production`, so the emitted document describes the surface a real
  // deployment serves. `AppModule` gates `AuditStubModule` — synthetic test
  // scaffolding with its own routes — on this value, and a generated client
  // carrying methods for endpoints that exist only in development is a
  // client that lies about the API.
  nodeEnv: 'production',
  port: 0,
  logLevel: 'silent',
  oidcClockToleranceSeconds: 30,
  databaseUrl: 'postgresql://openapi-generator:unused@127.0.0.1:1/unused',
  oidc: {
    issuer: 'https://openapi-generator.invalid/patient',
    jwksUri: 'https://openapi-generator.invalid/patient/jwks',
    audience: 'openapi-generator',
    claimMapping: { subjectClaim: 'sub' },
  },
  adminOidc: {
    issuer: 'https://openapi-generator.invalid/admin',
    jwksUri: 'https://openapi-generator.invalid/admin/jwks',
    audience: 'openapi-generator-admin',
    claimMapping: { subjectClaim: 'sub' },
  },
  objectStorage: {
    endpoint: 'http://openapi-generator.invalid:9000',
    region: 'us-east-1',
    accessKeyId: 'unused',
    secretAccessKey: 'unused',
    forcePathStyle: true,
  },
};

export async function emitOpenApiDocument(outputPath: string): Promise<void> {
  const app = await NestFactory.create(AppModule.register(GENERATOR_CONFIG), { logger: false });
  try {
    app.setGlobalPrefix('api/v1');
    await app.init();
    writeOpenApiDocument(buildOpenApiDocument(app), outputPath);
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  const outputPath = path.join(__dirname, '..', '..', 'openapi.json');
  emitOpenApiDocument(outputPath)
    .then(() => {
      // A generator's only output is the path it wrote; a structured logger
      // would be noise in a CI log.
      // eslint-disable-next-line no-console
      console.log(`OpenAPI document written to ${outputPath}`);
    })
    .catch((error: unknown) => {
      // See above; this branch runs with no Nest application and therefore
      // no configured logger.
      // eslint-disable-next-line no-console
      console.error(error);
      process.exitCode = 1;
    });
}
