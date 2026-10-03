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

import { ESTIMATION_METHOD_CODE, MEASURED_METHOD_CODE } from '@ostomy/core/validation';

import {
  FLUID_INTAKE_LOINC_CODE,
  STOMA_OUTPUT_LOINC_CODE,
  VOIDED_URINE_LOINC_CODE,
} from '../entry/observationCodes';

import {
  MAX_SUGGESTIONS,
  MINIMUM_OCCURRENCES,
  QUICK_ADD_CODES,
  RECENT_WINDOW_DAYS,
  rankQuickAddSuggestions,
  recentWindowStart,
  toSuggestion,
  type QuickAddCandidate,
} from './quickAddSuggestions';

/**
 * No SRS §7 acceptance criterion covers Quick-Add: Epic 3 has user stories and
 * §3.1/§5.1 have requirements, but the spec has no numbered AC section for it
 * (the plan's P3.S4 row says so in terms — "No spec AC"). Per docs/testing.md
 * these are described plainly rather than attached to an invented AC id, and
 * cite the requirement they come from.
 */

const MEASURED = MEASURED_METHOD_CODE.resolved ? MEASURED_METHOD_CODE.code : '';
const ESTIMATED = ESTIMATION_METHOD_CODE.resolved ? ESTIMATION_METHOD_CODE.code : '';

function candidate(overrides: Partial<QuickAddCandidate> = {}): QuickAddCandidate {
  return {
    code: FLUID_INTAKE_LOINC_CODE,
    valueQuantityValue: '250.0000',
    method: MEASURED,
    fluidTypeCode: null,
    urineColorCode: null,
    enteredMeasurementSystem: 'metric',
    occurrences: 3,
    lastEnteredAt: '2026-10-01T08:00:00.000Z',
    ...overrides,
  };
}

describe('the codes a widget may be generated for', () => {
  it('covers the three volumetric entry screens and nothing else', () => {
    // Weight and heart rate are excluded by construction: `method` is `null`
    // for them (ADR-0018) and neither is a routine a patient repeats verbatim.
    expect([...QUICK_ADD_CODES].sort()).toEqual(
      [FLUID_INTAKE_LOINC_CODE, STOMA_OUTPUT_LOINC_CODE, VOIDED_URINE_LOINC_CODE].sort(),
    );
  });
});

describe('what becomes a tappable suggestion', () => {
  it('carries the stored value through verbatim, not rounded or re-derived', () => {
    // The central safety property. A widget's number must be one the patient
    // actually entered, because a tap commits it with no form in between.
    const suggestion = toSuggestion(candidate({ valueQuantityValue: '347.5000' }));

    expect(suggestion).toMatchObject({ kind: 'volumetric', canonicalValue: '347.5000' });
  });

  it('carries the Measured answer, never a default', () => {
    expect(toSuggestion(candidate({ method: MEASURED }))).toMatchObject({ method: 'measured' });
  });

  it('carries the Estimated answer just as faithfully', () => {
    // The direction that would be easy to get wrong by defaulting: a patient
    // who estimates must not have a measurement asserted for them.
    expect(toSuggestion(candidate({ method: ESTIMATED }))).toMatchObject({ method: 'estimated' });
  });

  it('drops an entry whose stored qualifier is neither code this app writes', () => {
    // ADR-0018: "written rows keep the old code and nothing detects the
    // disagreement" — so a third value is a row this client cannot interpret.
    // Re-asserting a qualifier we cannot name would be worse than no widget.
    expect(toSuggestion(candidate({ method: '129265001' }))).toBeUndefined();
  });

  it('drops a volumetric entry with no qualifier at all', () => {
    // SRS §3.1 makes the toggle mandatory on every volumetric entry. A row
    // with an amount and no method predates the ADR-0018 amendment or came
    // from somewhere this client does not control.
    //
    // This and the test above are one rule in the code, not two: a mutation
    // sweep showed a separate `method === null` guard was behaviourally
    // redundant with the unrecognised-code rejection, so `toToggle` now owns
    // both. Kept as two tests because the two inputs mean different things
    // (ADR-0018 fixes `null` at rest as "no toggle"), and a future change that
    // treated them differently should have to break one of them.
    expect(toSuggestion(candidate({ method: null }))).toBeUndefined();
  });

  it('keeps the fluid type, because the type is part of the routine', () => {
    // A 250 mL coffee and a 250 mL glass of water are different entries, and a
    // tap must not log a categorisation the patient did not choose.
    expect(toSuggestion(candidate({ fluidTypeCode: 'coffee_or_tea' }))).toMatchObject({
      fluidTypeCode: 'coffee_or_tea',
    });
  });

  it('gives a different widget to each fluid type at the same volume', () => {
    const water = toSuggestion(candidate({ fluidTypeCode: 'water' }));
    const coffee = toSuggestion(candidate({ fluidTypeCode: 'coffee_or_tea' }));

    expect(water?.key).not.toBe(coffee?.key);
  });

  it('gives a different widget to each measurement system at the same volume', () => {
    // Provenance of the suggestion: the entry system decides whether rendering
    // it in the patient's current units applies ADR-0005's cross-system
    // rounding, so two groups with the same canonical value are not the same
    // widget.
    const metric = toSuggestion(candidate({ enteredMeasurementSystem: 'metric' }));
    const imperial = toSuggestion(candidate({ enteredMeasurementSystem: 'imperial' }));

    expect(metric?.key).not.toBe(imperial?.key);
  });
});

