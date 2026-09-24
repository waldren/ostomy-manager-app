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

/**
 * AC 12.1 AC3, asserted rather than claimed in a comment.
 *
 * "Each colour step has a visible text label and is announced
 * distinguishably by a screen reader" is the kind of statement that is
 * cheap to write in a doc comment and wrong in the code — a swatch that
 * reaches assistive technology, or two steps sharing a label, and the
 * accessibility guarantee is gone with nothing failing. CLAUDE.md puts
 * accessibility in the "hard target, not polish" list, so it gets a test.
 */

import { render } from '@testing-library/react-native';

import '../i18n/i18n';

import { UrineColorChoice } from './UrineColorChoice';
import type { ValueSetOptionsState } from './useValueSetOptions';

/** The six seeded steps, pale to dark, in `sort_order` (see the P3.S2 migration). */
const SCALE: ValueSetOptionsState = {
  status: 'ready',
  members: [
    { code: 'pale_straw', sortOrder: 10, numericValue: null, numericUnit: null },
    { code: 'straw', sortOrder: 20, numericValue: null, numericUnit: null },
    { code: 'yellow', sortOrder: 30, numericValue: null, numericUnit: null },
    { code: 'dark_yellow', sortOrder: 40, numericValue: null, numericUnit: null },
    { code: 'amber', sortOrder: 50, numericValue: null, numericUnit: null },
    { code: 'brown', sortOrder: 60, numericValue: null, numericUnit: null },
  ],
};

describe('UrineColorChoice', () => {
  it('renders a visible text label for every step of the scale', async () => {
    const view = await render(
      <UrineColorChoice options={SCALE} value={undefined} onChange={jest.fn()} />,
    );

    for (const label of [
      'Almost clear — lightest',
      'Pale yellow',
      'Yellow',
      'Darker yellow',
      'Orange-brown',
      'Brown — darkest',
    ]) {
      expect(view.getByText(label)).toBeTruthy();
    }
  });

  /**
   * AC 12.1 AC3's real requirement, which "distinguishable" alone does not
   * reach: this is a pale-to-dark SCALE, and its direction is the clinical
   * content. Six unique names leave a screen-reader user unable to tell which
   * end is which — nothing in the words placed "Amber" against "Dark yellow",
   * and React Native reports no position-in-set for this control.
   *
   * Four channels carry the ordering now, because a TalkBack user can switch
   * hints off: the two end labels name themselves as ends, the group hint
   * states the direction, and each option announces its step number.
   */
  it('conveys the direction of the scale without relying on the swatches', async () => {
    const view = await render(
      <UrineColorChoice options={SCALE} value={undefined} onChange={jest.fn()} />,
    );

    expect(view.getByText(/lightest to darkest/)).toBeTruthy();
    expect(view.getByText(/lightest$/)).toBeTruthy();
    expect(view.getByText(/darkest$/)).toBeTruthy();

    const steps = view
      .getAllByRole('radio')
      .map((option: { props: { accessibilityHint?: string } }) => option.props.accessibilityHint);
    expect(steps[0]).toBe('Step 1 of 6, lightest to darkest.');
    expect(steps[5]).toBe('Step 6 of 6, lightest to darkest.');
  });

  /**
   * Six options, six DIFFERENT announcements. Two steps sharing a label
   * would read identically to a screen reader — the patient would hear the
   * same option twice and have no way to tell which shade they picked, which
   * is the failure "announced distinguishably" names.
   */
  it('announces every step distinguishably', async () => {
    const view = await render(
      <UrineColorChoice options={SCALE} value={undefined} onChange={jest.fn()} />,
    );

    const announced = view
      .getAllByRole('radio')
      .map((option: { props: { accessibilityLabel?: string } }) => option.props.accessibilityLabel);

    expect(announced).toHaveLength(SCALE.status === 'ready' ? SCALE.members.length : 0);
    expect(new Set(announced).size).toBe(announced.length);
  });

  /**
   * The swatch is decoration. Announcing it would add "#f2de6a" or an image
   * role after a label that already carries the whole distinction, and WCAG
   * 1.4.1 is satisfied by the words, not the colour.
   */
  it('hides the colour swatches from assistive technology', async () => {
    const view = await render(
      <UrineColorChoice options={SCALE} value={undefined} onChange={jest.fn()} />,
    );

    expect(view.queryAllByLabelText(/#/)).toHaveLength(0);
    for (const option of view.getAllByRole('radio')) {
      expect(option.props.accessibilityLabel).not.toMatch(/#/);
    }
  });

  /**
   * A member an admin adds after this release ships has no catalog label
   * (ADR-0006, CLAUDE.md). It renders as "Another option" — never as the raw
   * code, and never hidden: a step missing from the scale misrepresents the
   * scale.
   */
  it('labels a member this release has no copy for without showing its code', async () => {
    const view = await render(
      <UrineColorChoice
        options={{
          status: 'ready',
          members: [
            { code: 'very_dark_brown', sortOrder: 70, numericValue: null, numericUnit: null },
          ],
        }}
        value={undefined}
        onChange={jest.fn()}
      />,
    );

    expect(view.getByText('Another option')).toBeTruthy();
    expect(view.queryByText('very_dark_brown')).toBeNull();
  });

  /**
   * The cache is unseeded on purpose, so before the first successful sync
   * there is no scale to offer. Says so rather than rendering an empty
   * radiogroup a patient will tap at.
   */
  it('says the options could not be loaded rather than rendering an empty scale', async () => {
    const view = await render(
      <UrineColorChoice
        options={{ status: 'unavailable' }}
        value={undefined}
        onChange={jest.fn()}
      />,
    );

    expect(view.queryAllByRole('radio')).toHaveLength(0);
    // The screen's OWN string, not the shared one. `entry.optionsUnavailable`
    // ends "You can still save your entry without them" — false here, because
    // with no scale the colour-without-volume route is gone and a patient who
    // cannot measure can save nothing at all.
    expect(view.getByText(/you will need to enter an amount/i)).toBeTruthy();
  });

  it('renders nothing at all while the cache is still being read', async () => {
    const view = await render(
      <UrineColorChoice options={{ status: 'loading' }} value={undefined} onChange={jest.fn()} />,
    );

    expect(view.toJSON()).toBeNull();
  });
});
