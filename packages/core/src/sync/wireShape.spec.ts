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

import { describe, expect, it } from 'vitest';

import { syncDeltaTombstone, syncDeltaUpsert } from './delta.js';
import { toEntityId, toOperationId, toServerSequence } from './identifiers.js';
import { syncAcceptedResult, syncRejectedResult, syncSupersededResult } from './push.js';

/**
 * Runtime key assertions for every shape that leaves the server.
 *
 * These exist because the five `*.type-test.ts` proofs cannot cover the
 * way this actually breaks. TypeScript's excess-property check applies
 * only to properties written literally in a fresh object literal — it does
 * NOT apply to spread properties. Both of these typecheck cleanly against
 * the shipped types:
 *
 *   const t: SyncDeltaTombstone = { ...row, entityType: 'Observation', deleted: true };
 *   const r: SyncRejectedResult = { ...validationResult, status: 'rejected', ... };
 *
 * The first ships the clinical values of a DELETED entry to every device
 * on the account, where they land in `expo-sqlite`. The second puts the
 * offending value in a response the client persists in its correction
 * queue. Neither is an exotic mistake: each is the natural refactor once
 * someone notices the arms share fields.
 *
 * A type-level `Equals` proof cannot see a runtime extra property. Only an
 * assertion on the keys of a constructed object can, which is what this
 * file is. The constructors are the mechanism; these are the tripwire.
 *
 * All values are synthetic (docs/testing.md, CLAUDE.md).
 */

const ENTITY_ID = toEntityId('7a1e2b3c-4d5f-4a6b-8c9d-0e1f2a3b4c5d');
const OPERATION_ID = toOperationId('0f9c3b4e-6a2d-4c1b-9f3a-1d2e3f4a5b6c');
const SEQUENCE = toServerSequence('48213');
const INSTANT = '2026-09-07T22:04:11.412Z';

/** Synthetic clinical content — what must never appear in an assertion below. */
const SYNTHETIC_PAYLOAD = {
  resourceType: 'Observation',
  id: ENTITY_ID,
  status: 'final',
  code: '79560-9',
  valueQuantity: { value: 350, unit: 'mL' },
  effectiveDateTime: '2026-09-07T14:00:00.000Z',
  method: null,
  enteredMeasurementSystem: 'metric',
} as const;

describe('§5.2 — a tombstone carries no payload, at runtime', () => {
  it('produces exactly the five keys the contract names', () => {
    const tombstone = syncDeltaTombstone({
      entityType: 'Observation',
      entityId: ENTITY_ID,
      serverSequence: SEQUENCE,
      clientUpdatedAt: INSTANT,
    });

    expect(Object.keys(tombstone).sort()).toEqual([
      'clientUpdatedAt',
      'deleted',
      'entityId',
      'entityType',
      'serverSequence',
    ]);
  });

  it('drops clinical content handed to it in a wider source object', () => {
    // The shape a delta handler produces once it factors out what the two
    // arms share. Every field here is legitimate on an upsert; `payload`
    // is what must not survive onto a tombstone.
    const row = {
      entityType: 'Observation',
      entityId: ENTITY_ID,
      serverSequence: SEQUENCE,
      clientUpdatedAt: INSTANT,
      payload: SYNTHETIC_PAYLOAD,
    } as const;

    const tombstone = syncDeltaTombstone(row);

    expect(tombstone).not.toHaveProperty('payload');
    expect(JSON.stringify(tombstone)).not.toContain('350');
    expect(JSON.stringify(tombstone)).not.toContain('79560-9');
  });
});

describe('§6.3 — a rejection carries no clinical value, at runtime', () => {
  it('produces exactly the six keys the contract names', () => {
    const rejection = syncRejectedResult({
      operationId: OPERATION_ID,
      entityId: ENTITY_ID,
      reasonCode: 'VALUE_NOT_POSITIVE',
      field: 'valueQuantity.value',
      replayed: false,
    });

    expect(Object.keys(rejection).sort()).toEqual([
      'entityId',
      'field',
      'operationId',
      'reasonCode',
      'replayed',
      'status',
    ]);
  });

  it('drops the offending value handed to it in a wider source object', () => {
    // A validation result that knows the value it rejected — which is the
    // only kind worth having internally, and exactly what must not be
    // spread into a response the client persists and logs.
    const internalValidationResult = {
      field: 'valueQuantity.value',
      reasonCode: 'VALUE_NOT_POSITIVE',
      offendingValueMl: 2500,
    } as const;

    const rejection = syncRejectedResult({
      ...internalValidationResult,
      operationId: OPERATION_ID,
      entityId: ENTITY_ID,
      replayed: false,
    });

    expect(rejection).not.toHaveProperty('offendingValueMl');
    expect(JSON.stringify(rejection)).not.toContain('2500');
  });
});

describe('§3.6 — the applied and superseded receipts', () => {
  it('accepted produces exactly the five keys the contract names', () => {
    const accepted = syncAcceptedResult({
      operationId: OPERATION_ID,
      entityId: ENTITY_ID,
      appliedServerSequence: SEQUENCE,
      replayed: false,
    });

    expect(Object.keys(accepted).sort()).toEqual([
      'appliedServerSequence',
      'entityId',
      'operationId',
      'replayed',
      'status',
    ]);
    // §7.3 — a JSON string, never a number. The loss above 2^53 is silent
    // and would surface years later as a cursor that stops advancing.
    expect(typeof accepted.appliedServerSequence).toBe('string');
  });

  it('superseded produces the same five keys, and drops a spread payload', () => {
    const superseded = syncSupersededResult({
      ...{ payload: SYNTHETIC_PAYLOAD },
      operationId: OPERATION_ID,
      entityId: ENTITY_ID,
      appliedServerSequence: SEQUENCE,
      replayed: false,
    });

    expect(Object.keys(superseded).sort()).toEqual([
      'appliedServerSequence',
      'entityId',
      'operationId',
      'replayed',
      'status',
    ]);
    expect(JSON.stringify(superseded)).not.toContain('350');
  });
});

describe('§5.2 — an upsert carries its payload and nothing more', () => {
  it('produces exactly the six keys the contract names', () => {
    const upsert = syncDeltaUpsert({
      entityType: 'Observation',
      entityId: ENTITY_ID,
      serverSequence: SEQUENCE,
      clientUpdatedAt: INSTANT,
      payload: SYNTHETIC_PAYLOAD,
    });

    expect(Object.keys(upsert).sort()).toEqual([
      'clientUpdatedAt',
      'deleted',
      'entityId',
      'entityType',
      'payload',
      'serverSequence',
    ]);
  });
});