describe('the colour-only urine entry (AC 12.1 AC2, §3.7)', () => {
  function colorOnly(overrides: Partial<QuickAddCandidate> = {}): QuickAddCandidate {
    return candidate({
      code: VOIDED_URINE_LOINC_CODE,
      valueQuantityValue: null,
      method: null,
      urineColorCode: 'dark_yellow',
      ...overrides,
    });
  }

  it('is a suggestion in its own right — §3.7 says urine participates', () => {
    // The patient who cannot measure. Their routine is a colour, and it is a
    // valid hydration observation, so it must be offered as one tap too.
    expect(toSuggestion(colorOnly())).toEqual({
      kind: 'volumeless-urine',
      key: expect.any(String),
      code: VOIDED_URINE_LOINC_CODE,
      urineColorCode: 'dark_yellow',
      enteredMeasurementSystem: 'metric',
      occurrences: 3,
      lastEnteredAt: '2026-10-01T08:00:00.000Z',
    });
  });

  it('has no method, and is dropped if a row somehow carries one', () => {
    // ADR-0018 fixes `null` at rest to mean "this observation has no toggle",
    // so an amount-less entry with a qualifier is a contradiction. The local
    // schema has a CHECK refusing it; this is the mirror, because a widget
    // would otherwise re-assert the contradiction through a path the CHECK
    // only catches at write time.
    expect(toSuggestion(colorOnly({ method: MEASURED }))).toBeUndefined();
  });

  it('is dropped when there is neither an amount nor a colour', () => {
    // An observation recording nothing. Unwritable locally, and a widget that
    // logged one would be a silent data defect rather than a crash.
    expect(toSuggestion(colorOnly({ urineColorCode: null }))).toBeUndefined();
  });

  it('is dropped when a code other than urine somehow has a colour and no amount', () => {
    expect(toSuggestion(colorOnly({ code: STOMA_OUTPUT_LOINC_CODE }))).toBeUndefined();
  });
});

describe('which suggestions reach the dashboard', () => {
  it('refuses a one-off, so a single mistyped entry never becomes one tap', () => {
    // The rule that matters most here. A patient who fat-fingers 2,000 mL for
    // 200 would otherwise be offered it on the dashboard for a fortnight.
    expect(rankQuickAddSuggestions([candidate({ occurrences: 1 })])).toEqual([]);
  });

  it('accepts an entry made exactly twice', () => {
    expect(rankQuickAddSuggestions([candidate({ occurrences: MINIMUM_OCCURRENCES })])).toHaveLength(
      1,
    );
  });

  it('orders by how often the entry was made', () => {
    const ranked = rankQuickAddSuggestions([
      candidate({ valueQuantityValue: '100.0000', occurrences: 2 }),
      candidate({ valueQuantityValue: '300.0000', occurrences: 9 }),
      candidate({ valueQuantityValue: '200.0000', occurrences: 5 }),
    ]);

    expect(ranked.map((s) => (s.kind === 'volumetric' ? s.canonicalValue : null))).toEqual([
      '300.0000',
      '200.0000',
      '100.0000',
    ]);
  });

  it('breaks a tie on recency, so the dashboard does not reorder for no reason', () => {
    const ranked = rankQuickAddSuggestions([
      candidate({
        valueQuantityValue: '100.0000',
        occurrences: 4,
        lastEnteredAt: '2026-09-20T08:00:00.000Z',
      }),
      candidate({
        valueQuantityValue: '200.0000',
        occurrences: 4,
        lastEnteredAt: '2026-10-01T08:00:00.000Z',
      }),
    ]);

    expect(ranked.map((s) => (s.kind === 'volumetric' ? s.canonicalValue : null))).toEqual([
      '200.0000',
      '100.0000',
    ]);
  });

  it('shows at most three', () => {
    const many = [9, 8, 7, 6, 5].map((occurrences, index) =>
      candidate({ valueQuantityValue: `${String(index + 1)}00.0000`, occurrences }),
    );

    expect(rankQuickAddSuggestions(many)).toHaveLength(MAX_SUGGESTIONS);
  });

  it('drops an uninterpretable candidate without consuming one of the three slots', () => {
    // `flatMap` rather than `map` then filter: a dropped candidate must not
    // leave a hole, or an unreadable qualifier would silently cost the patient
    // a widget they could have had.
    const ranked = rankQuickAddSuggestions([
      candidate({ valueQuantityValue: '100.0000', occurrences: 9, method: 'not-a-code' }),
      candidate({ valueQuantityValue: '200.0000', occurrences: 8 }),
      candidate({ valueQuantityValue: '300.0000', occurrences: 7 }),
      candidate({ valueQuantityValue: '400.0000', occurrences: 6 }),
    ]);

    expect(ranked).toHaveLength(3);
    expect(ranked.map((s) => (s.kind === 'volumetric' ? s.canonicalValue : null))).toEqual([
      '200.0000',
      '300.0000',
      '400.0000',
    ]);
  });
});

describe('the recent window', () => {
  it('reaches back exactly the configured number of days', () => {
    const now = new Date('2026-10-03T09:30:00.000Z');

    expect(recentWindowStart(now).toISOString()).toBe('2026-09-19T09:30:00.000Z');
  });

  it('is two weeks, which is what the dashboard copy tells the patient', () => {
    // The copy says "the last two weeks". A change here without a change there
    // makes the screen lie about its own rule.
    expect(RECENT_WINDOW_DAYS).toBe(14);
  });

  it('is computed from the passed clock, never from the ambient one', () => {
    // ADR-0019: a device whose clock has just been corrected must not get a
    // different window from the one its entries were written against.
    const a = recentWindowStart(new Date('2026-01-01T00:00:00.000Z'));
    const b = recentWindowStart(new Date('2026-06-01T00:00:00.000Z'));

    expect(a.toISOString()).not.toBe(b.toISOString());
  });
});
