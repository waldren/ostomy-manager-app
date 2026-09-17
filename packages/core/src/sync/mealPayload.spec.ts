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

import { MEAL_SIZE, SYNC_ENTITY_TYPE, type MealSyncPayload } from './payload.js';
import { toEntityId } from './identifiers.js';

/**
 * `docs/sync-contract.md` §7.4 — the `Meal` payload, pinned against the
 * document that governs it.
 *
 * The whole point of P3.S1 adding an entity type is that a client and the
 * server must agree on its shape before either writes one. These assertions
 * are the mechanism for that: the document is normative, and where it and
 * this type disagree the type is wrong.
 */

function meal(overrides: Partial<MealSyncPayload> = {}): MealSyncPayload {
  return {
    id: toEntityId('7a1e2b3c-4d5f-4a6b-8c9d-0e1f2a3b4c5d'),
    description: 'Porridge and a banana',
    size: 'medium',
    tagCodes: ['high_fibre'],
    effectiveDateTime: '2026-09-17T08:15:00.000Z',
    enteredTimezone: 'America/Chicago',
    ...overrides,
  };
}

describe('§7.4 — the Meal payload', () => {
  it('carries exactly the six fields the contract names, and nothing else', () => {
    expect(Object.keys(meal()).sort()).toEqual([
      'description',
      'effectiveDateTime',
      'enteredTimezone',
      'id',
      'size',
      'tagCodes',
    ]);
  });

  /**
   * The assertion this file exists for. `resourceType` is FHIR's key, and
   * FHIR's `NutritionIntake` models a prescribed or administered nutritional
   * product — not free text and a relative size. Carrying the key would
   * assert a conformance this entity does not have, and §7.1 forbids the
   * export module from copying an app-native sibling into a Bundle for the
   * same reason seen from the other end.
   */
  it('carries no resourceType — it is app-native, not FHIR', () => {
    expect(meal()).not.toHaveProperty('resourceType');
  });

  /**
   * §7.4, and §7.2's rule for `method` applied unchanged: an absent key
   * cannot be told apart from a client that does not implement the field.
   */
  it('spells "no description given" as an explicit null, not an absent key', () => {
    const withoutDescription = meal({ description: null });

    expect(withoutDescription.description).toBeNull();
    expect(Object.keys(withoutDescription)).toContain('description');
  });

  /**
   * An absent array and an empty one would mean the same thing to a reader
   * and different things to a writer.
   */
  it('spells "no tags chosen" as an empty array, not an absent key', () => {
    const untagged = meal({ tagCodes: [] });

    expect(untagged.tagCodes).toEqual([]);
    expect(Object.keys(untagged)).toContain('tagCodes');
  });

  it('is the three-step relative scale AC 2.4 AC2 names, lowercase on the wire', () => {
    expect([...MEAL_SIZE]).toEqual(['small', 'medium', 'large']);
    for (const size of MEAL_SIZE) {
      expect(size).toMatch(/^[a-z]+$/);
    }
  });

  /**
   * ADR-0016. `localDate` is a pure function of two fields already here, so a
   * transmitted one is a second source of truth whose disagreement nothing
   * detects — the same rule §7.2 states for an observation.
   */
  it('carries no localDate, no patientId, and no server bookkeeping', () => {
    const keys = Object.keys(meal());

    for (const forbidden of [
      'localDate',
      'patientId',
      'serverSequence',
      'deletedAt',
      'createdAt',
      'updatedAt',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('is reachable as an entity type spelled the way the wire spells it', () => {
    expect(SYNC_ENTITY_TYPE.MEAL).toBe('Meal');
  });

  /**
   * Tags are value-set member codes, and CLAUDE.md requires a retired member
   * to still resolve when rendering history. Nothing in the type may carry a
   * display label: that would be a second localization pipeline beside the
   * i18n catalog (ADR-0006), and it would freeze a label into stored history.
   */
  it('carries tag codes, never tag labels', () => {
    for (const code of meal({ tagCodes: ['high_fibre', 'dairy'] }).tagCodes) {
      expect(code).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});
