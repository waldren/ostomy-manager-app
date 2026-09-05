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

import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import pino from 'pino';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { ConfigValidationError } from './config/config-validation.error';
import { loadConfig } from './config/load-config';
import { writeOpenApiDocument } from './openapi/write-openapi-document';

const API_PREFIX = 'api/v1';

async function bootstrap(): Promise<void> {
  // Validated before Nest touches anything. A missing or malformed variable
  // must fail loudly here — never degrade into "auth silently allows
  // everything" three layers into module instantiation.
  const config = loadConfig();

  // Buffered until `app.useLogger` below swaps in the real Pino logger, so
  // Nest's own startup log lines go through the same PHI-scrubbing
  // serializer as everything else rather than the default console logger.
  const app = await NestFactory.create(AppModule.register(config), { bufferLogs: true });
  app.useLogger(app.get(Logger));

  app.setGlobalPrefix(API_PREFIX);

  if (config.nodeEnv !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Ostomy API')
      .setDescription('Patient and admin REST API for the ostomy care tracking application.')
      .setVersion('1')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'patient-oidc')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'admin-oidc')
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api-docs', app, document);
    writeOpenApiDocument(document, path.join(process.cwd(), 'openapi.json'));
  }

  await app.listen(config.port);
}

bootstrap().catch((error: unknown) => {
  // Config validation must fail loudly, before a network listener ever
  // opens — a misconfigured issuer must never degrade into "auth silently
  // allows everything". The message names fields and rules only; several of
  // these variables are secrets, and a startup log is not a safe place to
  // echo one (docs/security-hipaa.md "Never log PHI").
  const bootstrapLogger = pino();
  if (error instanceof ConfigValidationError) {
    bootstrapLogger.fatal(error.message);
  } else {
    bootstrapLogger.fatal({ err: error }, 'Fatal error during API startup');
  }
  process.exitCode = 1;
});
