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

import { TIER1_RULE_CODE, TIER2_RULE_CODE } from '@ostomy/core/validation';
import { SYNC_REASON_CODE } from '@ostomy/core/sync';
import { describe, expect, it } from 'vitest';

import type { Observation } from '../generated/prisma/client';
import { MeasurementSystem, ObservationStatus } from '../generated/prisma/enums';
import {
  interpretObservationPayload,
  toAuditSnapshot,
  toObservationResource,
  toRejectionDetails,
  toStoredMeasurementSystem,
  toWarnings,
} from './observation-payload';
import { ObservationRejectedException } from './observation-rejection';
import type { ObservationRequestParsed } from './observation-wire';

function payload(overrides: Partial<ObservationRequestParsed> = {}): ObservationRequestParsed {
  return {
    resourceType: 'Observation',
    id: '7a1e2b3c-4d5f-4a6b-8c9d-0e1f2a3b4c5d',
    status: 'final',
    code: '79560-9',
    valueQuantity: { value: 350, unit: 'mL' },
    effectiveDateTime: '2026-09-07T14:00:00.000Z',
    method: null,
    enteredMeasurementSystem: 'metric',
    enteredTimezone: 'America/Chicago',
    ...overrides,
  } as ObservationRequestParsed;
}

function rejectionOf(run: () => unknown): ObservationRejectedException {
  try {
    run();
  } catch (error) {
    if (error instanceof ObservationRejectedException) {
      return error;
    }
    throw error;
  }
  throw new Error('expected a rejection');
}

describe('interpretObservationPayload — release-scope acceptance', () => {
  it('accepts a stoma-output payload and leaves the value untyped for Tier 1', () => {
    const input = interpretObservationPayload(payload());
    expect(input.rawValueMl).toBe(350);
    expect(input.unit).toBe('mL');
    expect(input.effectiveDateTime.toISOString()).toBe('2026-09-07T14:00:00.000Z');
    expect(input.enteredMeasurementSystem).toBe('metric');
  });

  it.each([
    ['29463-7', SYNC_REASON_CODE.UNSUPPORTED_CODE, 'code'],
    ['9000-1', SYNC_REASON_CODE.UNSUPPORTED_CODE, 'code'],
  ])('refuses code %s with %s', (code, reasonCode, field) => {
    const rejection = rejectionOf(() => interpretObservationPayload(payload({ code })));
    expect(rejection.details).toEqual([{ field, reasonCode }]);
  });

  it('refuses a status this release does not accept, without echoing it', () => {
    const rejection = rejectionOf(() =>
      interpretObservationPayload(payload({ status: 'amended' })),
    );
    expect(rejection.details).toEqual([
      { field: 'status', reasonCode: SYNC_REASON_CODE.UNSUPPORTED_STATUS },
    ]);
  });

  it('refuses a unit that disagrees with the code', () => {
    const rejection = rejectionOf(() =>
      interpretObservationPayload(payload({ valueQuantity: { value: 80, unit: 'kg' } })),
    );
    expect(rejection.details).toEqual([
      { field: 'valueQuantity.unit', reasonCode: SYNC_REASON_CODE.PAYLOAD_FIELD_INVALID },
    ]);
  });

  it('refuses a non-null method while D4 is unresolved (§7.2)', () => {
    const rejection = rejectionOf(() =>
      interpretObservationPayload(payload({ method: 'some-snomed-code' })),
    );
    expect(rejection.details).toEqual([
      { field: 'method', reasonCode: SYNC_REASON_CODE.PAYLOAD_FIELD_INVALID },
    ]);
  });

  it('refuses a measurement system outside the two that exist', () => {
    const rejection = rejectionOf(() =>
      interpretObservationPayload(payload({ enteredMeasurementSystem: 'us-customary' })),
    );
    expect(rejection.details).toEqual([
      {
        field: 'enteredMeasurementSystem',
        reasonCode: SYNC_REASON_CODE.PAYLOAD_FIELD_INVALID,
      },
    ]);
  });

  it('passes an absent method through, so Tier 1 rather than the parser blocks it', () => {
    const withoutMethod = payload();
    const input = interpretObservationPayload({
      ...withoutMethod,
      method: undefined,
    } as ObservationRequestParsed);
    expect(input.method).toEqual({ kind: 'not-selected' });
  });
});

