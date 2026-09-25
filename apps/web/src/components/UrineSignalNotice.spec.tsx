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

import { UrineSignalNotice } from './UrineSignalNotice.js';

describe('UrineSignalNotice', () => {
  it('renders nothing for a day with no urine entries', () => {
    const { container } = render(<UrineSignalNotice summary={undefined} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders the measured total and how much of the day it covers', () => {
    render(
      <UrineSignalNotice
        summary={{
          entryCount: 3,
          measuredTotal: { value: 550, unit: 'mL' },
          measuredCount: 2,
          colorCodes: [],
        }}
      />,
    );

    expect(screen.getByText(/550/)).toBeInTheDocument();
    // The coverage line is the point: a bare "550 mL" would describe a
    // three-entry day as though the unmeasured one had not happened.
    expect(screen.getByText(/2 of 3 urine entries/i)).toBeInTheDocument();
  });

  /**
   * AC 12.1 AC2's whole day, and the assertion that matters most here.
   *
   * A day recorded entirely by colour carries a real hydration signal made by
   * a patient who cannot measure. Rendering it as "0 mL" would be a clinical
   * claim nobody made, and for this particular signal it is the most alarming
   * direction to invent one in — a physician reading 0 mL of urine would act.
   */
  it('never shows a zero total for a day recorded only by colour', () => {
    render(
      <UrineSignalNotice
        summary={{
          entryCount: 2,
          measuredTotal: undefined,
          measuredCount: 0,
          colorCodes: ['amber'],
        }}
      />,
    );

    // Leads with the finding, not the count, and says "urine" in its own
    // words rather than leaning on a title that is only visually a heading.
    expect(
      screen.getByText(/no measured volume for this day\. 2 urine entries were recorded/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/\b0\s*mL\b/)).not.toBeInTheDocument();
    expect(screen.queryByText(/measured total/i)).not.toBeInTheDocument();
  });

  it('names each colour in words, as a list', () => {
    render(
      <UrineSignalNotice
        summary={{
          entryCount: 3,
          measuredTotal: undefined,
          measuredCount: 0,
          colorCodes: ['pale_straw', 'amber', 'brown'],
        }}
      />,
    );

    // The two ends name themselves as ends, and every step uses one
    // comparative vocabulary — the labels have to be ORDERABLE, not merely
    // distinguishable, because the scale's direction is the clinical content.
    const items = screen.getAllByRole('listitem').map((item) => item.textContent);
    expect(items).toEqual(['Almost clear — lightest', 'Orange-brown', 'Brown — darkest']);
  });

  /**
   * Heading navigation is how a clinician skims a data page, and a bold
   * paragraph is invisible to it. This region was unreachable that way, and so
   * was the daily net fluid balance above it — the physician view's whole
   * outline was `h1` then one `h2` for the table.
   */
  it('names the region with a real heading, not a bold paragraph', () => {
    render(
      <UrineSignalNotice
        summary={{
          entryCount: 1,
          measuredTotal: { value: 300, unit: 'mL' },
          measuredCount: 1,
          colorCodes: [],
        }}
      />,
    );

    expect(screen.getByRole('heading', { name: /urine output/i })).toBeInTheDocument();
  });

  /**
   * The value set is admin-managed and members can be added after a release
   * ships (CLAUDE.md), so a code with no catalog label is reachable rather
   * than defensive. It renders as the shared fallback, never as the raw code
   * — `very_dark_brown` on a clinical page is worse than saying plainly that
   * it is a step this build does not know.
   */
  it('falls back for a colour this release has no copy for, without showing the code', () => {
    render(
      <UrineSignalNotice
        summary={{
          entryCount: 1,
          measuredTotal: undefined,
          measuredCount: 0,
          colorCodes: ['very_dark_brown'],
        }}
      />,
    );

    expect(screen.getByText('Another option')).toBeInTheDocument();
    expect(screen.queryByText(/very_dark_brown/)).not.toBeInTheDocument();
  });

  it('omits the colour section entirely when every entry was measured without one', () => {
    render(
      <UrineSignalNotice
        summary={{
          entryCount: 2,
          measuredTotal: { value: 700, unit: 'mL' },
          measuredCount: 2,
          colorCodes: [],
        }}
      />,
    );

    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.queryByText(/colours recorded/i)).not.toBeInTheDocument();
  });

  /**
   * SRS §3.7, said from this side too. `DailyBalanceNotice` says urine is
   * excluded; a reader who reaches this block first should not have to find
   * that one to learn the two figures are separate.
   */
  it('says outright that this is not part of the daily net fluid balance', () => {
    render(
      <UrineSignalNotice
        summary={{
          entryCount: 1,
          measuredTotal: { value: 300, unit: 'mL' },
          measuredCount: 1,
          colorCodes: [],
        }}
      />,
    );

    expect(screen.getByText(/not part of the daily net fluid balance/i)).toBeInTheDocument();
  });

  /**
   * SRS §5.4 reserves the urgent voice for the red-flag prompt, and this
   * view keeps the four hydration signals separate and uncombined. A low
   * urine day must not be dressed as a warning here: interpretation is the
   * reader's, and teaching a clinician that the urgent styling is routine is
   * what makes a real red flag ignorable.
   */
  it('never raises an alert, whatever the day holds', () => {
    render(
      <UrineSignalNotice
        summary={{
          entryCount: 1,
          measuredTotal: { value: 50, unit: 'mL' },
          measuredCount: 1,
          colorCodes: ['brown'],
        }}
      />,
    );

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
