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

import { describe, expect, it, vi } from 'vitest';

import type { ActiveValueSetMember, ThresholdsService } from './thresholds.service';
import { valueSetsResponseSchema } from './value-sets-openapi';
import { ValueSetsController } from './value-sets.controller';

function controllerReturning(bySet: Record<string, readonly Partial<ActiveValueSetMember>[]>): {
  controller: ValueSetsController;
  calls: string[];
} {
  const calls: string[] = [];
  const service = {
    getActiveValueSetMembers: vi.fn((key: string) => {
      calls.push(key);
      return Promise.resolve(bySet[key] ?? []);
    }),
  } as unknown as ThresholdsService;

  return { controller: new ValueSetsController(service), calls };
}

const CATEGORY = { sortOrder: 0, numericValue: null, numericUnit: null };

describe('ValueSetsController', () => {
  it('publishes every shipped set in one response', async () => {
    const { controller, calls } = controllerReturning({});

    const response = await controller.get();

    // The three P3.S1 needs, plus `urine_color` for P3.S2's colour-only
    // voided-urine entry (AC 12.1 AC2). Asserted as an exact list rather than
    // a `toContain`, so adding a set is a deliberate edit here.
    expect(response.valueSets.map((set) => set.key)).toEqual([
      'fluid_type',
      'container_size',
      'meal_tag',
      'urine_color',
    ]);
    expect(calls.sort()).toEqual(['container_size', 'fluid_type', 'meal_tag', 'urine_color']);
  });

  it('carries a container size with its canonical quantity (AC 2.3 AC2)', async () => {
    const { controller } = controllerReturning({
      container_size: [{ code: 'glass_250', sortOrder: 10, numericValue: 250, numericUnit: 'mL' }],
    });

    const response = await controller.get();
    const containers = response.valueSets.find((set) => set.key === 'container_size');

    expect(containers?.members).toEqual([
      { code: 'glass_250', sortOrder: 10, numericValue: 250, numericUnit: 'mL' },
    ]);
  });

  it('carries a category with no quantity at all', async () => {
    const { controller } = controllerReturning({
      fluid_type: [{ code: 'water', ...CATEGORY }],
    });

    const response = await controller.get();
    const fluids = response.valueSets.find((set) => set.key === 'fluid_type');

    expect(fluids?.members[0]).toEqual({
      code: 'water',
      sortOrder: 0,
      numericValue: null,
      numericUnit: null,
    });
  });

  /**
   * `ActiveValueSetMember` is an internal type free to grow. A spread would
   * make every future addition to it public API the moment it was added —
   * silently, and unversioned. The schema is `.strict()`, so a leaked field
   * fails the parse below as well as the key comparison.
   */
  it('does not leak a field the service grows later', async () => {
    const { controller } = controllerReturning({
      fluid_type: [
        { code: 'water', ...CATEGORY, internalRowId: 'secret' } as Partial<ActiveValueSetMember>,
      ],
    });

    const response = await controller.get();

    expect(response.valueSets[0]?.members[0]).not.toHaveProperty('internalRowId');
    expect(() => valueSetsResponseSchema.parse(response)).not.toThrow();
  });

  /**
   * The published set is a fixed list rather than "every set in the table".
   * The table also holds sets whose features have not shipped, and publishing
   * one would let a client build a picker for an entry type the server rejects
   * on write.
   *
   * The unshipped key here is `appliance_type` (P5). It used to be
   * `urine_color_scale` — **a key no migration ever created**, so this test
   * asserted the exclusion of nothing and stayed green either way. When P3.S2
   * seeded the real set as `urine_color` and forgot to publish it, that was
   * the test that should have failed and could not.
   */
  it('publishes no set beyond the allowlist, even if the table holds more', async () => {
    const { controller, calls } = controllerReturning({
      appliance_type: [{ code: 'one_piece', ...CATEGORY }],
    });

    const response = await controller.get();

    expect(response.valueSets.map((set) => set.key)).not.toContain('appliance_type');
    expect(calls).not.toContain('appliance_type');
  });

  /**
   * The other direction, which is the one that was missing: a set the
   * migration seeded for a SHIPPED feature must actually be published.
   *
   * `urine_color` is the whole content of a colour-only voided-urine entry
   * (AC 12.1 AC2), and the codes come from this endpoint's cache — so
   * withholding it does not degrade the feature, it removes it.
   */
  it('publishes urine_color, which AC 12.1 needs on the device', async () => {
    const { controller, calls } = controllerReturning({
      urine_color: [{ code: 'amber', ...CATEGORY }],
    });

    const response = await controller.get();

    expect(response.valueSets.map((set) => set.key)).toContain('urine_color');
    expect(calls).toContain('urine_color');
  });

  /**
   * Nothing here is patient-scoped: the endpoint takes no actor and the
   * response is the same bytes for every patient. That is the property that
   * makes it correct for this route to carry no `@Audited()` (SRS §5.2).
   */
  it('takes no patient identifier and returns nothing derived from one', async () => {
    const { controller } = controllerReturning({});

    expect(controller.get.length).toBe(0);
  });
});
