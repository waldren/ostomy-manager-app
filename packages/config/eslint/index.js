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
 * Shared ESLint flat configuration.
 *
 * Three of the rule blocks below are not style preferences — they are project
 * constraints that must fail the build rather than depend on anyone
 * remembering them:
 *
 *   1. AGPL header      — CLAUDE.md "Licensing"
 *   2. Admin boundary    — SRS_v2 §3.11/§4.6, ADR-0008
 *   3. no-literal-string — SRS_v2 §5.4, ADR-0006
 *
 * Type-aware linting is deliberately not enabled yet: there are no TypeScript
 * projects to point it at. Turn it on in the sprint that scaffolds the first
 * app, not before.
 */

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierCompat from 'eslint-config-prettier';
import i18next from 'eslint-plugin-i18next';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

import ostomy from './plugin.js';

/** Source files that carry a license header and get linted as source. */
const SOURCE = ['apps/**/*.{ts,tsx,js,jsx,mjs,cjs}', 'packages/**/*.{ts,tsx,js,jsx,mjs,cjs}'];

/** Directories that render UI, and therefore must not contain literal strings. */
const UI = [
  'apps/web/**/*.{ts,tsx,js,jsx}',
  'apps/mobile/**/*.{ts,tsx,js,jsx}',
  'apps/admin/**/*.{ts,tsx,js,jsx}',
  'packages/ui/**/*.{ts,tsx,js,jsx}',
];

/**
 * Admin code, wherever it lives. The admin API (ADR-0008) lands at P3.S3,
 * several phases before the console SPA, so scoping this to `apps/admin`
 * alone would leave the higher-sensitivity half uncovered.
 */
const ADMIN = ['apps/admin/**/*.{ts,tsx,js,jsx,mjs,cjs}', 'apps/api/src/admin/**/*.{ts,mjs,cjs}'];

/**
 * Workspace modules admin code is permitted to import. Deny by default.
 *
 * This is an allow-list on purpose. The first shape of this rule was a
 * deny-list naming patient-scoped subpaths, and it was close to inert: it did
 * not restrict the `@ostomy/core` root barrel — the import anyone writes by
 * default, and the one a barrel file would launder every patient type
 * through. A deny-list also fails open, silently, every time someone adds a
 * subpath nobody remembers to enumerate.
 *
 * WHAT THIS RULE DOES NOT COVER, and must not be claimed to:
 *   - Relative traversal out of the app (`../../web/src/x`). `no-restricted-
 *     imports` matches the specifier string, not the resolved path, and admin
 *     files legitimately use `../` internally at varying depths. Closing this
 *     needs path resolution — add `eslint-plugin-import`'s `no-restricted-
 *     paths` when `apps/admin` is scaffolded at P8.S1.
 *   - Re-export laundering through an intermediate package.
 *
 * The load-bearing controls are elsewhere and this lint is a fast secondary
 * check: the disjoint Cognito pool (SRS_v2 §4.6) and, once `apps/admin`
 * exists, its package.json dependency closure — pnpm's isolated node_modules
 * makes an undeclared import fail at install, which no lint bypass defeats.
 *
 * Expressed as one regex over `no-restricted-syntax` rather than through
 * `no-restricted-imports` groups. That rule matches with gitignore semantics,
 * where `!@ostomy/core/i18n` does not reliably re-include a path already
 * excluded by `@ostomy/core/*` — verified: the catalog stayed blocked. It also
 * registers no `ImportExpression` handler, so dynamic `import()` slips past it
 * entirely. A single selector covers all four import forms with semantics we
 * control and can test.
 *
 * Allowed: @ostomy/config, @ostomy/ui, @ostomy/core/admin, @ostomy/core/i18n
 * (and anything beneath them). Everything else under @ostomy/ is blocked,
 * including the @ostomy/core root barrel.
 *
 * `/` is a literal `/` — an unescaped one would close the esquery regex.
 */
const ADMIN_BLOCKED_SPECIFIER =
  '/^@ostomy\\u002F(?!(config|ui)($|\\u002F))(?!core\\u002F(admin|i18n)($|\\u002F))/';

const ADMIN_IMPORT_NODES = [
  'ImportDeclaration',
  'ImportExpression',
  'ExportNamedDeclaration',
  'ExportAllDeclaration',
];

