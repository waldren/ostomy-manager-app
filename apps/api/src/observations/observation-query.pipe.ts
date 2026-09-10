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
 * Query parameters for `GET /observations`.
 *
 * Note what is *not* accepted: any form of patient identifier. The patient
 * is the subject of the presented token and nothing else
 * (`docs/sync-contract.md` §2), so there is no query parameter an attacker
 * could aim at another patient's rows — the field that would carry the
 * attack does not exist.
 */
import { Injectable, type PipeTransform } from '@nestjs/common';
import { z } from 'zod';

import { OBSERVATION_QUERY_FIELD, queryInvalid } from './observation-rejection';

/** Page size defaults. Server configuration, not a clinical threshold. */
export const OBSERVATION_LIST_DEFAULT_LIMIT = 100;
export const OBSERVATION_LIST_MAX_LIMIT = 500;

const instantSchema = z.iso.datetime({ precision: 3 });

export interface ObservationListQuery {
  readonly effectiveDateTimeFrom: Date | undefined;
  readonly effectiveDateTimeTo: Date | undefined;
  readonly limit: number;
}

@Injectable()
export class ObservationQueryPipe implements PipeTransform<unknown, ObservationListQuery> {
  transform(value: unknown): ObservationListQuery {
    const raw: Record<string, unknown> =
      typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

    return {
      effectiveDateTimeFrom: parseInstant(
        raw.effectiveDateTimeFrom,
        OBSERVATION_QUERY_FIELD.EFFECTIVE_DATE_TIME_FROM,
      ),
      effectiveDateTimeTo: parseInstant(
        raw.effectiveDateTimeTo,
        OBSERVATION_QUERY_FIELD.EFFECTIVE_DATE_TIME_TO,
      ),
      limit: parseLimit(raw.limit),
    };
  }
}

function parseInstant(
  raw: unknown,
  field: (typeof OBSERVATION_QUERY_FIELD)[keyof typeof OBSERVATION_QUERY_FIELD],
): Date | undefined {
  if (raw === undefined) {
    return undefined;
  }
  // The same lexical form §7.3 pins for the body: RFC 3339, UTC, exactly
  // three fractional digits. Accepting a looser form here and a stricter one
  // there is how two clients end up disagreeing about what a boundary means.
  const parsed = typeof raw === 'string' ? instantSchema.safeParse(raw) : undefined;
  if (!parsed?.success) {
    throw queryInvalid(field);
  }
  return new Date(parsed.data);
}

function parseLimit(raw: unknown): number {
  if (raw === undefined) {
    return OBSERVATION_LIST_DEFAULT_LIMIT;
  }
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw queryInvalid(OBSERVATION_QUERY_FIELD.LIMIT);
  }
  const parsed = Number.parseInt(raw, 10);
  // Clamped, not refused, for the reason §5.1 gives for the delta cursor's
  // own limit: a `400` here would permanently brick any fielded client whose
  // hardcoded page size the server later lowered. A zero or absurd value is
  // clamped into range rather than argued with.
  return Math.min(Math.max(parsed, 1), OBSERVATION_LIST_MAX_LIMIT);
}