describe('Tier 1 errors are re-pointed at the field each rule is about', () => {
  it('gives each rule code the field a correction UI must highlight', () => {
    // `packages/core`'s `evaluateTier1` stamps the caller's single `field`
    // onto every error it produces, so all five arrive naming
    // `valueQuantity.value` unless the API re-derives the field. §6.2
    // requires `field` to name the offending field.
    const details = toRejectionDetails([
      { field: 'valueQuantity.value', ruleCode: TIER1_RULE_CODE.VALUE_NOT_POSITIVE },
      { field: 'valueQuantity.value', ruleCode: TIER1_RULE_CODE.METHOD_REQUIRED },
      { field: 'valueQuantity.value', ruleCode: TIER1_RULE_CODE.EFFECTIVE_DATE_TIME_IN_FUTURE },
      {
        field: 'valueQuantity.value',
        ruleCode: TIER1_RULE_CODE.EFFECTIVE_DATE_TIME_BEFORE_SURGERY,
      },
    ]);

    expect(details).toEqual([
      { field: 'valueQuantity.value', reasonCode: 'VALUE_NOT_POSITIVE' },
      { field: 'method', reasonCode: 'METHOD_REQUIRED' },
      { field: 'effectiveDateTime', reasonCode: 'EFFECTIVE_DATE_TIME_IN_FUTURE' },
      { field: 'effectiveDateTime', reasonCode: 'EFFECTIVE_DATE_TIME_BEFORE_SURGERY' },
    ]);
  });

  it('carries no property a clinical value could occupy', () => {
    const details = toRejectionDetails([
      { field: 'valueQuantity.value', ruleCode: TIER1_RULE_CODE.VALUE_NOT_POSITIVE },
    ]);
    expect(Object.keys(details[0]!).sort()).toEqual(['field', 'reasonCode']);
  });

  it('does the same for a Tier 2 warning', () => {
    const warnings = toWarnings([
      { field: 'valueQuantity.value', ruleCode: TIER2_RULE_CODE.VALUE_ABOVE_TYPICAL_RANGE },
    ]);
    expect(warnings).toEqual([
      { field: 'valueQuantity.value', ruleCode: 'VALUE_ABOVE_TYPICAL_RANGE' },
    ]);
    expect(Object.keys(warnings[0]!).sort()).toEqual(['field', 'ruleCode']);
  });
});

function storedRow(overrides: Partial<Observation> = {}): Observation {
  return {
    id: '7a1e2b3c-4d5f-4a6b-8c9d-0e1f2a3b4c5d',
    patientId: '0f9c3b4e-6a2d-4c1b-9f3a-1d2e3f4a5b6c',
    resourceType: 'Observation',
    code: '79560-9',
    // The generated client types this as a Prisma `Decimal`; the only member
    // the mapper uses is `toNumber()`.
    valueQuantityValue: { toNumber: () => 350.25 },
    valueQuantityUnit: 'mL',
    effectiveDatetime: new Date('2026-09-07T14:00:00.000Z'),
    method: null,
    status: ObservationStatus.FINAL,
    enteredMeasurementSystem: MeasurementSystem.IMPERIAL,
    enteredTimezone: 'America/Chicago',
    // The stored day. 14:00Z on the 7th is 09:00 in Chicago, so the row's
    // local date is the 7th — but an evening entry would differ from its
    // UTC date, which is the whole reason this column exists (ADR-0016).
    localDate: new Date('2026-09-07T00:00:00.000Z'),
    clientUpdatedAt: new Date('2026-09-07T22:04:11.412Z'),
    serverSequence: 48213n,
    deletedAt: null,
    createdAt: new Date('2026-09-07T22:04:11.500Z'),
    updatedAt: new Date('2026-09-07T22:04:11.500Z'),
    ...overrides,
  } as unknown as Observation;
}

describe('toObservationResource — a stored row, as §7.2 spells it', () => {
  it('emits FHIR field names and nothing else', () => {
    const resource = toObservationResource(storedRow());
    expect(resource).toEqual({
      resourceType: 'Observation',
      id: '7a1e2b3c-4d5f-4a6b-8c9d-0e1f2a3b4c5d',
      status: 'final',
      code: '79560-9',
      valueQuantity: { value: 350.25, unit: 'mL' },
      effectiveDateTime: '2026-09-07T14:00:00.000Z',
      method: null,
      enteredMeasurementSystem: 'imperial',
      enteredTimezone: 'America/Chicago',
    });
  });

  it('never leaks patientId, serverSequence or the tombstone column', () => {
    const resource = toObservationResource(storedRow()) as Record<string, unknown>;
    for (const forbidden of ['patientId', 'serverSequence', 'deletedAt', 'clientUpdatedAt']) {
      expect(resource[forbidden]).toBeUndefined();
    }
  });

  it('lowercases the stored status onto its FHIR wire spelling', () => {
    expect(
      toObservationResource(storedRow({ status: ObservationStatus.ENTERED_IN_ERROR })).status,
    ).toBe('entered-in-error');
  });
});

describe('toAuditSnapshot', () => {
  it("records the entity's own stored fields, with the BigInt sequence stringified", () => {
    const snapshot = toAuditSnapshot(storedRow());
    expect(snapshot).toMatchObject({
      id: '7a1e2b3c-4d5f-4a6b-8c9d-0e1f2a3b4c5d',
      code: '79560-9',
      valueQuantityValue: 350.25,
      valueQuantityUnit: 'mL',
      status: 'FINAL',
      enteredMeasurementSystem: 'IMPERIAL',
      serverSequence: '48213',
      deletedAt: null,
    });
    // JSON.stringify throws on a BigInt; an audit row that cannot serialise
    // is an audit row that does not get written.
    expect(() => JSON.stringify(snapshot)).not.toThrow();
  });
});

describe('toStoredMeasurementSystem', () => {
  it('maps the wire spelling onto the Prisma enum both ways round-trip', () => {
    expect(toStoredMeasurementSystem('metric')).toBe(MeasurementSystem.METRIC);
    expect(toStoredMeasurementSystem('imperial')).toBe(MeasurementSystem.IMPERIAL);
  });
});
