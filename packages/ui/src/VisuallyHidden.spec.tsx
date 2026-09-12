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
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { VisuallyHidden } from './VisuallyHidden.js';

/**
 * The regression this file exists to catch is a CSS one, so it reads the CSS.
 *
 * The original test rendered the component and asserted it carried the
 * `ostomyVisuallyHidden` class — which is true of every possible
 * implementation of visual hiding, including the broken ones. Swapping the
 * rule's body for `display: none` would have kept that assertion green while
 * removing the content from the accessibility tree entirely, silencing a
 * chart's only screen-reader description. jsdom applies no stylesheet, so
 * `getComputedStyle` cannot see the difference either; the stylesheet source
 * is where the behaviour actually lives.
 */
const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, './styles.css'), 'utf-8');

/**
 * Extracts one rule's declarations.
 *
 * Plain string slicing rather than a RegExp: the escaping needed to build a
 * selector pattern inside a template literal is its own source of silent
 * failure, and an unparsed selector here fails as "no such rule" — which
 * looks exactly like the regression this file is meant to report.
 */
function ruleBody(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) {
    throw new Error(`styles.css has no ${selector} rule`);
  }
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

describe('VisuallyHidden', () => {
  it('renders its children into the document under the shared class', () => {
    render(<VisuallyHidden>Chart data as a table follows</VisuallyHidden>);
    const node = screen.getByText('Chart data as a table follows');
    expect(node).toBeInTheDocument();
    expect(node).toHaveClass('ostomyVisuallyHidden');
  });

  it('renders the element the caller asked for, so a block wrapper stays valid', () => {
    // `as="div"` exists because the chart's long description is a <ul> inside
    // it, and a <ul> inside a <span> is invalid markup that browsers reflow
    // out of the wrapper.
    const { container } = render(
      <VisuallyHidden as="div">
        <ul>
          <li>2:00 AM: 350 milliliters</li>
        </ul>
      </VisuallyHidden>,
    );
    expect(container.querySelector('div.ostomyVisuallyHidden')).not.toBeNull();
  });

  describe('the stylesheet hides it visually WITHOUT hiding it from assistive technology', () => {
    const body = ruleBody('.ostomyVisuallyHidden');

    it.each(['display: none', 'visibility: hidden'])(
      'never uses %s, which would remove the content from the accessibility tree',
      (forbidden) => {
        // Both are the natural way to hide something and both are wrong here:
        // a screen reader skips them exactly as a sighted user does, so the
        // chart's only accessible equivalent would go silent while the
        // component still "worked".
        expect(body.replace(/\s+/g, ' ')).not.toContain(forbidden);
      },
    );

    it.each([
      ['position', 'absolute'],
      ['width', '1px'],
      ['height', '1px'],
      ['overflow', 'hidden'],
      ['clip', 'rect(0, 0, 0, 0)'],
    ])('clips rather than hides: %s is %s', (property, value) => {
      expect(body).toContain(`${property}: ${value}`);
    });
  });
});
