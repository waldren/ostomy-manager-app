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

// jest-expo is forced by docs/testing.md ("Vitest does not carry the React
// Native preset cleanly"), not chosen freely — see that document before
// changing this.
//
// No `transformIgnorePatterns` override here, deliberately (P2.S2a
// finding): `jest-expo`'s own preset already ships one
// (`node_modules/jest-expo/jest-preset.js`) that includes a literal
// `.pnpm` segment in its allow-list specifically to handle pnpm's nested
// `node_modules/.pnpm/<pkg>@<version>/node_modules/<pkg>/...` store
// layout. The commonly-copied npm/yarn-oriented pattern (no `.pnpm`
// alternative) matches the outer `.pnpm` segment as "not an allow-listed
// package" and therefore leaves `@react-native/jest-preset`'s own
// (unbuilt, ESM-syntax) `jest/setup.js` untransformed under this
// workspace's pnpm layout — surfacing as "Must use import to load ES
// Module" against a file this app never wrote. Overriding the array here
// silently discards the preset's pnpm-aware default; only add entries by
// composing with `require('jest-expo/jest-preset').transformIgnorePatterns`
// if a future dependency genuinely needs one more allow-listed package.
module.exports = {
  preset: 'jest-expo',
  setupFilesAfterEnv: ['<rootDir>/src/test-support/setup.ts'],
  collectCoverageFrom: ['src/**/*.{ts,tsx}', '!src/**/*.spec.{ts,tsx}', '!src/test-support/**'],
  moduleNameMapper: {
    // `expo-crypto`'s `randomUUID` is a native binding with no JS
    // fallback; jest-expo's generic native-module mock returns `undefined`
    // from it, which silently produces a `NULL` id column in every test
    // that mints one via `src/lib/utils/uuid.ts`. See the mock's own
    // header comment. This is a project-config addition merged with
    // jest-expo's own `moduleNameMapper` (its `react-native-vector-icons`
    // aliases), not a replacement of it.
    '^expo-crypto$': '<rootDir>/src/test-support/mocks/expo-crypto.ts',
  },
};
