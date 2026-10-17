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

import type { CachedRange, OverlayRangeWrite } from '../db/repositories/rangesRepository';

import { buildTargetRangeViews } from './targetRangeView';

const OWN_ID = '11111111-1111-4111-8111-111111111111';
const PROPOSAL_ID = '22222222-2222-4222-8222-222222222222';
const NEW_ID = '33333333-3333-4333-8333-333333333333';

function cached(overrides: Partial<CachedRange> = {}): CachedRange {
  return {
    rangeType: 'daily_output_ml',
    unit: 'mL',
    lowValue: 600,
    highValue: 1500,
    provenance: 'clinical_default',
    isActiveThreshold: false,
    divergesFromPhysician: false,
    basis: {
      ostomyType: 'ileostomy',
      daysPostOp: 10,
      minDaysPostOp: 0,
      maxDaysPostOp: 30,
      lowValue: 600,
      highValue: 1500,
    },
    patientRange: null,
    proposal: null,
    limits: { minValue: 0.0001, maxValue: 99999999.9999 },
    ...overrides,
  };
}

let nextOperation = 0;

function write(overrides: Partial<OverlayRangeWrite>): OverlayRangeWrite {
  nextOperation += 1;
  return {
    operationId: `op-${String(nextOperation)}`,
    pending: true,
    id: NEW_ID,
    rangeType: 'daily_output_ml',
    lowValue: '800',
    highValue: '1600',
    targetValue: null,
    unit: 'mL',
    provenance: 'patient_set',
    status: 'active',
    writtenAt: '2026-10-17T12:00:00.000Z',
    ...overrides,
  };
}

const OWN = {
  id: OWN_ID,
  lowValue: 700,
  highValue: 1400,
  targetValue: null,
  unit: 'mL',
  provenance: 'patient_set' as const,
};

/**
 * The cached server answer with the phone's own unsent changes over it
 * (P4.S3 slice 4). §9.5: a change shows the moment it is saved, not after sync.
 */
