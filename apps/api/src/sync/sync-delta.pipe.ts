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

import { Inject, Injectable, type PipeTransform } from '@nestjs/common';

import { APP_CONFIG } from '../config/config.tokens';
import type { AppConfig } from '../config/env.schema';
import { malformedRequest } from './sync-protocol.error';

/** A decoded delta request (`docs/sync-contract.md` §5.1). */
export interface SyncDeltaQueryParsed {
  /** Exclusive lower bound. `0n` requests everything — initial sync. */
  readonly since: bigint;
  readonly limit: number;
}

/**
 * Decodes `?since=&limit=` for `GET /api/v1/sync/delta`.
 *
 * Two rules here pull in opposite directions and both are deliberate.
 *
 * **`since` is strict.** Absent or non-numeric is `MALFORMED_REQUEST`
 * (§5.1). There is no default: a client that omits it has a bug, and
 * defaulting to `0` would silently re-download the patient's entire clinical
 * history over cellular — the exact outcome §5.1 rules out when it discusses
 * what a too-high `since` must return.
 *
 * **`limit` is lenient.** A value above the maximum is **clamped, not
 * refused** (§5.1), because a `400` would permanently brick any fielded
 * client whose hardcoded page size the server later lowered. The client
 * discovers the real page size from the response. This is the same reasoning
 * `observation-query.pipe.ts` applies to its own limit, and the same reason
 * `SYNC_DELTA_MAX_LIMIT` is configuration rather than a constant.
 *
 * A malformed `limit` — non-numeric, negative — is still `MALFORMED_REQUEST`
 * rather than silently clamped: clamping is for a value that is too big,
 * not for one that is not a page size at all.
 *
 * `since` is parsed as `bigint`, never `number`. §7.3 makes server sequences
 * strings on the wire precisely because they are 64-bit and `JSON.parse`
 * loses precision above 2^53; routing them through a JS `number` here would
 * reintroduce the loss the wire format exists to avoid, and it would surface
 * years from now as a cursor that stops advancing with no error.
 */
@Injectable()
export class SyncDeltaPipe implements PipeTransform<unknown, SyncDeltaQueryParsed> {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  transform(value: unknown): SyncDeltaQueryParsed {
    const raw: Record<string, unknown> =
      typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

    // Whitelist-strict, as everywhere else on this surface (§2). An
    // unrecognized query parameter is a client bug, and ignoring it would
    // silently drop something a newer client meant to send.
    for (const key of Object.keys(raw)) {
      if (key !== 'since' && key !== 'limit') {
        throw malformedRequest();
      }
    }

    return { since: parseSince(raw.since), limit: this.parseLimit(raw.limit) };
  }

  private parseLimit(raw: unknown): number {
    if (raw === undefined) {
      return this.config.syncDeltaDefaultLimit;
    }
    if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
      throw malformedRequest();
    }
    const parsed = Number.parseInt(raw, 10);
    if (parsed < 1) {
      throw malformedRequest();
    }
    // Clamped, never refused. See the class comment.
    return Math.min(parsed, this.config.syncDeltaMaxLimit);
  }
}

function parseSince(raw: unknown): bigint {
  // Digits only: no sign, no exponent, no decimal point. `BigInt()` would
  // accept `0x10` and whitespace, and a `since` the client did not mean is
  // worse than a refusal — it silently skips or re-sends rows.
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw malformedRequest();
  }
  return BigInt(raw);
}
