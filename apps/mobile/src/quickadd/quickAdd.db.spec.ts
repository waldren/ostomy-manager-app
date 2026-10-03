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

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MEASURED_METHOD_CODE } from '@ostomy/core/validation';

import type { SqliteExecutor } from '../db/executor';
import { runMigrations } from '../db/migrations';
import {
  enqueueObservationDelete,
  enqueueVolumelessUrineCreate,
  enqueueVolumetricObservationCreate,
} from '../db/offlineWrites';
import { listQuickAddCandidates } from '../db/repositories/quickAddRepository';
import { getObservationById } from '../db/repositories/observationsRepository';
import { listQueuedOperations } from '../db/repositories/syncQueueRepository';
import {
  FLUID_INTAKE_LOINC_CODE,
  STOMA_OUTPUT_LOINC_CODE,
  VOIDED_URINE_LOINC_CODE,
} from '../entry/observationCodes';
import { createNodeSqliteExecutor } from '../test-support/nodeSqliteExecutor';

import { logQuickAdd } from './logQuickAdd';
import {
  QUICK_ADD_CODES,
  rankQuickAddSuggestions,
  recentWindowStart,
  type QuickAddSuggestion,
} from './quickAddSuggestions';

/**
 * Quick-Add against the real local store (P3.S4).
 *
 * The suggestion rules are unit-tested in `quickAddSuggestions.spec.ts`; what
 * is here is the half that only a database answers — the `GROUP BY`, the
 * window, and that a tap's write lands as a real row and a real queue entry.
 *
 * No numbered AC covers Quick-Add (see `quickAddSuggestions.spec.ts`).
 */

const NOW = new Date('2026-10-03T09:00:00.000Z');
const nowFn = () => NOW;

