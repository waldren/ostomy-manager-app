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

import { isSyncFieldPath, isSyncReasonCode } from '@ostomy/core/sync';
import { describe, expect, it } from 'vitest';

import {
  entityIdConflict,
  observationNotFound,
  patientNotProvisioned,
  queryInvalid,
  validationBlocked,
  OBSERVATION_ERROR_CODE,
  OBSERVATION_QUERY_FIELD,
} from './observation-rejection';

describe('rejection bodies', () => {
  it('have exactly two levels of keys, and no place for a value', () => {
    const body = validationBlocked([
      { field: 'valueQuantity.value', reasonCode: 'VALUE_NOT_POSITIVE' },
    ]).getResponse() as { error: { code: string; errors: Array<Record<string, unknown>> } };

    expect(Object.keys(body)).toEqual(['error']);
    expect(Object.keys(body.error).sort()).toEqual(['code', 'errors']);
    expect(Object.keys(body.error.errors[0]!).sort()).toEqual(['field', 'reasonCode']);
  });

  it('cannot be widened by a caller passing extra properties', () => {
    // The constructor projects a fixed field set. This is the §6.3 rule that
    // `{ ...validationResult, status: 'rejected' }` typechecks cleanly and
    // serialises whatever the source carried.
    const body = validationBlocked([
      {
        field: 'valueQuantity.value',
        reasonCode: 'VALUE_NOT_POSITIVE',
        // @ts-expect-error — the detail type has no such property, and the
        // runtime projection drops it even when a cast smuggles one in.
        submittedValue: 2500,
      },
    ]).getResponse();

    expect(JSON.stringify(body)).not.toContain('2500');
    expect(JSON.stringify(body)).not.toContain('submittedValue');
  });

  it('use only codes and field paths from the closed sets packages/core owns', () => {
    const details = [
      ...entityIdConflict().details,
      ...observationNotFound().details,
      ...validationBlocked([{ field: 'method', reasonCode: 'METHOD_REQUIRED' }]).details,
    ];

    for (const detail of details) {
      expect(isSyncReasonCode(detail.reasonCode)).toBe(true);
      expect(isSyncFieldPath(detail.field)).toBe(true);
    }
  });

  it('name a query parameter for a query rejection, which is a server-chosen constant', () => {
    const rejection = queryInvalid(OBSERVATION_QUERY_FIELD.LIMIT);
    expect(rejection.details).toEqual([{ field: 'limit', reasonCode: 'PAYLOAD_FIELD_INVALID' }]);
  });
});

describe('status codes', () => {
  it('separates "your client is broken" from "your entry needs correcting"', () => {
    expect(
      validationBlocked([{ field: 'method', reasonCode: 'METHOD_REQUIRED' }]).getStatus(),
    ).toBe(422);
    expect(entityIdConflict().getStatus()).toBe(409);
    expect(observationNotFound().getStatus()).toBe(404);
    expect(patientNotProvisioned().getStatus()).toBe(403);
  });

  it('returns the same conflict code whoever owns the colliding row', () => {
    // One code for both cases, so this endpoint cannot be used as an oracle
    // for whether another patient's entity id exists.
    expect(entityIdConflict().code).toBe(OBSERVATION_ERROR_CODE.ID_CONFLICT);
    expect(entityIdConflict().details).toEqual([{ field: 'id', reasonCode: 'ENTITY_ID_CONFLICT' }]);
  });

  it('carries no details at all when there is nothing to correct', () => {
    expect(patientNotProvisioned().details).toEqual([]);
  });
});
