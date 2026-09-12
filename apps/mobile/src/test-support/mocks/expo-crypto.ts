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
 * Test-only replacement for `expo-crypto`, wired via `jest.config.js`'s
 * `moduleNameMapper`. `expo-crypto`'s `randomUUID` is a native binding
 * with no JS fallback; under `jest-expo`'s generic native-module mocking
 * it resolves to a jest auto-mock that returns `undefined`, which
 * `../../lib/utils/uuid.ts`'s `generateUuid()` would then hand straight
 * to a SQLite `id` column as `NULL` — a real bug this mock exists to keep
 * a test from masking. Backed by Node's own built-in `crypto.randomUUID`,
 * which produces the same RFC 4122 v4 UUID shape the real
 * `expo-crypto` implementation does.
 */
import { randomUUID as nodeRandomUUID } from 'node:crypto';

export function randomUUID(): string {
  return nodeRandomUUID();
}
