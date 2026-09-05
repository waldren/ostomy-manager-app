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

import { writeFileSync } from 'node:fs';
import type { OpenAPIObject } from '@nestjs/swagger';

/**
 * Emits the generated OpenAPI document to disk. The typed API client
 * generator (P2.S1a) consumes this file; it is not committed (see
 * apps/api/.gitignore) because it is build output, regenerated on every
 * boot from the live route/DTO metadata.
 */
export function writeOpenApiDocument(document: OpenAPIObject, outputPath: string): void {
  writeFileSync(outputPath, JSON.stringify(document, null, 2), 'utf-8');
}
