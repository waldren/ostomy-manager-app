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
 * The OpenAPI document's own definition, in one place.
 *
 * Two callers: `main.ts` (which serves it at `/api-docs` and writes it to
 * disk in development) and `emit-openapi.ts` (the generator entry point,
 * which needs no listening server and no database). They must produce the
 * same document — the second is what `packages/core/src/api-client` is
 * generated from, and a client generated from a document the running server
 * does not serve is worse than no client at all.
 */
import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Ostomy API')
    .setDescription('Patient and admin REST API for the ostomy care tracking application.')
    .setVersion('1')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'patient-oidc')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'admin-oidc')
    .build();
  return SwaggerModule.createDocument(app, config);
}
