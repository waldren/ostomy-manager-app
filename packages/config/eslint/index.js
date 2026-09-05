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
 * Patient-scoped modules the admin console may never import.
 *
 * The admin console has zero PHI access (SRS_v2 §3.11) and the boundary is an
 * identity-layer property (§4.6). This rule stops it degrading into an
 * authorization-logic property by accident. Keep this list current as
 * packages/core grows — see ADR-0007 for the path partition.
 */
const PATIENT_ONLY_PATTERNS = [
  '@ostomy/core/fhir',
  '@ostomy/core/fhir/**',
  '@ostomy/core/api-client',
  '@ostomy/core/api-client/**',
  '@ostomy/core/hydration',
  '@ostomy/core/hydration/**',
  '@ostomy/web',
  '@ostomy/web/**',
  '@ostomy/mobile',
  '@ostomy/mobile/**',
  '**/apps/web/**',
  '**/apps/mobile/**',
];

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.expo/**',
      '**/*.min.js',
      'pnpm-lock.yaml',
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
      'no-console': ['warn', { allow: ['warn', 'error'] }],
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
    },
  },

  // 2. Admin/patient boundary — enforced by tooling, not by memory.
  //    apps/admin does not exist yet. The rule exists first on purpose (ADR-0008).
  {
    files: ['apps/admin/**/*.{ts,tsx,js,jsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: PATIENT_ONLY_PATTERNS,
              message:
                'The admin console has zero PHI access (SRS_v2 §3.11). It must never import patient data types. See ADR-0008.',
            },
          ],
        },
      ],
    },
  },

  // 3. No hardcoded user-facing strings — v1 is English-only, but every string
  //    is externalized from day one (SRS_v2 §5.4). Catalog: packages/core/i18n.
  {
    files: UI,
    plugins: { i18next },
    rules: {
      'i18next/no-literal-string': [
        'error',
        {
          mode: 'jsx-text-only',
          'should-validate-template': true,
        },
      ],
    },
  },

  // Config and test files are not shipped UI and not licensed source.
  {
    files: ['**/*.config.{js,ts,mjs,cjs}', '**/eslint.config.js', '**/vitest.config.{js,ts}'],
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
