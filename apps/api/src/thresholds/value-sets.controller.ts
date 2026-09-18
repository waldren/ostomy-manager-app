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
 * `GET /api/v1/value-sets` — the active members of every value set a client
 * needs to render an entry screen.
 *
 * ## Why this exists, and why it is the same story as `/thresholds`
 *
 * Value sets are admin-managed configuration (SRS §3.11) and members are
 * **retired, never deleted** (CLAUDE.md), so a client cannot hold a hardcoded
 * list — a retired member has to stop being offered while still resolving in
 * history. `ThresholdsService.getActiveValueSetMembers` read them from P1.S5
 * onward and nothing exposed them, exactly as nothing exposed the thresholds
 * until P2.S2b. A client could satisfy the requirement only by inventing the
 * list, which is the thing the rule forbids.
 *
 * P3.S1 is where that bites: AC 2.3 AC1's fluid categories, AC 2.3 AC2's
 * configurable container sizes and AC 2.4 AC1's meal tags are all value sets,
 * and none of the three screens can be built without them.
 *
 * ## One request, not one per set
 *
 * A patient opening the Add Intake screen needs `fluid_type` AND
 * `container_size`; the Add Meal screen needs `meal_tag`. On a phone that has
 * just come online, three round trips to populate one screen is three chances
 * to be interrupted and end up partly configured. The whole set is small —
 * eighteen members today — so it goes in one response, cached whole.
 *
 * ## No PHI, and therefore no audit row
 *
 * The response is deployment-wide configuration: the same bytes for every
 * patient, carrying no patient identifier and nothing derived from one. SRS
 * §5.2 makes audit events a property of PHI mutations, and this mutates
 * nothing and reads no PHI — so no `@Audited()`, for `/thresholds`' reason.
 * It is authenticated regardless.
 *
 * ## Not the admin surface
 *
 * This is a **read of the active members by the patient app**. P3.S3's
 * `/api/v1/admin/...` surface is what *changes* them — its own guard, its own
 * disjoint identity pool (ADR-0008), never reachable with a patient token.
 * Nothing here exposes `status`, a retired member, or a member's row identity.
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

import { VALUE_SETS_RESPONSE_SCHEMA, type ValueSetsResponse } from './value-sets-openapi';
import { ThresholdsService } from './thresholds.service';

/**
 * The sets this release publishes.
 *
 * A fixed list rather than "every set in the table", deliberately. The table
 * also holds sets whose features have not shipped — a urine-colour scale, for
 * instance — and publishing those would let a client build a picker for an
 * entry type the server would reject on write. A set appears here in the
 * sprint that can use it.
 */
const PUBLISHED_VALUE_SET_KEYS = ['fluid_type', 'container_size', 'meal_tag'] as const;

@ApiTags('value-sets')
@ApiBearerAuth('patient-oidc')
@Controller('value-sets')
@UseGuards(JwtAuthGuard)
export class ValueSetsController {
  // Explicit `@Inject()`, not implicit type-based injection — see
  // `AuditService`'s constructor comment for why the latter resolves to
  // `undefined` under this workspace's Vitest (esbuild) transform.
  constructor(@Inject(ThresholdsService) private readonly thresholds: ThresholdsService) {}

  @Get()
  @ApiOperation({
    summary: 'Read the active members of every published value set',
    description:
      'Admin-managed configuration a client needs to render entry screens: fluid categories (AC 2.3 AC1), quick-select container sizes with their canonical mL (AC 2.3 AC2), and meal tags (AC 2.4 AC1). Members are codes, never display labels — patient-facing text comes from the i18n catalog (ADR-0006). Retired members are omitted; a retired code still resolves in stored history, which is why a client must read this rather than hold a hardcoded list. Carries no patient identifier and no PHI, and is therefore not an audit event (SRS §5.2). A client caches the response and keeps rendering offline from the cached copy.',
  })
  @ApiOkResponse({ schema: VALUE_SETS_RESPONSE_SCHEMA })
  @ApiForbiddenResponse({
    schema: { type: 'object', properties: { code: { type: 'string' } } },
  })
  async get(): Promise<ValueSetsResponse> {
    const sets = await Promise.all(
      PUBLISHED_VALUE_SET_KEYS.map(async (key) => {
        const members = await this.thresholds.getActiveValueSetMembers(key);
        return {
          key,
          // Named field by field, never `...member`. `ActiveValueSetMember`
          // is an internal type free to grow, and a spread would make every
          // future addition to it public API the moment it was added —
          // silently, and unversioned.
          members: members.map((member) => ({
            code: member.code,
            sortOrder: member.sortOrder,
            numericValue: member.numericValue,
            numericUnit: member.numericUnit,
          })),
        };
      }),
    );

    return { valueSets: sets };
  }
}
