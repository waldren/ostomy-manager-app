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
 * Nothing in this app may stop text following the OS text-size setting
 * (P4.S3 slice 6, #139 decision 4; SRS §5.4; WCAG 1.4.4).
 *
 * Decision 4 chose to honour the OS setting rather than build an in-app one,
 * which makes this the whole of the guarantee: one `allowFontScaling={false}`
 * on a label, or a `maxFontSizeMultiplier` "to keep the layout tidy", and the
 * patient who set their phone to its largest text gets small text on exactly
 * that control, with no setting in the app to fix it. Truncation is refused
 * for the same reason: a clipped "Estimated" or "Orange-brown" at a large size
 * is a clinical word the patient can no longer read.
 *
 * A static check, deliberately. jest has no layout engine, so no rendering
 * test can see clipping; the audit's emulator pass (see
 * `docs/accessibility/text-scaling-audit.md`) is what checked the layouts.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const MOBILE_ROOT = join(__dirname, '..', '..');

/** Each one stops text growing with the OS setting, or cuts it off when it does. */
const FORBIDDEN: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  // Allowed only bare (`allowFontScaling`) or `={true}`: any other value,
  // including a variable, is a way to turn it off (#150 review).
  {
    pattern: /allowFontScaling(?=\s*=)(?!\s*=\s*\{\s*true\s*\})/,
    why: 'sets allowFontScaling to something other than true',
  },
  {
    pattern: /allowFontScaling\s*:(?!\s*true\b)/,
    why: 'sets allowFontScaling to something other than true',
  },
  // The classic way to switch it off everywhere at once.
  {
    pattern: /\.defaultProps\b/,
    why: 'changes every instance of a component at once (nothing here needs defaultProps)',
  },
  { pattern: /maxFontSizeMultiplier/, why: 'caps OS text scaling' },
  { pattern: /adjustsFontSizeToFit/, why: 'shrinks text to fit' },
  { pattern: /minimumFontScale/, why: 'shrinks text to fit' },
  // Dividing a size by the font scale cancels the scaling out.
  {
    pattern: /\/\s*(fontScale|PixelRatio\.getFontScale\(\))/,
    why: 'divides by the font scale, cancelling it',
  },
  {
    pattern: /numberOfLines/,
    why: 'truncates text that grows (for a multi-line input, use minHeight, as TextField does)',
  },
  { pattern: /ellipsizeMode/, why: 'truncates text that grows' },
  // Containers that can clip text which has grown. None is used today; the
  // next one should be a deliberate decision, with a reason, not an accident.
  { pattern: /\b(height|maxHeight)\s*:\s*\d/, why: 'fixes a height that text can outgrow' },
  { pattern: /overflow\s*:\s*['"]hidden['"]/, why: 'clips content that has grown' },
  { pattern: /position\s*:\s*['"]absolute['"]/, why: 'positions over content that may grow' },
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.spec\.tsx?$/.test(name) ? [path] : [];
  });
}

/**
 * Comments may name these props, and several explain why they are absent.
 *
 * A regex strip, not a parser, and that has one known blind spot: a string
 * containing a block-comment opener (a glob, say) makes everything up to the
 * next closer look like a comment, which could hide a forbidden prop there.
 * Accepted, because no source here contains one; a TypeScript-scanner strip
 * is the fix if one ever does.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('text follows the OS text-size setting everywhere', () => {
  const files = [
    ...sourceFiles(join(MOBILE_ROOT, 'app')),
    ...sourceFiles(join(MOBILE_ROOT, 'src')),
  ];

  it('scans the app’s screens and components', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it.each(FORBIDDEN.map((rule) => [rule.pattern.source, rule] as const))(
    'nothing uses %s',
    (_name, rule) => {
      const offenders = files
        .filter((file) => rule.pattern.test(withoutComments(readFileSync(file, 'utf8'))))
        .map((file) => relative(MOBILE_ROOT, file));
      expect(offenders.map((file) => `${file} ${rule.why}`)).toEqual([]);
    },
  );
});
