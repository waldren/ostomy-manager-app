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

import type { SyncDeltaResponse, SyncPushResponse } from '@ostomy/core/api-client';

import { decodeDeltaPage, decodePushResults, UNSPECIFIED_REJECTION_CODE } from './responseDecoding';

function pushResponse(results: unknown[]): SyncPushResponse {
  return { results } as unknown as SyncPushResponse;
}

function deltaResponse(changes: unknown[], cursor = '10'): SyncDeltaResponse {
  return { changes, cursor, hasMore: false } as unknown as SyncDeltaResponse;
}

describe('decodePushResults', () => {
  it('decodes an accepted result into an applied outcome carrying its receipt', () => {
    const [decoded] = decodePushResults(
      pushResponse([
        {
          operationId: 'op-1',
          entityId: 'entity-1',
          status: 'accepted',
          appliedServerSequence: '48213',
          replayed: false,
        },
      ]),
    );

    expect(decoded).toEqual({
      kind: 'applied',
      status: 'accepted',
      operationId: 'op-1',
      entityId: 'entity-1',
      appliedServerSequence: '48213',
    });
  });

  it('decodes superseded as applied, not as a rejection', () => {
    const [decoded] = decodePushResults(
      pushResponse([
        {
          operationId: 'op-1',
          entityId: 'entity-1',
          status: 'superseded',
          appliedServerSequence: '48198',
          replayed: false,
        },
      ]),
    );

    expect(decoded).toMatchObject({ kind: 'applied', status: 'superseded' });
  });

  it('decodes a rejection with its reason code and field', () => {
    const [decoded] = decodePushResults(
      pushResponse([
        {
          operationId: 'op-1',
          entityId: 'entity-1',
          status: 'rejected',
          reasonCode: 'VALUE_NOT_POSITIVE',
          field: 'valueQuantity.value',
          replayed: false,
        },
      ]),
    );

    expect(decoded).toEqual({
      kind: 'rejected',
      operationId: 'op-1',
      entityId: 'entity-1',
      reasonCode: 'VALUE_NOT_POSITIVE',
      field: 'valueQuantity.value',
    });
  });

  /**
   * §8: a new `reasonCode` is additive and an old client must tolerate it.
   * §6.4 says how — degrade to the generic message and keep the code for
   * diagnostics — which makes this the renderer's decision, not the
   * decoder's. Rejecting the result here would instead re-queue an
   * operation the server has already refused (§9.2).
   */
  it('passes an unrecognized reason code through verbatim rather than refusing it', () => {
    const [decoded] = decodePushResults(
      pushResponse([
        {
          operationId: 'op-1',
          entityId: 'entity-1',
          status: 'rejected',
          reasonCode: 'SOME_CODE_ADDED_AFTER_THIS_BUILD_SHIPPED',
          field: 'valueQuantity.value',
          replayed: false,
        },
      ]),
    );

    expect(decoded).toMatchObject({
      kind: 'rejected',
      reasonCode: 'SOME_CODE_ADDED_AFTER_THIS_BUILD_SHIPPED',
    });
  });

  /**
   * Still a rejection: §9.1 forbids dropping it and §9.2 forbids retrying it
   * unchanged, so decoding it as `undecodable` — which puts it straight back
   * on the queue — would violate both.
   */
  it('keeps a rejection that names no reason code, under a code with no patient copy', () => {
    const [decoded] = decodePushResults(
      pushResponse([
        { operationId: 'op-1', entityId: 'entity-1', status: 'rejected', replayed: false },
      ]),
    );

    expect(decoded).toEqual({
      kind: 'rejected',
      operationId: 'op-1',
      entityId: 'entity-1',
      reasonCode: UNSPECIFIED_REJECTION_CODE,
      field: null,
    });
  });

  it('records no field when the server named none, rather than inventing one', () => {
    const [decoded] = decodePushResults(
      pushResponse([
        {
          operationId: 'op-1',
          entityId: 'entity-1',
          status: 'rejected',
          reasonCode: 'ENTITY_NOT_FOUND',
          replayed: false,
        },
      ]),
    );

    expect(decoded).toMatchObject({ field: null });
  });

  /**
   * `String(undefined)` would write the literal text "undefined" into
   * `observations.server_sequence`, and removing the operation from the
   * queue on the strength of a result this malformed would lose the write.
   */
  it('refuses to settle an applied result that carries no server sequence', () => {
    const [decoded] = decodePushResults(
      pushResponse([
        { operationId: 'op-1', entityId: 'entity-1', status: 'accepted', replayed: false },
      ]),
    );

    expect(decoded).toEqual({ kind: 'undecodable', operationId: 'op-1' });
  });

  it('refuses to settle a status outside the three §3.5 defines', () => {
    const [decoded] = decodePushResults(
      pushResponse([
        { operationId: 'op-1', entityId: 'entity-1', status: 'deferred', replayed: false },
      ]),
    );

    expect(decoded).toEqual({ kind: 'undecodable', operationId: 'op-1' });
  });

  it('refuses to settle a result naming no operation', () => {
    const [decoded] = decodePushResults(
      pushResponse([{ entityId: 'entity-1', status: 'accepted', appliedServerSequence: '1' }]),
    );

    expect(decoded).toEqual({ kind: 'undecodable', operationId: undefined });
  });
});

