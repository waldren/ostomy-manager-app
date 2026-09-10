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
  isEntityId,
  isOperationId,
  isServerSequence,
  isServerSequenceAfter,
  toEntityId,
  toOperationId,
  toServerSequence,
  type ServerSequence,
} from './identifiers.js';

// Every identifier below is synthetic — a hand-typed UUID and an
// arbitrary sequence number. No real or realistic patient data appears in
// any fixture in this repository (docs/testing.md).
const SYNTHETIC_UUID = '0f9c3b4e-6a2d-4c1b-9f3a-1d2e3f4a5b6c';

describe('§7.3 — a server sequence is a string, never a number', () => {
  it('accepts the canonical decimal-integer form, including the initial-sync 0', () => {
    expect(isServerSequence('0')).toBe(true);
    expect(isServerSequence('48213')).toBe(true);
    expect(toServerSequence('48213')).toBe('48213');
  });

  it('survives values past the double exact-integer limit without loss — the reason it is a string', () => {
    // 2^53 + 1. Round-tripping this through a JSON number is exactly the
    // silent failure §7.3 describes; through this type it is inert text.
    const beyondDoublePrecision = '9007199254740993';
    expect(toServerSequence(beyondDoublePrecision)).toBe(beyondDoublePrecision);
    expect(String(Number(beyondDoublePrecision))).not.toBe(beyondDoublePrecision);
  });

  it.each([
    ['a JSON number', 48213],
    ['a leading-zero form, which is not canonical', '048213'],
    ['a negative value', '-1'],
    ['a decimal', '48213.0'],
    ['an empty string', ''],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expect(isServerSequence(value)).toBe(false);
  });

  it('throws without echoing the rejected value, which is untrusted input bound for a log', () => {
    expect(() => toServerSequence('not-a-sequence')).toThrow(TypeError);
    try {
      toServerSequence('not-a-sequence');
    } catch (error) {
      expect((error as Error).message).not.toContain('not-a-sequence');
    }
  });

  it('compares as an integer, not lexicographically and not through Number()', () => {
    const nine = toServerSequence('9');
    const many = toServerSequence('48213');

    expect(isServerSequenceAfter(many, nine)).toBe(true);
    expect(isServerSequenceAfter(nine, many)).toBe(false);
    // A lexicographic comparison would get this backwards.
    expect(nine > many).toBe(true);
  });

  it('compares correctly past the double exact-integer limit', () => {
    // 2^53 and 2^53 + 1: distinct integers, but the second is not
    // representable as a double and collapses onto the first.
    const lower = toServerSequence('9007199254740992');
    const higher = toServerSequence('9007199254740993');

    expect(isServerSequenceAfter(higher, lower)).toBe(true);
    // Through Number() both collapse and the comparison is false — the bug
    // this helper exists to keep out of every consumer.
    expect(Number(higher) > Number(lower)).toBe(false);
  });

  it('is exclusive at the cursor value itself (§5.1)', () => {
    const cursor: ServerSequence = toServerSequence('48198');
    expect(isServerSequenceAfter(cursor, cursor)).toBe(false);
  });
});

describe('§1 — operation ids and entity ids', () => {
  it('accepts a canonical UUID for either', () => {
    expect(isOperationId(SYNTHETIC_UUID)).toBe(true);
    expect(isEntityId(SYNTHETIC_UUID)).toBe(true);
    expect(toOperationId(SYNTHETIC_UUID)).toBe(SYNTHETIC_UUID);
    expect(toEntityId(SYNTHETIC_UUID)).toBe(SYNTHETIC_UUID);
  });

  it.each([
    ['a non-UUID string', 'operation-1'],
    ['a UUID missing a group', '0f9c3b4e-6a2d-4c1b-9f3a'],
    ['a number', 1],
    ['undefined', undefined],
  ])('rejects %s', (_label, value) => {
    expect(isOperationId(value)).toBe(false);
    expect(isEntityId(value)).toBe(false);
  });

  it('throws without echoing the rejected value', () => {
    expect(() => toOperationId('nope')).toThrow(TypeError);
    expect(() => toEntityId('nope')).toThrow(TypeError);
    try {
      toOperationId('nope');
    } catch (error) {
      expect((error as Error).message).not.toContain('nope');
    }
  });

  it('the two are distinct types, so an entity id cannot be passed as an operation id', () => {
    const entityId = toEntityId(SYNTHETIC_UUID);

    // @ts-expect-error — EntityId is not assignable to OperationId. "Never
    // the entity id" (§1): reusing one as the other makes every later edit
    // of that row look like a replay and silently discards it (ADR-0001).
    const asOperationId: ReturnType<typeof toOperationId> = entityId;
    void asOperationId;

    // At runtime they are the same string; the separation is entirely in
    // the type, which is where the mistake is made.
    expect(entityId).toBe(SYNTHETIC_UUID);
  });
});
