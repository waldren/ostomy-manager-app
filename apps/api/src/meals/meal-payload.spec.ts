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

import { ObservationRejectedException } from '../observations/observation-rejection';

import { interpretMealPayload } from './meal-payload';
import { mealResourceSchema, type MealRequestParsed } from './meal-wire';

const ENTITY_ID = '7a1e2b3c-4d5f-4a6b-8c9d-0e1f2a3b4c5d';

function payload(overrides: Record<string, unknown> = {}): MealRequestParsed {
  return {
    id: ENTITY_ID,
    description: 'Porridge and a banana',
    size: 'medium',
    tagCodes: ['high_fibre'],
    effectiveDateTime: '2026-09-17T08:15:00.000Z',
    enteredTimezone: 'America/Chicago',
    ...overrides,
  } as MealRequestParsed;
}

function rejectionOf(run: () => unknown): { field: string; reasonCode: string }[] {
  try {
    run();
  } catch (error) {
    if (error instanceof ObservationRejectedException) {
      return (error.getResponse() as { error: { errors: { field: string; reasonCode: string }[] } })
        .error.errors;
    }
    throw error;
  }
  throw new Error('expected a rejection, but the payload was accepted');
}

describe('interpretMealPayload — §7.4 acceptance', () => {
  it('accepts the payload the contract spells out', () => {
    const input = interpretMealPayload(payload());

    expect(input.id).toBe(ENTITY_ID);
    expect(input.description).toBe('Porridge and a banana');
    expect(input.size).toBe('medium');
    expect(input.tagCodes).toEqual(['high_fibre']);
    expect(input.effectiveDateTime.toISOString()).toBe('2026-09-17T08:15:00.000Z');
  });

  /**
   * ADR-0016: derived from the instant and the zone, never taken from the
   * client — a transmitted one would be a second source of truth whose
   * disagreement nothing detects.
   */
  it('derives localDate server-side in the entry zone', () => {
    // 02:30 UTC on the 18th is still the 17th in Chicago.
    const input = interpretMealPayload(
      payload({
        effectiveDateTime: '2026-09-18T02:30:00.000Z',
        enteredTimezone: 'America/Chicago',
      }),
    );

    expect(input.localDate).toBe('2026-09-17');
  });

  describe('description (AC 2.4 AC1)', () => {
    it('is optional — a patient who only tapped tags has still logged a meal', () => {
      expect(interpretMealPayload(payload({ description: null })).description).toBeNull();
      expect(interpretMealPayload(payload({ description: undefined })).description).toBeNull();
    });

    it('normalises an empty string to null, so there is one representation of "none"', () => {
      expect(interpretMealPayload(payload({ description: '' })).description).toBeNull();
    });

    /**
     * Refused, not truncated. Silently cutting a patient's own words is a
     * data-loss path with no signal on either side, and they are the one
     * person who could have shortened it.
     */
    it('refuses a description longer than the column holds rather than truncating it', () => {
      expect(
        rejectionOf(() => interpretMealPayload(payload({ description: 'x'.repeat(2001) }))),
      ).toEqual([{ field: 'description', reasonCode: SYNC_REASON_CODE.PAYLOAD_FIELD_INVALID }]);
    });

    it('refuses a non-string, naming the field', () => {
      expect(rejectionOf(() => interpretMealPayload(payload({ description: 42 })))).toEqual([
        { field: 'description', reasonCode: SYNC_REASON_CODE.PAYLOAD_FIELD_INVALID },
      ]);
    });
  });

  describe('size (AC 2.4 AC2)', () => {
    it.each(['small', 'medium', 'large'])('accepts %s', (size) => {
      expect(interpretMealPayload(payload({ size })).size).toBe(size);
    });

    /**
     * `size` is the only stored representation of the choice, so defaulting an
     * absent one would be indistinguishable afterwards from a deliberate
     * answer — the same argument the Measured/Estimated toggle makes.
     */
    it('refuses an absent size rather than defaulting one', () => {
      expect(rejectionOf(() => interpretMealPayload(payload({ size: undefined })))).toEqual([
        { field: 'size', reasonCode: SYNC_REASON_CODE.PAYLOAD_FIELD_INVALID },
      ]);
    });

    it('refuses a size outside the scale, including a plausible one', () => {
      expect(rejectionOf(() => interpretMealPayload(payload({ size: 'extra_large' })))).toEqual([
        { field: 'size', reasonCode: SYNC_REASON_CODE.PAYLOAD_FIELD_INVALID },
      ]);
    });
  });

  describe('tagCodes (AC 2.4 AC1)', () => {
    it('normalises an absent array to empty, because omitting it means no tags', () => {
      expect(interpretMealPayload(payload({ tagCodes: undefined })).tagCodes).toEqual([]);
    });

    /**
     * A tag list is a set in meaning. `['dairy', 'dairy']` would otherwise
     * make a containment query count one meal twice.
     */
    it('collapses duplicates', () => {
      expect(
        interpretMealPayload(payload({ tagCodes: ['dairy', 'dairy', 'spicy'] })).tagCodes,
      ).toEqual(['dairy', 'spicy']);
    });

    /**
     * Members are admin-managed and retired-never-deleted, so validating
     * against the live set would refuse a patient's meal the moment an admin
     * retired a tag a fielded app still offers. An unknown tag renders as a
     * generic label and is recoverable; a refused meal is not.
     */
    it('accepts a tag this release has never heard of rather than refusing the meal', () => {
      expect(
        interpretMealPayload(payload({ tagCodes: ['some_tag_an_admin_added'] })).tagCodes,
      ).toEqual(['some_tag_an_admin_added']);
    });

    it('refuses a non-array, a non-string member, and an unbounded list', () => {
      for (const bad of [
        { a: 1 },
        ['ok', 42],
        Array.from({ length: 21 }, (_, i) => `t${String(i)}`),
      ]) {
        expect(rejectionOf(() => interpretMealPayload(payload({ tagCodes: bad })))).toEqual([
          { field: 'tagCodes', reasonCode: SYNC_REASON_CODE.PAYLOAD_FIELD_INVALID },
        ]);
      }
    });
  });

  it('refuses an unresolvable timezone, naming the field (ADR-0016)', () => {
    expect(
      rejectionOf(() => interpretMealPayload(payload({ enteredTimezone: 'Mars/Olympus' }))),
    ).toEqual([{ field: 'enteredTimezone', reasonCode: SYNC_REASON_CODE.PAYLOAD_FIELD_INVALID }]);
  });
});

describe('§7.4 — the published Meal schema', () => {
  /**
   * The one assertion this file exists for beyond validation. A meal is
   * app-native; `resourceType` is FHIR's key, and carrying it would assert a
   * conformance to `NutritionIntake` this entity does not have.
   */
  it('publishes exactly the six fields the contract names, and no resourceType', () => {
    expect(Object.keys(mealResourceSchema.shape).sort()).toEqual([
      'description',
      'effectiveDateTime',
      'enteredTimezone',
      'id',
      'size',
      'tagCodes',
    ]);
  });

  it('refuses a patientId, which §2 forbids from appearing on this wire at all', () => {
    const result = mealResourceSchema.safeParse({
      ...payload(),
      patientId: '00000000-0000-4000-8000-000000000000',
    });

    expect(result.success).toBe(false);
  });
});