describe('buildTargetRangeViews', () => {
  it('shows an unconfirmed default as a suggestion', () => {
    const [view] = buildTargetRangeViews([cached()], []);

    expect(view?.source).toBe('suggestion');
    expect(view?.shown).toEqual({ lowValue: 600, highValue: 1500 });
    expect(view?.waitingToSend).toBe(false);
  });

  it("shows the patient's cached value as theirs, with the suggestion still offered", () => {
    const [view] = buildTargetRangeViews(
      [cached({ provenance: 'patient_set', lowValue: 700, highValue: 1400, patientRange: OWN })],
      [],
    );

    expect(view?.source).toBe('patient');
    expect(view?.shown).toEqual({ lowValue: 700, highValue: 1400 });
    expect(view?.suggestion).toEqual({ lowValue: 600, highValue: 1500 });
  });

  it('shows a new value the moment it is saved, before it is sent', () => {
    const [view] = buildTargetRangeViews([cached()], [write({})]);

    expect(view?.source).toBe('patient');
    expect(view?.shown).toEqual({ lowValue: 800, highValue: 1600 });
    expect(view?.patientRange?.id).toBe(NEW_ID);
    expect(view?.waitingToSend).toBe(true);
  });

  it('labels an accepted suggestion as one', () => {
    const [view] = buildTargetRangeViews(
      [cached()],
      [write({ provenance: 'patient_confirmed_suggestion', lowValue: '600', highValue: '1500' })],
    );

    expect(view?.source).toBe('confirmed');
  });

  it('replaces the earlier patient value, as the server will', () => {
    const [view] = buildTargetRangeViews(
      [cached({ provenance: 'patient_set', patientRange: OWN })],
      [write({})],
    );

    expect(view?.patientRange?.id).toBe(NEW_ID);
  });

  it('falls back to the suggestion when the patient withdraws their value', () => {
    const [view] = buildTargetRangeViews(
      [cached({ provenance: 'patient_set', lowValue: 700, highValue: 1400, patientRange: OWN })],
      [write({ id: OWN_ID, status: 'superseded', lowValue: '700', highValue: '1400' })],
    );

    expect(view?.patientRange).toBeNull();
    expect(view?.source).toBe('suggestion');
    expect(view?.shown).toEqual({ lowValue: 600, highValue: 1500 });
  });

  /** A withdrawal affects only the row it names (§7.6). */
  it('ignores a withdrawal of a row that is not the value in force', () => {
    const [view] = buildTargetRangeViews(
      [cached({ provenance: 'patient_set', patientRange: OWN })],
      [write({ id: NEW_ID, status: 'superseded' })],
    );

    expect(view?.patientRange?.id).toBe(OWN_ID);
  });

  /** AC 4: a physician's value outranks the patient's, which is still recorded and shown as theirs. */
  it("keeps a physician's value in force over a new patient value, and says they diverge", () => {
    const [view] = buildTargetRangeViews(
      [
        cached({
          provenance: 'physician_set',
          lowValue: 450,
          highValue: 950,
          isActiveThreshold: true,
        }),
      ],
      [write({})],
    );

    expect(view?.source).toBe('physician');
    expect(view?.shown).toEqual({ lowValue: 450, highValue: 950 });
    expect(view?.divergesFromPhysician).toBe(true);
    expect(view?.patientRange?.lowValue).toBe(800);
  });

  it('removes a proposal once accepted, and makes it the patient value', () => {
    const proposal = {
      ...OWN,
      id: PROPOSAL_ID,
      provenance: 'patient_confirmed_suggestion' as const,
    };
    const [view] = buildTargetRangeViews(
      [cached({ proposal })],
      [
        write({
          id: PROPOSAL_ID,
          provenance: 'patient_confirmed_suggestion',
          lowValue: '700',
          highValue: '1400',
        }),
      ],
    );

    expect(view?.proposal).toBeNull();
    expect(view?.patientRange?.id).toBe(PROPOSAL_ID);
    expect(view?.source).toBe('confirmed');
  });

  it('removes a proposal once declined, leaving everything else as it was', () => {
    const proposal = {
      ...OWN,
      id: PROPOSAL_ID,
      provenance: 'patient_confirmed_suggestion' as const,
    };
    const [view] = buildTargetRangeViews(
      [cached({ proposal })],
      [write({ id: PROPOSAL_ID, status: 'dismissed' })],
    );

    expect(view?.proposal).toBeNull();
    expect(view?.patientRange).toBeNull();
    expect(view?.source).toBe('suggestion');
  });

  /**
   * #147: the first version deleted an unsent replacement instead, which left
   * the value it had replaced in force. Laid over in order, the replacement
   * supersedes the old value and the withdrawal removes the replacement — the
   * same outcome the server reaches from the same two operations.
   */
  it('falls back past the replaced value when an unsent replacement is withdrawn', () => {
    const [view] = buildTargetRangeViews(
      [cached({ provenance: 'patient_set', lowValue: 700, highValue: 1400, patientRange: OWN })],
      [write({}), write({ status: 'superseded' })],
    );

    expect(view?.patientRange).toBeNull();
    expect(view?.source).toBe('suggestion');
  });

  /** "It will be sent when your phone is connected" is false of a change already sent. */
  it('does not say a change is waiting to send once it has been sent', () => {
    const [view] = buildTargetRangeViews([cached()], [write({ pending: false })]);

    expect(view?.source).toBe('patient');
    expect(view?.waitingToSend).toBe(false);
  });

  it('applies changes to their own range type only', () => {
    const views = buildTargetRangeViews(
      [
        cached(),
        cached({ rangeType: 'urine_output_adequacy_ml', lowValue: 1000, highValue: null }),
      ],
      [write({})],
    );

    expect(views[1]?.source).toBe('suggestion');
    expect(views[1]?.waitingToSend).toBe(false);
  });

  /** A server from before P4.S3 sends no basis bounds; the default in force still is the suggestion. */
  it('reads the suggestion from the top level when the basis has no bounds', () => {
    const basis = {
      ostomyType: 'ileostomy' as const,
      daysPostOp: 10,
      minDaysPostOp: 0,
      maxDaysPostOp: 30,
      lowValue: null,
      highValue: null,
    };
    const [view] = buildTargetRangeViews([cached({ basis })], []);

    expect(view?.suggestion).toEqual({ lowValue: 600, highValue: 1500 });
  });

  it('shows nothing it cannot know: a withdrawn value with no suggestion to fall back to', () => {
    const [view] = buildTargetRangeViews(
      [cached({ provenance: 'patient_set', patientRange: OWN, basis: null })],
      [write({ id: OWN_ID, status: 'superseded' })],
    );

    expect(view?.shown).toBeNull();
  });
});
