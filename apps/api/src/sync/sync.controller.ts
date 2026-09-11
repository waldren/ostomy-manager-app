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

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { SyncDeltaResponse, SyncPushResponse } from '@ostomy/core/sync';
import type { Request } from 'express';

import { Audited } from '../audit/audited.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { getPatientActor } from '../auth/patient-actor';
import { SyncDeltaPipe, type SyncDeltaQueryParsed } from './sync-delta.pipe';
import { SyncDeltaService } from './sync-delta.service';
import { SyncExceptionFilter } from './sync-exception.filter';
import { SyncPushPipe, type SyncPushRequestParsed } from './sync-push.pipe';
import { SyncPushService } from './sync-push.service';

/**
 * The offline sync surface (`docs/sync-contract.md`).
 *
 * `apps/mobile` is the only client of these two routes — `apps/web` is
 * online-only by explicit decision (SRS §4.3) and never speaks this protocol.
 * Neither route has an admin analogue.
 *
 * **The patient comes from the token, never from the payload** (§2). There is
 * no patient identifier anywhere in a request body or query string and the
 * server must not accept one. That is not defense in depth — it is the
 * absence of the field that could carry the attack.
 */
@ApiTags('sync')
@ApiBearerAuth('patient-oidc')
@Controller('sync')
@UseGuards(JwtAuthGuard)
// Every non-2xx leaving this surface becomes `{ error: { code } }` from §6.1's
// closed set — including the framework defaults that never pass through the
// type that makes the shape safe. See `SyncExceptionFilter`.
@UseFilters(SyncExceptionFilter)
export class SyncController {
  constructor(
    @Inject(SyncPushService) private readonly pushService: SyncPushService,
    @Inject(SyncDeltaService) private readonly deltaService: SyncDeltaService,
  ) {}

  @Post('push')
  // Route-level audit coverage (P1.S5). `allowEmpty` because a batch in which
  // EVERY operation is rejected legitimately stages nothing — the trip-wire's
  // "an @Audited() route staged nothing" rule would otherwise 500 a request
  // that behaved exactly as §3.4 requires. The per-entity guarantee this
  // route actually needs is stronger than the trip-wire can express and is
  // held by `SyncPushService` writing one audit row per applied operation
  // inside that operation's own transaction; `sync.integration.spec.ts`
  // asserts the count equality §4.1 demands.
  @Audited({ allowEmpty: true })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Apply a batch of offline operations',
    description:
      'Applies operations in array order, one result per operation in request order. A batch never fails as a unit for data reasons: one rejected operation does not block the rest. Idempotent on (patient, operationId) — a re-pushed operation returns the first attempt’s result byte-for-byte with replayed: true. See docs/sync-contract.md §3 and §4.',
  })
  async push(
    @Req() request: Request,
    @Body(SyncPushPipe) body: SyncPushRequestParsed,
  ): Promise<SyncPushResponse> {
    const { results } = await this.pushService.push(getPatientActor(request), request, body);
    return { results };
  }

  @Get('delta')
  @ApiOperation({
    summary: 'Pull changes since a cursor',
    description:
      'Returns changes with server sequence greater than `since`, ordered ascending. The client pulls in a loop until hasMore is false, persisting cursor after each page. A tombstone carries no payload. See docs/sync-contract.md §5.',
  })
  async delta(
    @Req() request: Request,
    @Query(SyncDeltaPipe) query: SyncDeltaQueryParsed,
  ): Promise<SyncDeltaResponse> {
    // The OIDC subject; the service resolves it to a patient row.
    return this.deltaService.delta(getPatientActor(request).id, query);
  }
}
