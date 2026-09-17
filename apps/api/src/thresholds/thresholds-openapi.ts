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
 * The `GET /api/v1/thresholds` response schema.
 *
 * Zod first, OpenAPI derived — the same direction `observation-openapi.ts`
 * uses, and the direction CLAUDE.md requires: `packages/core/src/api-client`
 * is generated from `openapi.json`, so a wrong client type is fixed by
 * editing the zod schema next to the handler and regenerating, never by
 * hand-editing the client.
 */
import { z } from 'zod';

import type { OpenApiSchemaObject } from '../observations/observation-openapi';

export const thresholdsResponseSchema = z
  .object({
    stomaOutputSoftWarningMl: z
      .number()
      .describe(
        'Canonical mL (ADR-0004). Tier 2 soft-warning bound for a single stoma-output entry. A warning that saves on confirmation, never a block (SRS §3.8).',
      ),
    maxClockSkewMs: z
      .number()
      .describe(
        "Milliseconds, matching packages/core's VolumetricValidationThresholds.maxClockSkewMs. How far into the future an effectiveDateTime may fall before Tier 1 blocks it. The stored row is in seconds; the server converts, so the unit contract lives in one place.",
      ),
  })
  .strict();

export type ThresholdsResponse = z.infer<typeof thresholdsResponseSchema>;

export const THRESHOLDS_RESPONSE_SCHEMA: OpenApiSchemaObject = z.toJSONSchema(
  thresholdsResponseSchema,
  { target: 'openapi-3.0' },
) as OpenApiSchemaObject;