const ADMIN_BOUNDARY_MESSAGE =
  'The admin console has zero PHI access (SRS_v2 §3.11) and must never import patient data types. ' +
  'Permitted workspace imports: @ostomy/config, @ostomy/ui, @ostomy/core/admin, @ostomy/core/i18n. See ADR-0008.';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.expo/**',
      // Specs, ADRs, and design mockups exported from other tools.
      'design-specs/**',
      // Agent worktrees live inside the checkout and are gitignored, but
      // ESLint walks the filesystem, not git — without this, `pnpm lint`
      // fails on a concurrent agent's branch rather than on your own code.
      '.claude/**',
      '**/*.min.js',
      'pnpm-lock.yaml',
      // Native projects generated by `expo prebuild`. Build output, and
      // gitignored — but ESLint walks the filesystem, not git.
      'apps/mobile/android/**',
      'apps/mobile/ios/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2023 },
    },
    rules: {
      eqeqeq: ['error', 'smart'],
      // No options here on purpose: flat config MERGES rule options when a
      // later entry supplies only a severity, so an `allow` list set here
      // would survive into the stricter block below and keep permitting
      // console.error in shipped code. `lint` runs with --max-warnings=0, so
      // a warning still fails CI.
      'no-console': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // 1. AGPL header — CLAUDE.md requires it on new source files in apps/ and packages/.
  {
    files: SOURCE,
    plugins: { ostomy },
    rules: {
      'ostomy/agpl-header': 'error',
      // No console in shipped code, including console.error. The realistic
      // leak is `console.error('sync failed', payload)` in an exception
      // handler, which puts a batch of Observations into CloudWatch — the
      // exact thing "never log PHI" exists to prevent, and the allow-list for
      // warn/error would have permitted it. Use the structured logger, whose
      // serializer strips PHI (docs/security-hipaa.md).
      //
      'no-console': 'error',
    },
  },

  // 2. Admin/patient boundary — enforced by tooling, not by memory.
  //    Neither apps/admin nor apps/api/src/admin exists yet. The rule lands
  //    first on purpose (ADR-0008).
  {
    files: ADMIN,
    rules: {
      'no-restricted-syntax': [
        'error',
        ...ADMIN_IMPORT_NODES.map((node) => ({
          selector: `${node}[source.value=${ADMIN_BLOCKED_SPECIFIER}]`,
          message: ADMIN_BOUNDARY_MESSAGE,
        })),
      ],
    },
  },

  // 3. No hardcoded user-facing strings — v1 is English-only, but every string
  //    is externalized from day one (SRS_v2 §5.4). Catalog: packages/core/i18n.
  //    'jsx-only' rather than the plugin default 'jsx-text-only': the default
  //    checks only JSX text children, so `aria-label`, `accessibilityLabel`,
  //    `placeholder`, `alt` and `title` — the accessible names WCAG 2.1 AA
  //    depends on, for a screen-reader-dependent population — would never be
  //    seen. Those are exactly the strings typed inline and never revisited.
  {
    files: UI,
    plugins: { i18next },
    rules: {
      'i18next/no-literal-string': [
        'error',
        {
          mode: 'jsx-only',
          'should-validate-template': true,
          'jsx-attributes': {
            include: [
              'aria-label',
              'aria-description',
              'aria-placeholder',
              'aria-roledescription',
              'aria-valuetext',
              'accessibilityLabel',
              'accessibilityHint',
              'accessibilityValue',
              'placeholder',
              'alt',
              'title',
              'label',
            ],
          },
        },
      ],
    },
  },

  // The catalog itself holds the strings, so it may contain literals.
  {
    files: ['packages/core/i18n/**', 'packages/core/src/i18n/**'],
    rules: { 'i18next/no-literal-string': 'off' },
  },

  // 4. React accessibility and hooks correctness — added at P2.S3, the sprint
  // that scaffolds the first React UI (packages/config's own prior comment
  // flagged react/type-aware linting as deferred "to the sprint that
  // scaffolds the first app," which this is). Scoped to the same `UI` glob
  // as the no-literal-string rule above: these are JSX-authoring concerns,
  // not something apps/api or packages/core has any use for.
  //
  // jsx-a11y is a static best-effort check (e.g. "this <img> has no `alt`
  // attribute at all") — it cannot verify that an attribute's *content* is
  // meaningful, is not the sole carrier of a state that also needs a text
  // label, or reads at a 6th-8th grade level. It is a floor, not a
  // replacement for `accessibility-copy-reviewer` or manual screen-reader
  // testing.
  //
  // `react-hooks`'s own `configs.recommended` (v7) bundles the traditional
  // `rules-of-hooks`/`exhaustive-deps` pair together with a dozen "React
  // Compiler" static-analysis rules (`set-state-in-effect`,
  // `set-state-in-render`, `immutability`, `gating`, ...). Those compiler
  // rules assume the React Compiler is in the build (this repo has no
  // `babel-plugin-react-compiler`) and, exercised against an ordinary
  // hand-written data-fetching effect (`useEffect` that calls a loader,
  // which calls a state setter from inside a `.then()`), `set-state-in-effect`
  // flags it regardless of whether the update is synchronous or genuinely
  // deferred to a microtask after a network round-trip — i.e. it flags the
  // sanctioned "effect fetches, callback updates state on arrival" pattern
  // React's own docs describe, not just the anti-pattern the rule's message
  // names. Confirmed at P2.S3 against `apps/web`'s `PhysicianOutputView`
  // before this narrowing was added. Only the two universally-applicable
  // hook rules are enabled here; revisit if/when this repo adopts the React
  // Compiler.
  {
    files: UI,
    plugins: { 'jsx-a11y': jsxA11y, 'react-hooks': reactHooks },
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules,
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // Infrastructure and scripts: base rules apply, but they are not shipped
  // application source. AWS CDK (TypeScript) lands in infra/ per CLAUDE.md,
  // and ESLint 9 lints only .js/.mjs/.cjs unless TS files are named.
  {
    files: ['infra/**/*.{ts,js,mjs}', 'scripts/**/*.{ts,js,mjs}', '*.{ts,js,mjs}'],
    rules: {
      'ostomy/agpl-header': 'off',
      // Operational output is the point of a script.
      'no-console': ['warn', { allow: ['log', 'warn', 'error'] }],
    },
  },

  // Config and test files are not shipped UI and not licensed source.
  // Anchored to workspace roots so a future packages/ui/src/theme.config.ts —
  // which is source — does not silently lose its header requirement.
  {
    files: ['*.config.{js,ts,mjs,cjs}', '{apps,packages}/*/*.config.{js,ts,mjs,cjs}'],
    rules: {
      'ostomy/agpl-header': 'off',
    },
  },
  {
    files: ['**/*.{test,spec}.{ts,tsx,js,jsx}', '**/__tests__/**'],
    rules: {
      'i18next/no-literal-string': 'off',
    },
  },

  // Must stay last: turns off everything Prettier owns.
  prettierCompat,
];
