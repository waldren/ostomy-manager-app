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
 * Integration tests over the REAL flat config, not over rules in isolation.
 *
 * Both compliance rules shipped broken in their first form, and neither bug
 * was in ESLint — both were in how the config was written. A unit test of
 * `no-restricted-imports` would have passed. These lint actual source text
 * through the root config, which is the thing that has to be correct.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

const eslint = new ESLint({ cwd: repoRoot });

/** Rule IDs reported for `code` when linted as `filePath`. */
async function ruleIdsFor(code, filePath) {
  const [result] = await eslint.lintText(code, { filePath, warnIgnored: false });
  return (result?.messages ?? []).map((m) => m.ruleId);
}

const BOUNDARY = ['no-restricted-imports', 'no-restricted-syntax'];
const hasBoundaryError = (ids) => ids.some((id) => BOUNDARY.includes(id));

describe('admin/patient boundary (SRS §3.11, ADR-0008)', () => {
  const adminFile = 'apps/admin/src/probe.ts';

  it('blocks the @ostomy/core root barrel', async () => {
    // Regression: the original deny-list enumerated subpaths only, so the bare
    // root import — the one anyone writes by default, and the one a barrel
    // file would launder every patient type through — was permitted.
    const ids = await ruleIdsFor(`import { Observation } from '@ostomy/core';`, adminFile);
    expect(hasBoundaryError(ids)).toBe(true);
  });

  it('blocks patient-scoped subpaths', async () => {
    for (const spec of ['@ostomy/core/fhir', '@ostomy/core/api-client', '@ostomy/core/hydration']) {
      const ids = await ruleIdsFor(`import { x } from '${spec}';`, adminFile);
      expect(hasBoundaryError(ids), spec).toBe(true);
    }
  });

  it('blocks type-only imports', async () => {
    const ids = await ruleIdsFor(`import type { P } from '@ostomy/core/fhir';`, adminFile);
    expect(hasBoundaryError(ids)).toBe(true);
  });

  it('blocks re-exports', async () => {
    const ids = await ruleIdsFor(`export { x } from '@ostomy/core/fhir';`, adminFile);
    expect(hasBoundaryError(ids)).toBe(true);
  });

  it('blocks dynamic import()', async () => {
    // Regression: no-restricted-imports registers no ImportExpression handler,
    // so this passed silently until no-restricted-syntax was added.
    const ids = await ruleIdsFor(
      `export async function f() { return import('@ostomy/core/fhir'); }`,
      adminFile,
    );
    expect(hasBoundaryError(ids)).toBe(true);
  });

  it('covers the admin API, which lands five phases before the console', async () => {
    const ids = await ruleIdsFor(
      `import { x } from '@ostomy/core/fhir';`,
      'apps/api/src/admin/thresholds.controller.ts',
    );
    expect(hasBoundaryError(ids)).toBe(true);
  });

  it('permits the allow-listed workspace imports', async () => {
    for (const spec of [
      '@ostomy/ui',
      '@ostomy/config',
      '@ostomy/core/i18n',
      '@ostomy/core/admin',
    ]) {
      const ids = await ruleIdsFor(`import { x } from '${spec}';`, adminFile);
      expect(hasBoundaryError(ids), spec).toBe(false);
    }
  });

  it('does not fire outside admin code', async () => {
    const ids = await ruleIdsFor(`import { x } from '@ostomy/core/fhir';`, 'apps/web/src/probe.ts');
    expect(hasBoundaryError(ids)).toBe(false);
  });
});

