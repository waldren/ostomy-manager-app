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
 * The direct endpoint and the sync endpoint must not invent two shapes for
 * one entity. These tests are what stops that drifting, in both directions:
 * against `packages/core`'s `ObservationSyncPayload` (the wire contract's own
 * type) and between this module's own published and runtime schemas.
 */
import type { ObservationSyncPayload } from '@ostomy/core/sync';
import { describe, expect, it } from 'vitest';

import {
  observationRequestParseSchema,
  observationResourceSchema,
  fieldPathForIssuePath,
  OBSERVATION_FIELD,
  type ObservationResource,
} from './observation-wire';

/**
 * Compile-time key parity with the sync payload type.
 *
 * Keys, not value types: the sync type's `id` is a branded `EntityId` and its
 * `method` narrows to `null` while D4 is unresolved, so demanding identical
 * property types would fail for reasons that have nothing to do with the
 * shape. What must never differ is the set of field names — that is what
 * "one wire shape" means, and it is what a client author reads.
 */
type SyncKeys = keyof ObservationSyncPayload;
type ResourceKeys = keyof ObservationResource;
const _syncKeysAreResourceKeys: SyncKeys extends ResourceKeys ? true : false = true;
const _resourceKeysAreSyncKeys: ResourceKeys extends SyncKeys ? true : false = true;
void _syncKeysAreResourceKeys;
void _resourceKeysAreSyncKeys;

const EXPECTED_KEYS = [
  'resourceType',
  'id',
  'status',
  'code',
  'valueQuantity',
  'effectiveDateTime',
  'method',
  'enteredMeasurementSystem',
  'enteredTimezone',
];

describe('observation wire shape', () => {
  it('publishes exactly the fields docs/sync-contract.md §7.2 names, and no others', () => {
    expect(Object.keys(observationResourceSchema.shape).sort()).toEqual([...EXPECTED_KEYS].sort());
  });

  it('has no patientId — §2 forbids a patient identifier anywhere in a request', () => {
    expect(Object.keys(observationResourceSchema.shape)).not.toContain('patientId');
    expect(Object.keys(observationRequestParseSchema.shape)).not.toContain('patientId');
  });

  it('publishes no server bookkeeping: serverSequence, deletedAt, createdAt, updatedAt', () => {
    const keys = Object.keys(observationResourceSchema.shape);
    for (const forbidden of ['serverSequence', 'deletedAt', 'createdAt', 'updatedAt']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('parses with exactly the same key set it publishes', () => {
    // The runtime parser is looser about two field *types* on purpose (see
    // the module header). If it ever became looser about which fields exist,
    // the published schema would stop describing what the server accepts.
    expect(Object.keys(observationRequestParseSchema.shape).sort()).toEqual(
      Object.keys(observationResourceSchema.shape).sort(),
    );
  });
});

describe('effectiveDateTime lexical form (§7.3)', () => {
  const base = {
    resourceType: 'Observation',
    id: '7a1e2b3c-4d5f-4a6b-8c9d-0e1f2a3b4c5d',
    status: 'final',
    code: '79560-9',
    valueQuantity: { value: 350, unit: 'mL' },
    method: null,
    enteredMeasurementSystem: 'metric',
    enteredTimezone: 'America/Chicago',
  };

  it.each([
    ['2026-09-07T14:00:00.000Z', true],
    ['2026-09-07T14:00:00Z', false],
    ['2026-09-07T14:00:00.000000Z', false],
    ['2026-09-07T14:00:00.000+02:00', false],
    ['2026-09-07', false],
  ])('%s -> accepted: %s', (value, accepted) => {
    const result = observationRequestParseSchema.safeParse({ ...base, effectiveDateTime: value });
    expect(result.success).toBe(accepted);
  });
});

describe('runtime parser: what it deliberately lets through to Tier 1', () => {
  const base = {
    resourceType: 'Observation',
    id: '7a1e2b3c-4d5f-4a6b-8c9d-0e1f2a3b4c5d',
    status: 'final',
    code: '79560-9',
    effectiveDateTime: '2026-09-07T14:00:00.000Z',
    method: null,
    enteredMeasurementSystem: 'metric',
    enteredTimezone: 'America/Chicago',
  };

  it('accepts a non-numeric value at the transport layer so VALUE_NOT_NUMERIC can block it', () => {
    const result = observationRequestParseSchema.safeParse({
      ...base,
      valueQuantity: { value: 'three hundred', unit: 'mL' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts an absent method key so METHOD_REQUIRED can block it (AC 2.2 AC 1)', () => {
    const { method: _method, ...withoutMethod } = base;
    const result = observationRequestParseSchema.safeParse({
      ...withoutMethod,
      valueQuantity: { value: 350, unit: 'mL' },
    });
    expect(result.success).toBe(true);
  });

  it('still rejects an unrecognized key rather than ignoring it', () => {
    const result = observationRequestParseSchema.safeParse({
      ...base,
      valueQuantity: { value: 350, unit: 'mL' },
      patientId: 'another-patients-id',
    });
    expect(result.success).toBe(false);
  });
});

describe('fieldPathForIssuePath', () => {
  it('maps every payload path onto a member of the closed field-path set', () => {
    expect(fieldPathForIssuePath(['valueQuantity', 'value'])).toBe(OBSERVATION_FIELD.VALUE);
    expect(fieldPathForIssuePath(['valueQuantity'])).toBe(OBSERVATION_FIELD.VALUE);
    expect(fieldPathForIssuePath(['valueQuantity', 'unit'])).toBe(OBSERVATION_FIELD.UNIT);
    expect(fieldPathForIssuePath(['effectiveDateTime'])).toBe(
      OBSERVATION_FIELD.EFFECTIVE_DATE_TIME,
    );
    expect(fieldPathForIssuePath(['method'])).toBe(OBSERVATION_FIELD.METHOD);
  });

  it('reports `payload` for anything unmapped rather than echoing the path', () => {
    // The path of an unrecognized key IS the client-supplied key. Returning
    // it would echo client content into a response the client persists.
    expect(fieldPathForIssuePath(['someKeyAClientInvented'])).toBe(OBSERVATION_FIELD.PAYLOAD);
  });
});
