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

import {
  FLUID_INTAKE_LOINC_CODE,
  STOMA_OUTPUT_LOINC_CODE,
  VOIDED_URINE_LOINC_CODE,
} from '../entry/observationCodes';

import { draftHrefFor, draftRouteFor, parseDraftParams } from './draftParams';
import type { QuickAddSuggestion } from './quickAddSuggestions';

/** No numbered AC for Quick-Add (see `quickAddSuggestions.spec.ts`). Epic 3: "open it as a draft … before saving". */

const VOLUMETRIC: QuickAddSuggestion = {
  kind: 'volumetric',
  key: 'k',
  code: FLUID_INTAKE_LOINC_CODE,
  canonicalValue: '250.0000',
  method: 'measured',
  fluidTypeCode: null,
  urineColorCode: null,
  enteredMeasurementSystem: 'metric',
  occurrences: 4,
  lastEnteredAt: '2026-10-02T08:00:00.000Z',
};

describe('where a draft opens', () => {
  it('sends each code to its own screen', () => {
    expect(draftRouteFor(STOMA_OUTPUT_LOINC_CODE)).toBe('/add-output');
    expect(draftRouteFor(FLUID_INTAKE_LOINC_CODE)).toBe('/add-intake');
    expect(draftRouteFor(VOIDED_URINE_LOINC_CODE)).toBe('/add-urine');
  });

  it('has no route for a code with no entry screen', () => {
    // Weight, say. `undefined` rather than a guess, so the caller does
    // nothing instead of navigating to a blank screen.
    expect(draftRouteFor('29463-7')).toBeUndefined();
  });
});

describe('what crosses to the entry screen', () => {
  it('carries the amount, the toggle and the fluid type', () => {
    const href = draftHrefFor({ ...VOLUMETRIC, fluidTypeCode: 'coffee_or_tea' }, 'metric');

    expect(href).toBe('/add-intake?amount=250&method=measured&fluidType=coffee_or_tea');
  });

  it('carries the amount as a DISPLAY value, in the system the patient is using', () => {
    // The field holds what the patient typed, in their own units, and
    // `toCanonicalValueString` converts on save. A canonical 250 pre-filled
    // into a field labelled oz would be saved as ~7,390 mL.
    const href = draftHrefFor(VOLUMETRIC, 'imperial');

    // 250 mL is 8.45 oz; ADR-0005 rounds a cross-system conversion to a whole
    // unit for display, and the prefilled field must show what will be saved.
    expect(href).toBe('/add-intake?amount=8&method=measured');
  });

  it('does not round when no system change is involved', () => {
    // The other half of ADR-0005's rule: an entry shown in its own system
    // keeps its entered precision.
    const href = draftHrefFor({ ...VOLUMETRIC, canonicalValue: '347.5000' }, 'metric');

    expect(href).toBe('/add-intake?amount=347.5&method=measured');
  });

  it('carries only the colour for a colour-only urine entry', () => {
    // No amount and no toggle to carry — and no empty `amount=` either, which
    // would pre-fill a field with nothing and read as a cleared value.
    const href = draftHrefFor(
      {
        kind: 'volumeless-urine',
        key: 'c',
        code: VOIDED_URINE_LOINC_CODE,
        urineColorCode: 'dark_yellow',
        enteredMeasurementSystem: 'metric',
        occurrences: 2,
        lastEnteredAt: '2026-10-02T08:00:00.000Z',
      },
      'metric',
    );

    expect(href).toBe('/add-urine?urineColor=dark_yellow');
  });
});

describe('what the entry screen accepts back', () => {
  it('reads a well-formed set of params', () => {
    expect(parseDraftParams({ amount: '250', method: 'measured', fluidType: 'water' })).toEqual({
      amount: '250',
      method: 'measured',
      fluidType: 'water',
    });
  });

  it('accepts a decimal amount', () => {
    expect(parseDraftParams({ amount: '347.5' })).toEqual({ amount: '347.5' });
  });

  it('pre-fills nothing from an amount that is not a plain number', () => {
    // `1e9` and `abc` would put the patient in front of a field they did not
    // fill and cannot interpret, and Tier 1's precision rules would then
    // refuse the save with a message about something they never typed.
    expect(parseDraftParams({ amount: '1e9' })).toEqual({});
    expect(parseDraftParams({ amount: 'abc' })).toEqual({});
    expect(parseDraftParams({ amount: '-5' })).toEqual({});
    expect(parseDraftParams({ amount: ' 250 ' })).toEqual({});
  });

  it('pre-fills nothing from a method that is not one of the two answers', () => {
    // Anything else would set the mandatory toggle to a value the screen
    // cannot render as a selected choice, leaving it silently unanswered with
    // no error shown.
    expect(parseDraftParams({ method: 'MEASURED' })).toEqual({});
    expect(parseDraftParams({ method: '258104002' })).toEqual({});
  });

  it('keeps the fields it understands when another is malformed', () => {
    // Half a prefill is still better than none, PROVIDED the half that
    // survives is the half that was valid. The mandatory toggle being dropped
    // leaves the screen asking for it, which is its normal state.
    expect(parseDraftParams({ amount: '250', method: 'nonsense' })).toEqual({
      amount: '250',
    });
  });

  it('takes the first value when a param is repeated', () => {
    // Expo Router hands a repeated param as an array. A repeat is a malformed
    // link, not an instruction to do something twice.
    expect(parseDraftParams({ amount: ['250', '500'] })).toEqual({ amount: '250' });
  });

  it('ignores empty strings rather than pre-filling an empty code', () => {
    expect(parseDraftParams({ fluidType: '', urineColor: '' })).toEqual({});
  });

  it('pre-fills nothing at all when there are no params', () => {
    // The dashboard-button case: the screen must behave exactly as it always
    // has when opened without a draft.
    expect(parseDraftParams({})).toEqual({});
  });
});

describe('a round trip', () => {
  it('survives being built and parsed back', () => {
    // The two halves live in one module precisely so they cannot drift, and
    // this is the test that would catch it if they did.
    const href = draftHrefFor({ ...VOLUMETRIC, fluidTypeCode: 'juice' }, 'metric');
    const query = Object.fromEntries(new URLSearchParams(href!.split('?')[1]));

    expect(parseDraftParams(query)).toEqual({
      amount: '250',
      method: 'measured',
      fluidType: 'juice',
    });
  });
});