describe('Quick-Add over the local store', () => {
  let dir: string;
  let executor: SqliteExecutor;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ostomy-mobile-quick-add-'));
    executor = createNodeSqliteExecutor(join(dir, 'test.db'));
    await runMigrations(executor, nowFn);
  });

  afterEach(async () => {
    await executor.closeAsync();
    rmSync(dir, { recursive: true, force: true });
  });

  async function addIntake(
    value: string,
    options: { daysAgo?: number; fluidTypeCode?: string | null } = {},
  ): Promise<string> {
    const at = new Date(NOW.getTime() - (options.daysAgo ?? 1) * 24 * 60 * 60 * 1000);
    const written = await enqueueVolumetricObservationCreate(
      executor,
      {
        code: FLUID_INTAKE_LOINC_CODE,
        valueQuantityValue: value,
        valueQuantityUnit: 'mL',
        effectiveDatetime: at.toISOString(),
        measuredOrEstimated: 'measured',
        enteredMeasurementSystem: 'metric',
        fluidTypeCode: options.fluidTypeCode ?? null,
      },
      nowFn,
    );
    return written.id;
  }

  async function candidates() {
    return listQuickAddCandidates(executor, {
      codes: QUICK_ADD_CODES,
      since: recentWindowStart(NOW).toISOString(),
    });
  }

  describe('the grouping', () => {
    it('counts identical entries as one candidate', async () => {
      await addIntake('250.0000');
      await addIntake('250.0000');
      await addIntake('250.0000');

      const rows = await candidates();

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ valueQuantityValue: '250.0000', occurrences: 3 });
    });

    it('keeps near-miss values apart rather than bucketing them', async () => {
      // The safety property stated in `quickAddSuggestions.ts`, proven at the
      // SQL layer: 345 and 350 must not collapse, or a tap would log a number
      // the patient never entered.
      await addIntake('345.0000');
      await addIntake('350.0000');

      const rows = await candidates();

      expect(rows.map((row) => row.valueQuantityValue).sort()).toEqual(['345.0000', '350.0000']);
    });

    it('keeps the same volume apart by fluid type', async () => {
      await addIntake('250.0000', { fluidTypeCode: 'water' });
      await addIntake('250.0000', { fluidTypeCode: 'coffee_or_tea' });

      expect(await candidates()).toHaveLength(2);
    });

    it('reports the most recent occurrence in the group, for the tiebreak', async () => {
      await addIntake('250.0000', { daysAgo: 9 });
      await addIntake('250.0000', { daysAgo: 2 });

      const rows = await candidates();

      expect(rows[0]!.lastEnteredAt).toBe(
        new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      );
    });
  });

  describe('what the window and the filters exclude', () => {
    it('ignores entries older than the window', async () => {
      await addIntake('250.0000', { daysAgo: 20 });
      await addIntake('250.0000', { daysAgo: 20 });

      expect(await candidates()).toEqual([]);
    });

    it('counts only the occurrences inside the window', async () => {
      // The boundary case worth having: a routine the patient has stopped
      // must not keep its old count and stay on the dashboard.
      await addIntake('250.0000', { daysAgo: 20 });
      await addIntake('250.0000', { daysAgo: 20 });
      await addIntake('250.0000', { daysAgo: 1 });

      expect((await candidates())[0]).toMatchObject({ occurrences: 1 });
    });

    it('ignores an entry the patient deleted', async () => {
      // A deleted entry is not part of a routine, and offering it back as one
      // tap would be the app arguing with them.
      const first = await addIntake('250.0000');
      await addIntake('250.0000');
      await enqueueObservationDelete(executor, first, nowFn);

      expect((await candidates())[0]).toMatchObject({ occurrences: 1 });
    });

    it('ignores a code Quick-Add does not generate over', async () => {
      await enqueueVolumetricObservationCreate(
        executor,
        {
          code: '29463-7',
          valueQuantityValue: '70.0000',
          valueQuantityUnit: 'kg',
          effectiveDatetime: NOW.toISOString(),
          measuredOrEstimated: 'measured',
          enteredMeasurementSystem: 'metric',
        },
        nowFn,
      );

      expect(await candidates()).toEqual([]);
    });

    it('still counts an entry that has not been sent yet', async () => {
      // §5.1 rules out making this feature depend on connectivity, and the
      // local store is the source of truth for what the patient has entered.
      // Every row written above is unsent, so this asserts the property
      // directly rather than relying on that.
      await addIntake('250.0000');
      await addIntake('250.0000');

      const queued = await listQueuedOperations(executor, 10);

      expect(queued.length).toBeGreaterThan(0);
      expect((await candidates())[0]).toMatchObject({ occurrences: 2 });
    });
  });

  describe('a colour-only urine routine (AC 12.1 AC2)', () => {
    it('groups and is offered, with no amount and no method', async () => {
      for (let i = 0; i < 2; i += 1) {
        await enqueueVolumelessUrineCreate(
          executor,
          {
            code: VOIDED_URINE_LOINC_CODE,
            effectiveDatetime: new Date(NOW.getTime() - (i + 1) * 3_600_000).toISOString(),
            enteredMeasurementSystem: 'metric',
            urineColorCode: 'dark_yellow',
          },
          nowFn,
        );
      }

      const suggestions = rankQuickAddSuggestions(await candidates());

      expect(suggestions).toHaveLength(1);
      expect(suggestions[0]).toMatchObject({
        kind: 'volumeless-urine',
        urineColorCode: 'dark_yellow',
        occurrences: 2,
      });
    });
  });

  describe('what a tap writes', () => {
    it('writes the stored value and the stored toggle, with the time set to now', async () => {
      await addIntake('250.0000', { fluidTypeCode: 'coffee_or_tea', daysAgo: 3 });
      await addIntake('250.0000', { fluidTypeCode: 'coffee_or_tea', daysAgo: 1 });
      const suggestion = rankQuickAddSuggestions(await candidates())[0]!;

      const written = await logQuickAdd(executor, suggestion, 'metric', nowFn);

      const row = await getObservationById(executor, written.id);
      expect(row).toMatchObject({
        code: FLUID_INTAKE_LOINC_CODE,
        valueQuantityValue: '250.0000',
        valueQuantityUnit: 'mL',
        fluidTypeCode: 'coffee_or_tea',
        enteredMeasurementSystem: 'metric',
      });
      // The one field a repeat cannot inherit.
      expect(row!.effectiveDatetime).toBe(NOW.toISOString());
      // The qualifier, not the toggle word — this is what reaches the wire,
      // and ADR-0018 makes `method: null` mean something else entirely.
      expect(row!.method).toBe(MEASURED_METHOD_CODE.resolved ? MEASURED_METHOD_CODE.code : null);
    });

    it('queues the write in the same transaction, like every other entry', async () => {
      // `offlineWrites.ts` is "the seam this module exists to be" — a tap that
      // wrote the row without the queue append would be an entry the sync
      // worker never sends, visible on the phone and absent on the server.
      await addIntake('250.0000');
      await addIntake('250.0000');
      const suggestion = rankQuickAddSuggestions(await candidates())[0]!;
      const before = (await listQueuedOperations(executor, 50)).length;

      const written = await logQuickAdd(executor, suggestion, 'metric', nowFn);

      const queued = await listQueuedOperations(executor, 50);
      expect(queued).toHaveLength(before + 1);
      expect(queued.some((operation) => operation.entityId === written.id)).toBe(true);
    });

    it('writes a colour-only urine entry with no amount and no qualifier', async () => {
      const suggestion: QuickAddSuggestion = {
        kind: 'volumeless-urine',
        key: 'c',
        code: VOIDED_URINE_LOINC_CODE,
        urineColorCode: 'straw',
        enteredMeasurementSystem: 'metric',
        occurrences: 2,
        lastEnteredAt: NOW.toISOString(),
      };

      const written = await logQuickAdd(executor, suggestion, 'metric', nowFn);

      const row = await getObservationById(executor, written.id);
      // A missing amount is never zero (CLAUDE.md), and `method` stays null
      // because there is nothing for the toggle to describe.
      expect(row).toMatchObject({
        valueQuantityValue: null,
        valueQuantityUnit: null,
        method: null,
        urineColorCode: 'straw',
      });
    });

    it('records the system the patient is using now, not the entry it came from', async () => {
      // ADR-0012: the field is the client's asserted entry system, and a tap
      // asserts the system the label it rendered was in. Carrying the
      // suggestion's own system onto the new row would record a patient who
      // switched as still entering in the old one — wrong "precisely for the
      // patients who switched".
      await addIntake('250.0000');
      await addIntake('250.0000');
      const suggestion = rankQuickAddSuggestions(await candidates())[0]!;
      expect(suggestion.enteredMeasurementSystem).toBe('metric');

      const written = await logQuickAdd(executor, suggestion, 'imperial', nowFn);

      const row = await getObservationById(executor, written.id);
      expect(row!.enteredMeasurementSystem).toBe('imperial');
      // And the canonical value is untouched: display rounding must never
      // travel inward (ADR-0005).
      expect(row!.valueQuantityValue).toBe('250.0000');
    });

    it('makes the new entry count towards the suggestion it came from', async () => {
      // The widget's "you logged this N times recently" line is the patient's
      // own data, so it has to move when they use the shortcut.
      await addIntake('250.0000');
      await addIntake('250.0000');
      const suggestion = rankQuickAddSuggestions(await candidates())[0]!;

      await logQuickAdd(executor, suggestion, 'metric', nowFn);

      expect(rankQuickAddSuggestions(await candidates())[0]).toMatchObject({ occurrences: 3 });
    });
  });

  describe('a stoma-output routine, which is the code most worth a second look', () => {
    it('is offered, carrying the Measured answer the patient gave', async () => {
      // §3.1 does not restrict Quick-Add by code, and §3.7 names urine
      // explicitly, so output is in. It is the arm where "Measured" is the
      // strongest claim — a patient who repeatedly measures their pouch — so
      // the widget states the toggle on its face rather than only in a hint.
      for (let i = 0; i < 2; i += 1) {
        await enqueueVolumetricObservationCreate(
          executor,
          {
            code: STOMA_OUTPUT_LOINC_CODE,
            valueQuantityValue: '400.0000',
            valueQuantityUnit: 'mL',
            effectiveDatetime: new Date(NOW.getTime() - (i + 1) * 3_600_000).toISOString(),
            measuredOrEstimated: 'estimated',
            enteredMeasurementSystem: 'metric',
          },
          nowFn,
        );
      }

      const suggestions = rankQuickAddSuggestions(await candidates());

      expect(suggestions[0]).toMatchObject({
        kind: 'volumetric',
        code: STOMA_OUTPUT_LOINC_CODE,
        method: 'estimated',
      });
    });
  });
});
