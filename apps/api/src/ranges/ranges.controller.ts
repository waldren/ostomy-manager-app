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

import { Controller, Get, Inject, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { getPatientActor } from '../auth/patient-actor';
import { OBSERVATION_ERROR_RESPONSE_SCHEMA } from '../observations/observation-openapi';

import { rangesResponseSchema, type RangesResponse } from './ranges-wire';
import { RangesService } from './ranges.service';

const RANGES_RESPONSE_SCHEMA = z.toJSONSchema(rangesResponseSchema, {
  target: 'openapi-3.0',
}) as Record<string, unknown>;

/**
 * A patient's target ranges, suggested or in force (P4.S2 slice 3, SRS §3.9).
 *
 * `@ApiBearerAuth('patient-oidc')` is not documentation — it is what puts
 * `security` on the operation, and the client generator reads that to decide
 * whether to send a credential. Omitting it produced a client that 401'd on
 * every call while the guard and the tests looked correct (P4.S1 slice 2);
 * `route-guard-coverage.spec.ts` now fails on a guarded route that lacks it.
 */
@ApiTags('ranges')
@ApiBearerAuth('patient-oidc')
@Controller('ranges')
@UseGuards(JwtAuthGuard)
export class RangesController {
  // Explicit `@Inject()`, not implicit type-based injection — see `AuditService`'s
  // constructor comment for why the latter resolves to `undefined` under this
  // workspace's Vitest (esbuild) transform.
  constructor(@Inject(RangesService) private readonly ranges: RangesService) {}

  /**
   * No `@Audited()`, and that is the rule rather than an omission: a read is not
   * a PHI mutation and not an audit event (SRS §5.2). `route-guard-coverage.spec.ts`
   * requires the decorator on mutating routes only.
   */
  @Get()
  @ApiOperation({
    summary: "Read the patient's target ranges and suggestions",
    description:
      "Every range type this patient has an answer for: the value in force, where it came from in §3.9's precedence order (physician-set → patient-set → patient-confirmed suggestion → clinical default), and the clinical default window that produced it. A range whose provenance is CLINICAL_DEFAULT is a SUGGESTION, not a threshold — isActiveThreshold says so, because AC 14.1 AC2 requires that no value become an anomaly threshold without a human confirming it. The heart-rate red-flag bound never appears here: it is a clinical safety bound and not patient-adjustable. Read-only by design; confirming or editing a range is a synced write and lands with the rest of §3.10 at P4.S3. A read, so no audit row (SRS §5.2), and it carries no patient identifier — the caller is the patient.",
  })
  @ApiOkResponse({ schema: RANGES_RESPONSE_SCHEMA })
  @ApiForbiddenResponse({ schema: OBSERVATION_ERROR_RESPONSE_SCHEMA })
  async list(@Req() request: Request): Promise<RangesResponse> {
    const actor = getPatientActor(request);
    const ranges = await this.ranges.resolveForPatient(actor.id, new Date());

    /**
     * Mapped field by field rather than spread, for the reason
     * `ThresholdsController` records: `ResolvedRange` is an internal type free
     * to grow, and a spread would make every future addition to it public API
     * the moment it was added — silently, and unversioned (§8's asymmetry).
     */
    return {
      ranges: ranges.map((range) => ({
        rangeType: range.rangeType,
        unit: range.unit,
        lowValue: range.lowValue,
        highValue: range.highValue,
        provenance: range.provenance,
        isActiveThreshold: range.isActiveThreshold,
        divergesFromPhysician: range.divergesFromPhysician,
        basis:
          range.basis === null
            ? null
            : {
                // Lower-cased for the wire, as every other patient-facing enum
                // here is — the stored form is the Prisma enum.
                ostomyType: range.basis.ostomyType.toLowerCase() as 'colostomy' | 'ileostomy',
                daysPostOp: range.basis.daysPostOp,
                minDaysPostOp: range.basis.minDaysPostOp,
                maxDaysPostOp: range.basis.maxDaysPostOp,
              },
      })),
    };
  }
}
