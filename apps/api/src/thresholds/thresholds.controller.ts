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
 * `GET /api/v1/thresholds` — the active validation thresholds, for clients.
 *
 * ## Why this endpoint has to exist
 *
 * CLAUDE.md: "Numeric thresholds are admin-managed configuration, not
 * constants in code", and `packages/core` enforces it structurally — the
 * validation engine takes thresholds as an injected argument and
 * `no-hardcoded-thresholds.spec.ts` fails the build on a literal. Both
 * clients are required to run the same Tier 1 and Tier 2 rules at entry
 * time (SRS §3.8; client-side validation is a UX affordance, re-enforced
 * server-side on write).
 *
 * Those two facts together require a delivery path, and until now there was
 * none: `ThresholdsService` read the values but nothing exposed them, so a
 * client could only satisfy the injection interface by inventing numbers —
 * the exact thing the rule forbids. AC 13.2 AC1 ("a new threshold governs
 * the warning with no application release required") is unimplementable
 * without this.
 *
 * ## Why it is not part of the admin surface
 *
 * This is a **read of the active values by the patient app**, which is a
 * different thing from P3.S3's `/api/v1/admin/...` configuration API that
 * *changes* them. That surface has its own guard and its own disjoint
 * identity pool (ADR-0008) and must never be reachable with a patient
 * token. This one is patient-guarded, read-only, and returns no row
 * identity, no provenance and nothing an admin console would need.
 *
 * ## No PHI, and therefore no audit row
 *
 * The response is deployment-wide configuration — the same bytes for every
 * patient. It carries no patient identifier and nothing derived from one,
 * which is why it takes no `@Audited()`: SRS §5.2 makes audit events a
 * property of PHI mutations, and this mutates nothing and reads no PHI.
 * It is authenticated regardless, because an unauthenticated endpoint is a
 * surface to maintain for no benefit.
 */
import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';

import { THRESHOLDS_RESPONSE_SCHEMA, type ThresholdsResponse } from './thresholds-openapi';
import { ThresholdsService } from './thresholds.service';

@ApiTags('thresholds')
@ApiBearerAuth('patient-oidc')
@Controller('thresholds')
@UseGuards(JwtAuthGuard)
export class ThresholdsController {
  // Explicit `@Inject()`, not implicit type-based injection — see
  // `AuditService`'s constructor comment for why the latter resolves to
  // `undefined` under this workspace's Vitest (esbuild) transform.
  constructor(@Inject(ThresholdsService) private readonly thresholds: ThresholdsService) {}

  @Get()
  @ApiOperation({
    summary: 'Read the active validation thresholds',
    description:
      'Deployment-wide validation configuration, so a client can run the same Tier 1 and Tier 2 rules at entry time that the server re-enforces on write. Carries no patient identifier and no PHI, and is therefore not an audit event (SRS §5.2). A client caches these and keeps validating offline from the cached copy; an admin change governs from the next successful fetch, with no application release (AC 13.2 AC2).',
  })
  @ApiOkResponse({ schema: THRESHOLDS_RESPONSE_SCHEMA })
  @ApiForbiddenResponse({
    schema: { type: 'object', properties: { code: { type: 'string' } } },
  })
  async get(): Promise<ThresholdsResponse> {
    const active = await this.thresholds.getVolumetricThresholds();
    // Named field by field, never `...active`. `VolumetricValidationThresholds`
    // is an internal type free to grow, and a spread would make every future
    // addition to it public API the moment it was added — silently, and
    // unversioned (docs/sync-contract.md §8's asymmetry applies here too).
    return {
      stomaOutputSoftWarningMl: active.softWarningMaxMl,
      maxClockSkewMs: active.maxClockSkewMs,
    };
  }
}
