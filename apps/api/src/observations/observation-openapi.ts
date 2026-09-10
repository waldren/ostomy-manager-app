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
 * The OpenAPI schemas these endpoints publish, derived from the same zod
 * objects the server validates with.
 *
 * Derived, not restated. A hand-written `@ApiProperty()` class alongside a
 * separate runtime validator is two descriptions of one contract, and they
 * drift in the direction that is hardest to notice: the published schema
 * (and therefore the generated client, and therefore every client author's
 * belief about the API) says one thing while the server enforces another.
 * `z.toJSONSchema` removes the second description entirely.
 *
 * Each schema carries a `title`, which is what the client generator uses to
 * name the interface it emits — see `apps/api/scripts/generate-api-client.cjs`.
 */
import { z } from 'zod';

import { OBSERVATION_ERROR_CODE } from './observation-rejection';
import { observationResourceSchema } from './observation-wire';

const warningSchema = z
  .strictObject({
    field: z.string(),
    ruleCode: z.string(),
  })
  .meta({
    title: 'ObservationWarning',
    description:
      'A Tier 2 soft warning. Advisory only: it appears on a successful response and never blocks a write (SRS §3.8). Carries no clinical value.',
  });

const rejectionDetailSchema = z
  .strictObject({
    field: z.string(),
    reasonCode: z.string(),
  })
  .meta({
    title: 'ObservationRejectionDetail',
    description:
      'One reason a request was refused. Names a field and a stable machine-readable code, never the offending value (docs/sync-contract.md §6.3).',
  });

export const observationCreateResponseSchema = z
  .strictObject({
    observation: observationResourceSchema,
    warnings: z.array(warningSchema),
  })
  .meta({ title: 'ObservationCreateResponse' });

export const observationListResponseSchema = z
  .strictObject({
    observations: z.array(observationResourceSchema),
  })
  .meta({ title: 'ObservationListResponse' });

export const observationErrorResponseSchema = z
  .strictObject({
    error: z.strictObject({
      code: z.enum(Object.values(OBSERVATION_ERROR_CODE)),
      errors: z.array(rejectionDetailSchema),
    }),
  })
  .meta({ title: 'ObservationErrorResponse' });

/**
 * The shape `@nestjs/swagger`'s `schema` option takes. Declared here rather
 * than imported from `@nestjs/swagger/dist/...`: that path is package
 * internals with no `exports` entry, so importing it typechecks only by
 * accident of a package layout that is free to change in a patch release.
 */
export type OpenApiSchemaObject = Record<string, unknown>;

function toOpenApiSchema(schema: z.ZodType): OpenApiSchemaObject {
  // `openapi-3.0` rather than a JSON Schema draft: it emits `nullable: true`
  // instead of a `["string","null"]` type union, which is what OpenAPI 3.0
  // tooling — including `@nestjs/swagger`'s own document type — understands.
  return z.toJSONSchema(schema, { target: 'openapi-3.0' }) as OpenApiSchemaObject;
}

export const OBSERVATION_REQUEST_SCHEMA = toOpenApiSchema(observationResourceSchema);
export const OBSERVATION_CREATE_RESPONSE_SCHEMA = toOpenApiSchema(observationCreateResponseSchema);
export const OBSERVATION_LIST_RESPONSE_SCHEMA = toOpenApiSchema(observationListResponseSchema);
export const OBSERVATION_ERROR_RESPONSE_SCHEMA = toOpenApiSchema(observationErrorResponseSchema);
