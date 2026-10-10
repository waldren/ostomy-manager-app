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

import { unitsForMeasurementSystem } from '@ostomy/core/units';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TargetRanges } from './TargetRanges.js';
import type { ResolvedRange } from '../ranges/useRanges.js';
import '../i18n/index.js';

const METRIC = unitsForMeasurementSystem('metric');
const IMPERIAL = unitsForMeasurementSystem('imperial');

function range(overrides: Partial<ResolvedRange> = {}): ResolvedRange {
  return {
    rangeType: 'daily_output_ml',
    unit: 'mL',
    lowValue: 600,
    highValue: 1500,
    provenance: 'CLINICAL_DEFAULT',
    isActiveThreshold: false,
    divergesFromPhysician: false,
    basis: {
      ostomyType: 'ileostomy',
      daysPostOp: 10,
      minDaysPostOp: 0,
      maxDaysPostOp: 30,
    },
    ...overrides,
  };
}

describe('TargetRanges', () => {
  /** AC 14.1 AC1: the value, with a plain-language basis naming ostomy type and time since surgery. */
  it('shows the range and states what it is based on', () => {
    render(<TargetRanges ranges={[range()]} targetSystem={METRIC} />);

    expect(screen.getByText(/600 mL to 1,?500 mL/)).toBeVisible();
    expect(screen.getByText(/typical for an ileostomy in the first weeks/i)).toBeVisible();
  });

  it.each([
    [40, /about 1 months? after surgery/i],
    [95, /about 3 months after surgery/i],
    [400, /once things have settled/i],
  ])('describes a patient %i days post-op in their own terms', (daysPostOp, expected) => {
    render(
      <TargetRanges
        ranges={[range({ basis: { ...range().basis!, daysPostOp } })]}
        targetSystem={METRIC}
      />,
    );

    expect(screen.getByText(expected)).toBeVisible();
  });

  /**
   * AC 14.1 AC2, said out loud rather than only stored.
   *
   * A suggestion presented without this reads as "this is your target", which is
   * the impression the whole confirmation rule exists to prevent.
   */
  it('says an unconfirmed default is a suggestion', () => {
    render(<TargetRanges ranges={[range()]} targetSystem={METRIC} />);

    expect(screen.getByText(/a suggestion\. you have not set this yourself/i)).toBeVisible();
  });

  it.each([
    ['PHYSICIAN_SET', /set by your care team/i],
    ['PATIENT_SET', /set by you/i],
    ['PATIENT_CONFIRMED_SUGGESTION', /a suggestion you accepted/i],
  ])('names %s as the source once it is a real threshold', (provenance, expected) => {
    render(
      <TargetRanges
        ranges={[range({ provenance, isActiveThreshold: true })]}
        targetSystem={METRIC}
      />,
    );

    expect(screen.getByText(expected)).toBeVisible();
  });

  /**
   * `isActiveThreshold` governs, not `provenance`. The server decides which
   * provenance values count as confirmed; a component that re-derived it could
   * call something a target that the server does not treat as one.
   */
  it('calls a physician-set value a suggestion when the server says it is not a threshold', () => {
    render(
      <TargetRanges
        ranges={[range({ provenance: 'PHYSICIAN_SET', isActiveThreshold: false })]}
        targetSystem={METRIC}
      />,
    );

    expect(screen.getByText(/a suggestion\. you have not set this yourself/i)).toBeVisible();
    expect(screen.queryByText(/set by your care team/i)).not.toBeInTheDocument();
  });

  /** AC 14.1 AC4: the physician's value is in force, and the patient is told which one they are seeing. */
  it('says whose value is shown when the patient holds a different one', () => {
    render(
      <TargetRanges
        ranges={[
          range({
            provenance: 'PHYSICIAN_SET',
            isActiveThreshold: true,
            divergesFromPhysician: true,
          }),
        ]}
        targetSystem={METRIC}
      />,
    );

    expect(screen.getByText(/your care team’s value is the one shown/i)).toBeVisible();
  });

  it('says nothing about divergence when there is none', () => {
    render(<TargetRanges ranges={[range()]} targetSystem={METRIC} />);

    expect(screen.queryByText(/value is the one shown/i)).not.toBeInTheDocument();
  });

  /**
   * A floor with no ceiling is the ordinary case for urine adequacy and net
   * balance — passing too little is the concern. Rendering it as a band with a
   * blank half, or as "1000 mL to 0", would both be wrong.
   */
  it('renders a floor with no ceiling as a minimum', () => {
    render(
      <TargetRanges
        ranges={[range({ rangeType: 'urine_output_adequacy_ml', lowValue: 1000, highValue: null })]}
        targetSystem={METRIC}
      />,
    );

    expect(screen.getByText(/at least 1,?000 mL/i)).toBeVisible();
    expect(screen.getByText(/daily urine/i)).toBeVisible();
  });

  it('renders a ceiling with no floor as a maximum', () => {
    render(
      <TargetRanges ranges={[range({ lowValue: null, highValue: 1500 })]} targetSystem={METRIC} />,
    );

    expect(screen.getByText(/up to 1,?500 mL/i)).toBeVisible();
  });

  /**
   * ADR-0004 and ADR-0005. A range is stored in canonical mL and nothing about
   * it is patient-asserted, so an imperial reader sees a converted value rounded
   * to a whole unit — and must never see the millilitre figure.
   */
  it('converts to the reader’s own units', () => {
    render(<TargetRanges ranges={[range()]} targetSystem={IMPERIAL} />);

    // 600 mL ≈ 20 fl oz, 1500 mL ≈ 51 fl oz.
    expect(screen.getByText(/20 fl oz to 51 fl oz/)).toBeVisible();
    expect(screen.queryByText(/600 mL/)).not.toBeInTheDocument();
  });

  /**
   * Weight and heart-rate range types arrive with §3.12 and §3.13. Until this
   * catalog names them, a reader sees the value under a generic label rather
   * than not at all — hiding a measure from a review screen is the worse
   * failure.
   */
  it('shows a range type this release has no label for, rather than dropping it', () => {
    render(
      <TargetRanges
        ranges={[range({ rangeType: 'weight_change_threshold_percent' })]}
        targetSystem={METRIC}
      />,
    );

    expect(screen.getByText(/another measure/i)).toBeVisible();
  });

  it('says so when there are no ranges at all', () => {
    render(<TargetRanges ranges={[]} targetSystem={METRIC} />);

    expect(screen.getByText(/no target ranges for your profile yet/i)).toBeVisible();
  });

  /**
   * §3.9's framing constraint, asserted rather than trusted to review: the copy
   * describes what is typical and must not read as a treatment recommendation.
   * The numbers behind it are implementer-chosen and unratified (#130), which
   * makes this sharper rather than softer.
   *
   * A deny-list is a blunt instrument and it is the same one
   * `catalog.spec.ts` uses on warning copy, for the same reason: the failure it
   * guards against is a well-meaning edit that turns context into instruction.
   */
  it('describes rather than prescribes', () => {
    const { container } = render(
      <TargetRanges
        ranges={[range({ divergesFromPhysician: true, isActiveThreshold: true })]}
        targetSystem={METRIC}
      />,
    );

    const copy = container.textContent ?? '';
    for (const prescriptive of [
      'you should',
      'you must',
      'aim for',
      'try to',
      'make sure',
      'recommended',
      // Not 'advice': the intro says these are NOT advice, and a bare-word
      // deny-list cannot tell a disclaimer from a claim. The phrases above are
      // all imperative constructions, which a disclaimer never is.
      'normal range',
    ]) {
      expect(
        copy.toLowerCase(),
        `target-range copy must not prescribe: "${prescriptive}"`,
      ).not.toContain(prescriptive);
    }
  });

  /** Nothing compares an entry against these yet (P5.S2), and a heading alone would imply otherwise. */
  it('says these are not being checked against entries yet', () => {
    render(<TargetRanges ranges={[range()]} targetSystem={METRIC} />);

    expect(screen.getByText(/nothing here is checked against your entries yet/i)).toBeVisible();
  });
});
