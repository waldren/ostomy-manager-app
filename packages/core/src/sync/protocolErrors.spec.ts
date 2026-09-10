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

import {
  isSyncProtocolErrorCode,
  SYNC_PROTOCOL_ERROR_CODE,
  type SyncProtocolErrorResponse,
} from './protocolErrors.js';
import { SYNC_REASON_CODE } from './reasonCodes.js';

describe('SYNC_PROTOCOL_ERROR_CODE — docs/sync-contract.md §6.1', () => {
  it('names exactly the seven conditions §6.1 tabulates', () => {
    expect(Object.keys(SYNC_PROTOCOL_ERROR_CODE).sort()).toEqual([
      'BATCH_OUT_OF_ORDER',
      'BATCH_TOO_LARGE',
      'CURSOR_TOO_OLD',
      'ENTITY_ID_MISMATCH',
      'MALFORMED_REQUEST',
      'PAYLOAD_PRESENCE_INVALID',
      'UNAUTHENTICATED',
    ]);
  });

  it('is disjoint from the data-error vocabulary', () => {
    // The two are different kinds of failure with different client
    // handling — a protocol error fails the request and has nothing a
    // patient could correct; a data error fails one operation and goes to
    // the correction inbox. An overlapping identifier is how one gets
    // handled as the other.
    const dataErrors = new Set<string>(Object.values(SYNC_REASON_CODE));
    for (const code of Object.values(SYNC_PROTOCOL_ERROR_CODE)) {
      expect(dataErrors.has(code)).toBe(false);
    }
  });

  it('carries no prose — the server sends codes, the client renders copy', () => {
    for (const code of Object.values(SYNC_PROTOCOL_ERROR_CODE)) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it('narrows an unknown code at the decode boundary rather than trusting it', () => {
    expect(isSyncProtocolErrorCode('BATCH_TOO_LARGE')).toBe(true);
    // Additive under §8: a fielded client will meet codes it has never
    // heard of and must degrade rather than crash.
    expect(isSyncProtocolErrorCode('SOME_FUTURE_CODE')).toBe(false);
    expect(isSyncProtocolErrorCode(undefined)).toBe(false);
    expect(isSyncProtocolErrorCode(413)).toBe(false);
  });

  it('a body has one key and its error has one key', () => {
    const body: SyncProtocolErrorResponse = { error: { code: 'MALFORMED_REQUEST' } };
    expect(Object.keys(body)).toEqual(['error']);
    expect(Object.keys(body.error)).toEqual(['code']);
  });
});
