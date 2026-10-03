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
 * What the widget actually says, asserted rather than claimed in a comment.
 *
 * Two of this component's guarantees are the kind that are cheap to write down
 * and easy to lose in the code:
 *
 * - **The Measured/Estimated answer is on the face of the button.** A tap
 *   re-asserts it with no form in between (ADR-0018, SRS §3.1), so a label
 *   that omitted it would ask the patient to commit to an answer they cannot
 *   see. Nothing but a test stops that being dropped as visual clutter.
 * - **There is no loading state** (§5.1). A spinner added later would look
 *   like an improvement.
 */

import { render } from '@testing-library/react-native';

import '../i18n/i18n';

import { FLUID_INTAKE_LOINC_CODE, VOIDED_URINE_LOINC_CODE } from '../entry/observationCodes';

import { QuickAddWidgets } from './QuickAddWidgets';
import type { QuickAddSuggestion } from './quickAddSuggestions';

const VOLUMETRIC: QuickAddSuggestion = {
  kind: 'volumetric',
  key: 'k1',
  code: FLUID_INTAKE_LOINC_CODE,
  canonicalValue: '250.0000',
  method: 'measured',
  fluidTypeCode: null,
  urineColorCode: null,
  enteredMeasurementSystem: 'metric',
  occurrences: 4,
  lastEnteredAt: '2026-10-02T08:00:00.000Z',
};

async function renderWidgets(suggestions: readonly QuickAddSuggestion[] | undefined) {
  // `render` is async in this version of the library; awaiting it is what makes
  // the first effect flush before a query runs.
  return render(
    <QuickAddWidgets
      suggestions={suggestions}
      measurementSystem="metric"
      onLog={() => undefined}
      onEdit={() => undefined}
    />,
  );
}

describe('the label states what a tap would record', () => {
  it('names the amount and the Measured answer', async () => {
    const { queryByText } = await renderWidgets([VOLUMETRIC]);

    expect(await queryByText(/250 mL/)).not.toBeNull();
    expect(await queryByText(/Measured/)).not.toBeNull();
  });

  it('names the Estimated answer when that is what the patient said', async () => {
    // The direction a default would get wrong, visible on the button.
    const { queryByText } = await renderWidgets([{ ...VOLUMETRIC, method: 'estimated' }]);

    expect(await queryByText(/Estimated/)).not.toBeNull();
    expect(await queryByText(/Measured/)).toBeNull();
  });

  it('names the fluid type, so two routines at one volume are distinguishable', async () => {
    const { queryByText } = await renderWidgets([
      { ...VOLUMETRIC, fluidTypeCode: 'coffee_or_tea' },
    ]);

    expect(await queryByText(/Coffee or tea/)).not.toBeNull();
  });

  it('says how often the patient logged it', async () => {
    // The number is their own history and is what makes a generated suggestion
    // inspectable at all — there is no review screen for these until P4.S3.
    const { queryByText } = await renderWidgets([VOLUMETRIC]);

    expect(await queryByText(/logged this 4 times/)).not.toBeNull();
  });

  it('renders a colour-only entry with no amount, and says so', async () => {
    // A missing amount is never zero (CLAUDE.md). "0 mL" here would be an
    // invented reading in the most alarming direction for this signal.
    const { queryByText } = await renderWidgets([
      {
        kind: 'volumeless-urine',
        key: 'c1',
        code: VOIDED_URINE_LOINC_CODE,
        urineColorCode: 'dark_yellow',
        enteredMeasurementSystem: 'metric',
        occurrences: 2,
        lastEnteredAt: '2026-10-02T08:00:00.000Z',
      },
    ]);

    expect(await queryByText(/Darker yellow/)).not.toBeNull();
    expect(await queryByText(/no amount/)).not.toBeNull();
    expect(await queryByText(/0 mL/)).toBeNull();
  });

  it('renders the amount in the patient’s own system', async () => {
    // ADR-0004/ADR-0005: canonical mL is stored, the display converts, and a
    // cross-system conversion rounds to a whole unit. 250 mL is 8 oz.
    const { queryByText } = await render(
      <QuickAddWidgets
        suggestions={[VOLUMETRIC]}
        measurementSystem="imperial"
        onLog={() => undefined}
        onEdit={() => undefined}
      />,
    );

    expect(await queryByText(/8 fl oz/)).not.toBeNull();
    expect(await queryByText(/250/)).toBeNull();
  });
});

describe('a suggestion this release cannot name is not offered', () => {
  it('drops a colour with no catalog label rather than showing a code', async () => {
    // A value-set member an admin adds after a release ships has no copy
    // (ADR-0006, CLAUDE.md). For a colour-only entry the colour IS the entry,
    // so there would be nothing left to describe — and a one-tap button whose
    // meaning the patient cannot read is worse than no button.
    const { queryByText } = await renderWidgets([
      {
        kind: 'volumeless-urine',
        key: 'c2',
        code: VOIDED_URINE_LOINC_CODE,
        urineColorCode: 'chartreuse',
        enteredMeasurementSystem: 'metric',
        occurrences: 2,
        lastEnteredAt: '2026-10-02T08:00:00.000Z',
      },
    ]);

    expect(await queryByText(/chartreuse/)).toBeNull();
    expect(await queryByText(/no amount/)).toBeNull();
  });

  it('still offers a volumetric entry whose fluid type has no label', async () => {
    // The asymmetry is deliberate: the amount and the toggle are a complete
    // and true description of what a tap would record, so dropping the widget
    // would cost the patient a usable shortcut for a missing adjective.
    const { queryByText } = await renderWidgets([{ ...VOLUMETRIC, fluidTypeCode: 'kombucha' }]);

    expect(await queryByText(/250 mL/)).not.toBeNull();
    expect(await queryByText(/kombucha/)).toBeNull();
  });
});

describe('there is no loading state (§5.1)', () => {
  it('renders nothing at all before the first read settles', async () => {
    // Not a spinner and not a heading with an empty body. A patient who blinks
    // and misses it sees the section appear.
    const { toJSON } = await renderWidgets(undefined);

    expect(toJSON()).toBeNull();
  });

  it('renders nothing when there is nothing to suggest', async () => {
    // The same render as "not read yet", on purpose: telling the two apart is
    // what would reintroduce a loading state, and a first-day patient meets
    // exactly the dashboard they met before.
    const { toJSON } = await renderWidgets([]);

    expect(toJSON()).toBeNull();
  });

  it('passes no busy state to any button', async () => {
    // A tap writes to local SQLite and navigates; the sync worker is asked to
    // run and never waited on (sync-contract §9.5). There is no wait to
    // describe, so there must be no control describing one.
    const { toJSON } = await renderWidgets([VOLUMETRIC]);
    const tree = JSON.stringify(toJSON());

    expect(tree).not.toContain('"accessibilityState":{"busy":true}');
    expect(tree).not.toContain('ActivityIndicator');
  });
});
