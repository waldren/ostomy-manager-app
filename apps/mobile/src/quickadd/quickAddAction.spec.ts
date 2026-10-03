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

import type { VolumetricValidationThresholds } from '@ostomy/core/validation';

import { FLUID_INTAKE_LOINC_CODE, VOIDED_URINE_LOINC_CODE } from '../entry/observationCodes';

import { decideQuickAdd } from './quickAddAction';
import type { QuickAddSuggestion } from './quickAddSuggestions';

/** No numbered AC for Quick-Add (see `quickAddSuggestions.spec.ts`); each test cites its requirement. */

const NOW = new Date('2026-10-03T09:00:00.000Z');

const THRESHOLDS: VolumetricValidationThresholds = {
  // AC 2.1 AC2's ">2,000 mL" rule, which is one admin-configured value of this
  // threshold rather than a special case.
  softWarningMaxMl: 2000,
  maxClockSkewMs: 300_000,
};

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

const COLOUR_ONLY: QuickAddSuggestion = {
  kind: 'volumeless-urine',
  key: 'c',
  code: VOIDED_URINE_LOINC_CODE,
  urineColorCode: 'dark_yellow',
  enteredMeasurementSystem: 'metric',
  occurrences: 3,
  lastEnteredAt: '2026-10-02T08:00:00.000Z',
};

function decide(overrides: Partial<Parameters<typeof decideQuickAdd>[0]> = {}) {
  return decideQuickAdd({
    suggestion: VOLUMETRIC,
    thresholds: THRESHOLDS,
    surgeryDate: null,
    now: NOW,
    ...overrides,
  });
}

describe('a tap that validates cleanly logs (§5.1 — no loading state)', () => {
  it('logs an ordinary repeated entry', () => {
    expect(decide()).toEqual({ kind: 'log' });
  });

  it('logs a colour-only urine entry', () => {
    // It has no amount for a plausibility bound to be about, so the only way
    // this can fail is the timestamp — and the timestamp is `now`.
    expect(decide({ suggestion: COLOUR_ONLY })).toEqual({ kind: 'log' });
  });
});

describe('a tap that does not validate cleanly opens the draft instead', () => {
  /**
   * The case that will actually occur in use, and the reason this design
   * exists rather than a confirmation dialog.
   *
   * SRS §3.8 and AC 13.2 AC1: a Tier 2 warning asks once and then saves, and
   * must never become a block — "a real 2,500 mL day is the data point the
   * care team most needs". A high-output patient's genuine routine trips the
   * >2,000 mL warning, so a widget for it must neither refuse to log nor log
   * silently through the warning. The entry screen is where the warning has
   * room to be read and confirmed.
   */
  it('routes a Tier 2 warning to the screen that can show it', () => {
    expect(decide({ suggestion: { ...VOLUMETRIC, canonicalValue: '2500.0000' } })).toEqual({
      kind: 'open-draft',
      reason: 'warns',
    });
  });

  it('routes a Tier 1 failure to the screen that can name the field', () => {
    // Reachable even though the value was saved once: thresholds are
    // admin-managed configuration (CLAUDE.md) and the representable-range
    // rules are absolute. A widget cannot name a failing field; the form can.
    expect(decide({ suggestion: { ...VOLUMETRIC, canonicalValue: '100000000.0000' } })).toEqual({
      kind: 'open-draft',
      reason: 'blocked',
    });
  });

  it('refuses to log against no thresholds at all', () => {
    // `validation_thresholds_cache` is deliberately unseeded (CLAUDE.md): "a
    // default there is a hardcoded threshold wearing a database costume". The
    // entry screens refuse to save in this state and say so; a widget that
    // saved anyway would be the one path validating against nothing.
    expect(decide({ thresholds: null })).toEqual({
      kind: 'open-draft',
      reason: 'no-thresholds',
    });
  });

  it('refuses a colour-only entry against no thresholds too', () => {
    // Easy to assume it is exempt, since it has no value to bound. It is not:
    // Tier 1 checks every entry's timestamp against ADR-0019's clock-skew
    // allowance, which is itself one of the cached thresholds.
    expect(decide({ suggestion: COLOUR_ONLY, thresholds: null })).toEqual({
      kind: 'open-draft',
      reason: 'no-thresholds',
    });
  });

  it('routes an entry that predates the surgery date to the draft', () => {
    // Lands for real at P4.S1, when onboarding captures the date. Asserted now
    // because a Quick-Add tap is the one write with no date field in front of
    // it, so this rule has to be enforced by the decision rather than by the
    // patient seeing a date picker.
    expect(decide({ surgeryDate: new Date('2026-12-01T00:00:00.000Z') })).toEqual({
      kind: 'open-draft',
      reason: 'blocked',
    });
  });
});

describe('the value is treated as canonical, not as a display number', () => {
  /**
   * ADR-0004, and the specific defect `@ostomy/core/validation` records
   * already having been made once: the thresholds are canonical-mL bounds, so
   * handing them an imperial number "compares 80 against ~2000 and silently
   * never warns for an imperial patient".
   *
   * A suggestion's value is the stored canonical mL of the patient's own
   * entries, so there is nothing to convert — and the proof that it is read
   * that way is that the warning fires on the canonical magnitude regardless
   * of the system the source entries were made in.
   */
  it('warns on an imperial-entered routine whose canonical value is high', () => {
    expect(
      decide({
        suggestion: {
          ...VOLUMETRIC,
          canonicalValue: '2500.0000',
          enteredMeasurementSystem: 'imperial',
        },
      }),
    ).toEqual({ kind: 'open-draft', reason: 'warns' });
  });

  it('does not warn on a modest canonical value entered in imperial', () => {
    // The other half, so the test above is not just "imperial always warns".
    expect(
      decide({
        suggestion: { ...VOLUMETRIC, enteredMeasurementSystem: 'imperial' },
      }),
    ).toEqual({ kind: 'log' });
  });
});
