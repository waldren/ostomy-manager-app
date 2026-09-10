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
  ObservationQueryPipe,
  OBSERVATION_LIST_DEFAULT_LIMIT,
  OBSERVATION_LIST_MAX_LIMIT,
} from './observation-query.pipe';
import { ObservationRejectedException } from './observation-rejection';

const pipe = new ObservationQueryPipe();

describe('ObservationQueryPipe', () => {
  it('defaults an absent limit and leaves both bounds unset', () => {
    expect(pipe.transform({})).toEqual({
      effectiveDateTimeFrom: undefined,
      effectiveDateTimeTo: undefined,
      limit: OBSERVATION_LIST_DEFAULT_LIMIT,
    });
  });

  it('parses both bounds in the same lexical form the body requires (§7.3)', () => {
    const query = pipe.transform({
      effectiveDateTimeFrom: '2026-09-01T00:00:00.000Z',
      effectiveDateTimeTo: '2026-09-30T23:59:59.999Z',
    });
    expect(query.effectiveDateTimeFrom?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(query.effectiveDateTimeTo?.toISOString()).toBe('2026-09-30T23:59:59.999Z');
  });

  it('refuses a bound in any other lexical form, naming the parameter', () => {
    try {
      pipe.transform({ effectiveDateTimeFrom: '2026-09-01' });
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(ObservationRejectedException);
      expect((error as ObservationRejectedException).details).toEqual([
        { field: 'effectiveDateTimeFrom', reasonCode: 'PAYLOAD_FIELD_INVALID' },
      ]);
    }
  });

  it('clamps an oversized limit rather than refusing it', () => {
    // A 400 here would permanently brick any fielded client whose hardcoded
    // page size the server later lowered — the same argument §5.1 makes for
    // the delta endpoint's own limit.
    expect(pipe.transform({ limit: '100000' }).limit).toBe(OBSERVATION_LIST_MAX_LIMIT);
    expect(pipe.transform({ limit: '0' }).limit).toBe(1);
  });

  it('refuses a non-numeric limit, which is a client bug rather than a big number', () => {
    expect(() => pipe.transform({ limit: 'all' })).toThrow(ObservationRejectedException);
    expect(() => pipe.transform({ limit: '-5' })).toThrow(ObservationRejectedException);
  });
});

/**
 * The body pipe already refuses an unrecognized key (§6.2). The query string
 * silently dropped one, which is the same data-loss path with the same lack
 * of a signal — and worse in effect, because the request still returns 200
 * with a full, unfiltered list.
 */
describe('unrecognized query parameters are refused, not ignored', () => {
  it('rejects a typo of a real parameter rather than returning an unfiltered list', () => {
    // The realistic case: `effectiveDateFrom` for `effectiveDateTimeFrom`.
    expect(() => new ObservationQueryPipe().transform({ effectiveDateFrom: '2026-09-01' })).toThrow(
      ObservationRejectedException,
    );
  });

  it('never echoes the offending key, which is client-supplied content (§6.3)', () => {
    try {
      new ObservationQueryPipe().transform({ patientNickname: 'Marjorie-4471' });
      expect.unreachable('should have thrown');
    } catch (error) {
      const rejection = error as ObservationRejectedException;
      expect(rejection.getStatus()).toBe(400);
      expect(rejection.details).toEqual([
        { field: 'payload', reasonCode: 'PAYLOAD_FIELD_UNRECOGNIZED' },
      ]);
      expect(JSON.stringify(rejection.getResponse())).not.toContain('Marjorie');
      expect(JSON.stringify(rejection.getResponse())).not.toContain('patientNickname');
    }
  });

  it('still accepts every recognized parameter together', () => {
    expect(() =>
      new ObservationQueryPipe().transform({
        effectiveDateTimeFrom: '2026-09-01T00:00:00.000Z',
        effectiveDateTimeTo: '2026-09-30T00:00:00.000Z',
        limit: '50',
      }),
    ).not.toThrow();
  });
});

describe('an inverted date range is refused rather than rendering as "no entries"', () => {
  it('rejects from > to', () => {
    expect(() =>
      new ObservationQueryPipe().transform({
        effectiveDateTimeFrom: '2026-09-30T00:00:00.000Z',
        effectiveDateTimeTo: '2026-09-01T00:00:00.000Z',
      }),
    ).toThrow(ObservationRejectedException);
  });

  it('allows from === to, which is a legitimate single-instant query', () => {
    expect(() =>
      new ObservationQueryPipe().transform({
        effectiveDateTimeFrom: '2026-09-01T00:00:00.000Z',
        effectiveDateTimeTo: '2026-09-01T00:00:00.000Z',
      }),
    ).not.toThrow();
  });

  it('allows either bound on its own', () => {
    expect(() =>
      new ObservationQueryPipe().transform({ effectiveDateTimeFrom: '2026-09-01T00:00:00.000Z' }),
    ).not.toThrow();
    expect(() =>
      new ObservationQueryPipe().transform({ effectiveDateTimeTo: '2026-09-01T00:00:00.000Z' }),
    ).not.toThrow();
  });
});
