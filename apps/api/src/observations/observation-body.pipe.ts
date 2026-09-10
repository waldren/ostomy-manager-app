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
 * Whitelist-strict decoding of an `Observation` request body.
 *
 * A zod pipe rather than Nest's `ValidationPipe`, for three reasons that are
 * all requirements rather than preferences:
 *
 * 1. **The error body.** `ValidationPipe` emits
 *    `{"statusCode":400,"message":[...],"error":"Bad Request"}`, and with the
 *    `forbidNonWhitelisted` behaviour `docs/sync-contract.md` §2 demands,
 *    those messages read `property patientId should not exist` — echoing a
 *    client-supplied key straight back, which §6.2 forbids. Nothing from a
 *    validator's own message ever reaches a response here.
 *
 * 2. **One validation library.** This workspace already validates its
 *    environment with zod; `ValidationPipe` needs `class-validator` and
 *    `class-transformer`. Two libraries expressing the same rules is exactly
 *    the fork ADR-0007 exists to prevent, one layer down.
 *
 * 3. **The published schema comes from the same object.** The OpenAPI
 *    document — and therefore the generated client — is emitted from these
 *    zod schemas, so what the server accepts and what the client is typed
 *    against cannot drift.
 *
 * Extra keys are rejected, never ignored (`strictObject`): silently dropping
 * a field a newer client thought it was sending is a data-loss path with no
 * signal on either side.
 */
import { Injectable, type PipeTransform } from '@nestjs/common';
import { SYNC_REASON_CODE, type SyncReasonCode } from '@ostomy/core/sync';
import type { z } from 'zod';

import {
  fieldPathForIssuePath,
  observationRequestParseSchema,
  OBSERVATION_FIELD,
  type ObservationRequestParsed,
} from './observation-wire';
import { payloadMalformed, type ObservationRejectionField } from './observation-rejection';

/**
 * §6.2 lists its reason codes in a fixed order and §6.3 requires the first
 * failing rule in that order to be the one reported, so that two servers do
 * not walk one patient through different correction sequences for the same
 * payload. Only the shape-level codes can arise here.
 */
const REASON_CODE_RANK: Readonly<Record<string, number>> = {
  [SYNC_REASON_CODE.UNSUPPORTED_CODE]: 0,
  [SYNC_REASON_CODE.UNSUPPORTED_STATUS]: 1,
  [SYNC_REASON_CODE.PAYLOAD_FIELD_INVALID]: 2,
  [SYNC_REASON_CODE.PAYLOAD_FIELD_UNRECOGNIZED]: 3,
};

interface ClassifiedIssue {
  readonly field: ObservationRejectionField;
  readonly reasonCode: SyncReasonCode;
}

function classify(issue: z.core.$ZodIssue): ClassifiedIssue {
  if (issue.code === 'unrecognized_keys') {
    // Reports `payload`, never the key. The key is client-supplied content,
    // and a response the client persists and logs must not carry it (§6.2).
    return {
      field: OBSERVATION_FIELD.PAYLOAD,
      reasonCode: SYNC_REASON_CODE.PAYLOAD_FIELD_UNRECOGNIZED,
    };
  }

  const field = fieldPathForIssuePath(issue.path);
  if (field === OBSERVATION_FIELD.STATUS) {
    // The published type is the full eight-member FHIR value set (§7.2), so
    // a value zod refuses here is by definition outside the set this release
    // accepts.
    return { field, reasonCode: SYNC_REASON_CODE.UNSUPPORTED_STATUS };
  }
  return { field, reasonCode: SYNC_REASON_CODE.PAYLOAD_FIELD_INVALID };
}

@Injectable()
export class ObservationBodyPipe implements PipeTransform<unknown, ObservationRequestParsed> {
  transform(value: unknown): ObservationRequestParsed {
    const result = observationRequestParseSchema.safeParse(value);
    if (result.success) {
      return result.data;
    }

    const classified = result.error.issues
      .map(classify)
      .sort((left, right) => rank(left.reasonCode) - rank(right.reasonCode));

    // `issues` is never empty for a failed parse, but the fallback is here
    // rather than a non-null assertion: the one thing this pipe must never
    // do is throw something other than a value-free rejection.
    throw payloadMalformed(
      classified[0] ?? {
        field: OBSERVATION_FIELD.PAYLOAD,
        reasonCode: SYNC_REASON_CODE.PAYLOAD_FIELD_INVALID,
      },
    );
  }
}

function rank(reasonCode: SyncReasonCode): number {
  return REASON_CODE_RANK[reasonCode] ?? Number.MAX_SAFE_INTEGER;
}
