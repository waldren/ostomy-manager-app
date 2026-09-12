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

import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';

import { getPatientActor } from '../auth/patient-actor';

/**
 * Rate limiting for `/api/v1/sync/**` (`docs/sync-contract.md` §2: *"Both
 * endpoints are rate-limited"*).
 *
 * ## Keyed on the patient, not the IP
 *
 * This is the part that matters. Mobile clients sit behind carrier NAT, so an
 * IP-keyed limit throttles unrelated patients together — one heavy user in a
 * cell would block everyone else on that gateway, and the limit would have to
 * be set so loosely to avoid that it would stop bounding anything.
 *
 * The guard runs after `JwtAuthGuard`, so the actor is always present; an
 * unauthenticated request is refused before it gets here.
 *
 * ## What this bounds, and what it does not
 *
 * §2 states rate limiting alongside the `since=0` security-log requirement
 * for one reason: a stolen token. A full-history pull is what that token is
 * worth, and without a bound the whole history comes down in seconds. This
 * makes that take long enough to be noticed in the security log rather than
 * completed before anyone looks.
 *
 * It is **not** a defence against a determined attacker with a valid token —
 * nothing at this layer is — and it is deliberately generous enough that a
 * genuine initial sync (a reinstall paging through years of history) is not
 * impeded.
 *
 * ## Storage is per-process, and that is a real limitation
 *
 * `ThrottlerModule`'s default storage is in-memory, so on Fargate the limit is
 * per task rather than global: N tasks means N times the configured rate. That
 * is acceptable for v1 as a blunt abuse bound and is recorded here so nobody
 * later reads the configured number as a system-wide guarantee. Making it
 * global needs a shared store (Redis/ElastiCache), which is an infrastructure
 * decision for P9 rather than a code change here.
 */
@Injectable()
export class SyncThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    // `getPatientActor` throws if no actor is attached, which would mean this
    // guard ran outside `JwtAuthGuard` — a wiring error, and one that should
    // fail loudly rather than silently degrade to a shared bucket every
    // patient contends for.
    return getPatientActor(req as unknown as Request).id;
  }
}

/**
 * The sync rate limits.
 *
 * Sized against the protocol rather than guessed: §3.3 puts at most 500
 * operations in a push and §5.1's delta pages default to 200 changes, so a
 * reinstall pulling a large history is tens of requests, not hundreds. These
 * leave several times that headroom while still bounding a token to a few
 * thousand rows a minute rather than an entire history in seconds.
 *
 * Not `validation_thresholds` rows: these bound the transport, not a clinical
 * judgement — the same reasoning that keeps `SYNC_PUSH_MAX_OPERATIONS` in
 * configuration (§3.3).
 */
export const SYNC_THROTTLE = {
  /** Requests per window, per patient. */
  limit: 60,
  /** Window length in milliseconds. */
  ttl: 60_000,
} as const;
