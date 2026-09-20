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

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DailyBalanceNotice } from './DailyBalanceNotice.js';

describe('DailyBalanceNotice', () => {
  it('renders the balance for a day with both sides', () => {
    render(<DailyBalanceNotice balance={{ value: 450, unit: 'mL' }} hasIntake hasOutput />);

    expect(screen.getByText(/450/)).toBeInTheDocument();
    expect(screen.getByText(/minus stoma output/i)).toBeInTheDocument();
  });

  /**
   * The clinically interesting case. An output-dominant day is the classic
   * dehydration presentation, so a negative figure must reach the screen
   * intact rather than being absolutized or hidden.
   */
  it('renders a negative balance', () => {
    render(<DailyBalanceNotice balance={{ value: -1200, unit: 'mL' }} hasIntake hasOutput />);

    expect(screen.getByText(/1,?200/)).toBeInTheDocument();
    expect(screen.getByText(/below zero/i)).toBeInTheDocument();
  });

  /**
   * SRS §3.7: urine is excluded on purpose. A reader who assumes otherwise
   * reads a reassuring balance while urine output may be dangerously low,
   * and that assumption is invisible unless the page states it — so the
   * statement is asserted, not left to chance.
   */
  it('always says urine is excluded', () => {
    render(<DailyBalanceNotice balance={{ value: 450, unit: 'mL' }} hasIntake hasOutput />);

    expect(screen.getByText(/urine is not part of this figure/i)).toBeInTheDocument();
  });

  describe('a one-sided day is labelled, not silently presented as a balance', () => {
    /**
     * The dangerous case: output with no intake logged produces a large
     * negative number that reads as a severe deficit, when it may only be an
     * unlogged one.
     */
    it('says so when no intake was recorded', () => {
      render(
        <DailyBalanceNotice balance={{ value: -800, unit: 'mL' }} hasIntake={false} hasOutput />,
      );

      expect(screen.getByText(/no fluid intake was recorded/i)).toBeInTheDocument();
      expect(screen.getByText(/not a complete balance/i)).toBeInTheDocument();
    });

    it('says so when no output was recorded', () => {
      render(
        <DailyBalanceNotice balance={{ value: 800, unit: 'mL' }} hasIntake hasOutput={false} />,
      );

      expect(screen.getByText(/no stoma output was recorded/i)).toBeInTheDocument();
    });

    it('adds no caveat when both sides are present', () => {
      render(<DailyBalanceNotice balance={{ value: 450, unit: 'mL' }} hasIntake hasOutput />);

      expect(screen.queryByText(/not a complete balance/i)).not.toBeInTheDocument();
    });
  });

  /**
   * "Nothing was recorded" is a fact about the day. The state this replaces
   * said the figure was unavailable, which implied a fault in the product —
   * true when intake logging did not exist, and misleading now that it does.
   */
  it('explains an empty day rather than rendering a zero', () => {
    render(<DailyBalanceNotice balance={undefined} hasIntake={false} hasOutput={false} />);

    expect(screen.getByText(/no fluid intake or stoma output was recorded/i)).toBeInTheDocument();
    expect(screen.queryByText(/^0/)).not.toBeInTheDocument();
  });

  /**
   * SRS §5.4 reserves the urgent voice for the red-flag prompt. A negative
   * balance is an ordinary reading for this population, and dressing it as a
   * warning is what makes a real red flag ignorable.
   */
  it('never uses the warning presentation, whatever the sign', () => {
    const { container } = render(
      <DailyBalanceNotice balance={{ value: -2500, unit: 'mL' }} hasIntake hasOutput />,
    );

    expect(container.querySelector('[data-variant="warning"]')).toBeNull();
    expect(container.querySelector('[data-variant="error"]')).toBeNull();
  });
});
