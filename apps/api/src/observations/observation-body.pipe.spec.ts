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

import { SYNC_REASON_CODE } from '@ostomy/core/sync';
import { describe, expect, it } from 'vitest';

import { ObservationBodyPipe } from './observation-body.pipe';
import { ObservationRejectedException } from './observation-rejection';

const pipe = new ObservationBodyPipe();

const VALID = {
  resourceType: 'Observation',
  id: '7a1e2b3c-4d5f-4a6b-8c9d-0e1f2a3b4c5d',
  status: 'final',
  code: '79560-9',
  valueQuantity: { value: 350, unit: 'mL' },
  effectiveDateTime: '2026-09-07T14:00:00.000Z',
  method: null,
  enteredMeasurementSystem: 'metric',
  enteredTimezone: 'America/Chicago',
};

function rejectionFor(body: unknown): ObservationRejectedException {
  try {
    pipe.transform(body);
  } catch (error) {
    if (error instanceof ObservationRejectedException) {
      return error;
    }
    throw error;
  }
  throw new Error('expected the pipe to reject this body');
}

describe('ObservationBodyPipe', () => {
  it('passes a well-formed payload through unchanged', () => {
    expect(pipe.transform(VALID)).toEqual(VALID);
  });

  it('rejects an unrecognized key, reporting `payload` and never the key itself', () => {
    const rejection = rejectionFor({ ...VALID, patientId: 'b-patient-uuid', nickname: 'Bob' });

    expect(rejection.details).toEqual([
      { field: 'payload', reasonCode: SYNC_REASON_CODE.PAYLOAD_FIELD_UNRECOGNIZED },
    ]);

    // The whole serialized response, not just the details array: zod's own
    // message for this issue reads `Unrecognized key: "patientId"`, and a
    // framework default would put it on the wire.
    const serialized = JSON.stringify(rejection.getResponse());
    expect(serialized).not.toContain('patientId');
    expect(serialized).not.toContain('nickname');
    expect(serialized).not.toContain('Bob');
  });

  it('never echoes a submitted clinical value, in the body or the log message', () => {
    const rejection = rejectionFor({
      ...VALID,
      effectiveDateTime: 'yesterday',
      valueQuantity: { value: 1234.5, unit: 'mL' },
    });

    const serialized = JSON.stringify(rejection.getResponse());
    expect(serialized).not.toContain('1234.5');
    expect(serialized).not.toContain('yesterday');
    expect(rejection.describe()).not.toContain('1234.5');
    expect(rejection.message).not.toContain('1234.5');
  });

  it.each([
    ['not-a-uuid', 'id'],
    [undefined, 'id'],
  ])('rejects a malformed id (%s) as PAYLOAD_FIELD_INVALID on `id`', (id, field) => {
    const rejection = rejectionFor({ ...VALID, id });
    expect(rejection.details).toEqual([
      { field, reasonCode: SYNC_REASON_CODE.PAYLOAD_FIELD_INVALID },
    ]);
  });

  it('reports a status outside the FHIR value set as UNSUPPORTED_STATUS', () => {
    const rejection = rejectionFor({ ...VALID, status: 'draft' });
    expect(rejection.details).toEqual([
      { field: 'status', reasonCode: SYNC_REASON_CODE.UNSUPPORTED_STATUS },
    ]);
  });

  it('reports a malformed effectiveDateTime as PAYLOAD_FIELD_INVALID', () => {
    const rejection = rejectionFor({ ...VALID, effectiveDateTime: '2026-09-07T14:00:00Z' });
    expect(rejection.details).toEqual([
      { field: 'effectiveDateTime', reasonCode: SYNC_REASON_CODE.PAYLOAD_FIELD_INVALID },
    ]);
  });

  it('reports one detail even when several fields are wrong, in §6.2 order', () => {
    // An unrecognized key and an invalid field at once: §6.2 lists
    // PAYLOAD_FIELD_INVALID before PAYLOAD_FIELD_UNRECOGNIZED, and §6.3
    // requires the first in that order, so two servers walk one patient
    // through the same correction sequence.
    const rejection = rejectionFor({ ...VALID, effectiveDateTime: 'nope', extraKey: 1 });
    expect(rejection.details).toHaveLength(1);
    expect(rejection.details[0]!.reasonCode).toBe(SYNC_REASON_CODE.PAYLOAD_FIELD_INVALID);
  });

  it.each([[null], ['a string body'], [42], [[]]])('rejects a non-object body: %s', (body) => {
    expect(() => pipe.transform(body)).toThrow(ObservationRejectedException);
  });

  it('returns 400 for a malformed payload — a client bug, not a correctable entry', () => {
    expect(rejectionFor({ ...VALID, status: 'draft' }).getStatus()).toBe(400);
  });
});