describe('no hardcoded user-facing strings (SRS §5.4, ADR-0006)', () => {
  const uiFile = 'apps/web/src/Probe.tsx';

  // NOTE ON FIXTURES: component names here are realistic on purpose. The
  // plugin's default `words.exclude` contains `[A-Z_-]+`, so a component named
  // `C` or `D` matches and silently suppresses every literal inside it. Short
  // placeholder names make this rule look broken when it is not.
  //
  // KNOWN GAP, not covered by this rule in any mode: a component written as
  // `export const Foo = () => <p>text</p>` reports nothing — the exported
  // arrow-function form, which is the dominant React idiom. Function
  // declarations are checked. This limits what ADR-0006 can claim; closing it
  // needs a different plugin or a custom rule. Revisit at P2.S3.
  it('flags JSX text', async () => {
    const ids = await ruleIdsFor(
      `function OutputEntry() {
  return <p>Log your output</p>;
}`,
      uiFile,
    );
    expect(ids).toContain('i18next/no-literal-string');
  });

  it('flags accessible names', async () => {
    // Regression: the plugin default mode ('jsx-text-only') checks only text
    // children, so every aria-label and accessibilityLabel — the copy WCAG
    // 2.1 AA depends on — was invisible to the rule.
    // The element matters: the plugin skips attributes that are not real DOM
    // attributes when the element is a lowercase host tag, so
    // `<input accessibilityLabel>` reports nothing — correctly, since that is
    // not a thing. React Native and custom components take the same names on
    // capitalised elements, where they are checked.
    const hostAttrs = ['aria-label', 'placeholder', 'alt', 'title'];
    const componentAttrs = ['accessibilityLabel', 'accessibilityHint', 'label'];

    for (const attr of hostAttrs) {
      const ids = await ruleIdsFor(
        `function SaveButton() {\n  return <input ${attr}="Save entry" />;\n}`,
        uiFile,
      );
      expect(ids, `<input ${attr}>`).toContain('i18next/no-literal-string');
    }

    for (const attr of componentAttrs) {
      const ids = await ruleIdsFor(
        `function SaveButton() {\n  return <Pressable ${attr}="Save entry" />;\n}`,
        uiFile,
      );
      expect(ids, `<Pressable ${attr}>`).toContain('i18next/no-literal-string');
    }
  });

  it('does not fire on the catalog itself', async () => {
    const ids = await ruleIdsFor(
      `export const en = { save: 'Save entry' };`,
      'packages/core/i18n/en.ts',
    );
    expect(ids).not.toContain('i18next/no-literal-string');
  });

  it('does not fire on the API', async () => {
    const ids = await ruleIdsFor(`export const code = 'TIER_1_NEGATIVE';`, 'apps/api/src/probe.ts');
    expect(ids).not.toContain('i18next/no-literal-string');
  });
});

describe('AGPL header, applied through the real config', () => {
  it('fires on source under packages/', async () => {
    const ids = await ruleIdsFor('export const a = 1;', 'packages/core/src/probe.ts');
    expect(ids).toContain('ostomy/agpl-header');
  });

  it('fires on source under apps/', async () => {
    const ids = await ruleIdsFor('export const a = 1;', 'apps/api/src/probe.ts');
    expect(ids).toContain('ostomy/agpl-header');
  });

  it('does not fire on workspace-root config files', async () => {
    const ids = await ruleIdsFor('export default {};', 'packages/ui/vitest.config.ts');
    expect(ids).not.toContain('ostomy/agpl-header');
  });

  it('still fires on source that merely looks like config', async () => {
    // '**/*.config.*' would have exempted this. It is source.
    const ids = await ruleIdsFor('export const t = {};', 'packages/ui/src/theme.config.ts');
    expect(ids).toContain('ostomy/agpl-header');
  });
});

describe('no-console in shipped code', () => {
  it('blocks console.error in apps/, not only console.log', async () => {
    // The realistic PHI leak is an exception handler, not a debug print.
    const ids = await ruleIdsFor(
      `/* GNU Affero General Public License */\nexport function f(p) {\n  console.error('sync failed', p);\n}`,
      'apps/api/src/probe.ts',
    );
    expect(ids).toContain('no-console');
  });

  it('permits console.error in scripts/, which are not shipped code', async () => {
    const ids = await ruleIdsFor(`console.error('failed');`, 'scripts/probe.mjs');
    expect(ids).not.toContain('no-console');
  });
});
