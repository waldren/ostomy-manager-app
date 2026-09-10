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
  ObservationPersistenceError,
  isUniqueConstraintViolationOn,
} from './observation-persistence.error';

/** The shape Prisma throws for a unique-constraint violation. */
function prismaUniqueViolation(modelName?: string): Error & { code: string; meta?: unknown } {
  const error = new Error(
    'Unique constraint failed. data: { valueQuantityValue: 2500, effectiveDatetime: ... }',
  ) as Error & { code: string; meta?: unknown };
  error.name = 'PrismaClientKnownRequestError';
  error.code = 'P2002';
  if (modelName !== undefined) {
    error.meta = { modelName, target: ['id'] };
  }
  return error;
}

/**
 * `insertWithAudit` wraps a `$transaction` containing TWO inserts — the
 * observation and its audit row — so "is this a P2002" is not enough to
 * conclude "the client reused an observation id."
 *
 * Getting it wrong is quiet and expensive: an audit-write constraint
 * violation reported as HTTP 409 `ENTITY_ID_CONFLICT` is read by an offline
 * queue as a permanent, non-retryable conflict (`docs/sync-contract.md` §9),
 * so the client stops retrying. The patient's entry is never persisted and
 * never surfaced for correction, and the real failure — the audit row —
 * is recorded as something else.
 */
describe('isUniqueConstraintViolationOn', () => {
  it('recognises a P2002 raised by the named model', () => {
    expect(isUniqueConstraintViolationOn(prismaUniqueViolation('Observation'), 'Observation')).toBe(
      true,
    );
  });

  it('does NOT treat an audit-model P2002 as an observation id conflict', () => {
    expect(isUniqueConstraintViolationOn(prismaUniqueViolation('AuditEvent'), 'Observation')).toBe(
      false,
    );
  });

  it('falls through when the model is absent rather than guessing', () => {
    // Some Prisma error shapes carry no `meta`. Falling through means a 500
    // ("outcome unknown, re-push"), which is true, instead of a 409
    // ("permanent, give up"), which would not be.
    expect(isUniqueConstraintViolationOn(prismaUniqueViolation(undefined), 'Observation')).toBe(
      false,
    );
  });

  it.each([
    ['a different Prisma code', 'P2003'],
    ['no code at all', undefined],
  ])('is false for %s', (_label, code) => {
    const error = new Error('nope') as Error & { code?: string; meta?: unknown };
    if (code !== undefined) error.code = code;
    error.meta = { modelName: 'Observation' };

    expect(isUniqueConstraintViolationOn(error, 'Observation')).toBe(false);
  });

  it.each([[null], [undefined], ['a string'], [42]])('is false for the non-error %s', (value) => {
    expect(isUniqueConstraintViolationOn(value, 'Observation')).toBe(false);
  });
});

describe('ObservationPersistenceError', () => {
  it('carries the entity id and the original name/code, and never the original message', () => {
    const original = prismaUniqueViolation('Observation');
    const wrapped = new ObservationPersistenceError(
      '11111111-2222-3333-4444-555555555555',
      original,
    );

    expect(wrapped.entityId).toBe('11111111-2222-3333-4444-555555555555');
    expect(wrapped.originalErrorName).toBe('PrismaClientKnownRequestError');
    expect(wrapped.originalErrorCode).toBe('P2002');

    // The whole point: Prisma renders the offending `data` — the clinical
    // value — into its own message, and `errSerializer` allow-lists
    // `message` through verbatim.
    expect(wrapped.message).not.toContain('2500');
    expect(wrapped.message).not.toContain('valueQuantityValue');
  });

  it('does not retain the original error as `cause`, which would put it back in scope for a serializer', () => {
    const wrapped = new ObservationPersistenceError('id-1', prismaUniqueViolation('Observation'));

    expect(wrapped.cause).toBeUndefined();
    expect(JSON.stringify(wrapped)).not.toContain('2500');
  });

  it('declares its message value-free so ErrorSanitizerFilter may log it', () => {
    // The opt-in the filter keys on. If this is ever removed, a 500 from
    // this path logs by name only — safe, but less diagnosable.
    expect(new ObservationPersistenceError('id-1', new Error('x')).phiSafeMessage).toBe(true);
  });
});