describe('decodeDeltaPage', () => {
  it('decodes an upsert with its payload', () => {
    const page = decodeDeltaPage(
      deltaResponse([
        {
          entityType: 'Observation',
          entityId: 'entity-1',
          serverSequence: '100',
          deleted: false,
          clientUpdatedAt: '2026-09-15T11:00:00.000Z',
          payload: { resourceType: 'Observation', id: 'entity-1' },
        },
      ]),
    );

    expect(page.changes[0]).toMatchObject({ kind: 'upsert', entityId: 'entity-1' });
    expect(page.cursor).toBe('10');
  });

  /**
   * The defect this guard closes. Before P3.S1 this decoder branched only on
   * `deleted` and payload presence, so once the server began sending `Meal`
   * changes a meal decoded as an observation upsert and `deltaPull` wrote its
   * fields into the observations table — a well-formed row of nonsense, with
   * no error anywhere.
   */
  /**
   * P3.S1 PR E made `Meal` a type this build DOES handle, so the guard is now
   * exercised with a type no release has ever defined. The property under test
   * is unchanged and still the one that matters: an unhandled type must never
   * be decoded as an observation and written into that table.
   */
  it('decodes a meal rather than mistaking it for an observation', () => {
    const page = decodeDeltaPage(
      deltaResponse([
        {
          entityType: 'Meal',
          entityId: 'entity-1',
          serverSequence: '100',
          deleted: false,
          clientUpdatedAt: '2026-09-17T11:00:00.000Z',
          payload: {
            id: 'entity-1',
            description: 'Soup',
            size: 'medium',
            tagCodes: ['dairy'],
            effectiveDateTime: '2026-09-17T11:00:00.000Z',
            enteredTimezone: 'America/Chicago',
          },
        },
      ]),
    );

    expect(page.changes[0]).toMatchObject({ kind: 'meal-upsert', entityId: 'entity-1' });
  });

  /**
   * A meal whose payload is not the §7.4 shape is skipped rather than written
   * with invented fields — `size` is a mandatory clinical judgement (AC 2.4
   * AC2) and defaulting it would record an answer the patient never gave.
   */
  it('refuses a meal payload missing its mandatory size', () => {
    const page = decodeDeltaPage(
      deltaResponse([
        {
          entityType: 'Meal',
          entityId: 'entity-1',
          serverSequence: '100',
          deleted: false,
          clientUpdatedAt: '2026-09-17T11:00:00.000Z',
          payload: {
            id: 'entity-1',
            description: 'Soup',
            effectiveDateTime: '2026-09-17T11:00:00.000Z',
            enteredTimezone: 'America/Chicago',
          },
        },
      ]),
    );

    expect(page.changes[0]).toEqual({ kind: 'undecodable' });
  });

  /** §8: an entity type added after this build shipped degrades the same way. */
  it('skips an entity type invented after this build shipped', () => {
    const page = decodeDeltaPage(
      deltaResponse([
        {
          entityType: 'ApplianceChange',
          entityId: 'entity-1',
          serverSequence: '100',
          deleted: true,
          clientUpdatedAt: '2026-09-17T11:00:00.000Z',
        },
      ]),
    );

    expect(page.changes[0]).toEqual({ kind: 'unsupported-entity', entityType: 'ApplianceChange' });
  });

  it('decodes a tombstone, which carries no payload by design (§5.2)', () => {
    const page = decodeDeltaPage(
      deltaResponse([
        {
          entityType: 'Observation',
          entityId: 'entity-1',
          serverSequence: '100',
          deleted: true,
          clientUpdatedAt: '2026-09-15T11:00:00.000Z',
        },
      ]),
    );

    expect(page.changes[0]).toEqual({
      kind: 'tombstone',
      // Carried from P3.S1: the decoder now narrows on `entityType` BEFORE
      // interpreting a payload, and keeping it on the decoded change is what
      // lets a reader tell which table a tombstone belongs to.
      entityType: 'Observation',
      entityId: 'entity-1',
      serverSequence: '100',
      clientUpdatedAt: '2026-09-15T11:00:00.000Z',
    });
  });

  /**
   * §5.2 gives an upsert a payload and a tombstone none. A change that is
   * neither is uninterpretable, and writing a row from it would invent
   * clinical values.
   */
  it('refuses a change that is neither an upsert nor a tombstone', () => {
    const page = decodeDeltaPage(
      deltaResponse([
        {
          entityType: 'Observation',
          entityId: 'entity-1',
          serverSequence: '100',
          deleted: false,
          clientUpdatedAt: '2026-09-15T11:00:00.000Z',
        },
      ]),
    );

    expect(page.changes[0]).toEqual({ kind: 'undecodable' });
  });

  it('refuses a change missing the fields every change must carry', () => {
    const page = decodeDeltaPage(
      deltaResponse([{ entityType: 'Observation', deleted: true, serverSequence: '100' }]),
    );

    expect(page.changes[0]).toEqual({ kind: 'undecodable' });
  });

  it('treats a non-boolean hasMore as false rather than looping on it', () => {
    const page = decodeDeltaPage({
      changes: [],
      cursor: '10',
      hasMore: 'yes',
    } as unknown as SyncDeltaResponse);

    expect(page.hasMore).toBe(false);
  });
});
