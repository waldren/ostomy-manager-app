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
 * The `GET /api/v1/value-sets` response schema.
 *
 * Zod first, OpenAPI derived — the direction CLAUDE.md requires, since
 * `packages/core/src/api-client` is generated from `openapi.json`. A wrong
 * client type is fixed by editing this schema and regenerating, never by
 * hand-editing the client.
 */
import { z } from 'zod';

import type { OpenApiSchemaObject } from '../observations/observation-openapi';

const valueSetMemberSchema = z
  .object({
    code: z
      .string()
      .describe(
        'The stable identifier a clinical record references (CLAUDE.md). NEVER a display label — patient-facing text comes from the i18n catalog (ADR-0006), so there is one localization pipeline rather than two.',
      ),
    sortOrder: z
      .number()
      .int()
      .describe(
        'Display order within the set. Admin-managed, so a client renders in this order rather than sorting by code.',
      ),
    numericValue: z
      .number()
      .nullable()
      .describe(
        'The quantity the member carries, when it has one: a container size is 250 with numericUnit "mL" (AC 2.3 AC2). Null for a category — a fluid type or a meal tag is not a measurement.',
      ),
    numericUnit: z
      .string()
      .nullable()
      .describe(
        'The unit numericValue is in, stored beside it rather than assumed from the set. An admin editing 250 mL to 250 with the unit left wrong is an administratively plausible mistake, and a value with no unit beside it is one a reader has to guess about.',
      ),
  })
  .strict();

const valueSetSchema = z
  .object({
    key: z
      .string()
      .describe('The set this release publishes: fluid_type, container_size or meal_tag.'),
    members: z
      .array(valueSetMemberSchema)
      .describe(
        'ACTIVE members only, in sortOrder. A retired member is omitted here and still resolves in stored history — which is exactly why a client reads this rather than holding a hardcoded list.',
      ),
  })
  .strict();

export const valueSetsResponseSchema = z.object({ valueSets: z.array(valueSetSchema) }).strict();

export type ValueSetsResponse = z.infer<typeof valueSetsResponseSchema>;

export const VALUE_SETS_RESPONSE_SCHEMA: OpenApiSchemaObject = z.toJSONSchema(
  valueSetsResponseSchema,
  { target: 'openapi-3.0' },
) as OpenApiSchemaObject;
