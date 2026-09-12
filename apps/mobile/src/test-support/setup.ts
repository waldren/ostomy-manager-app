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

// `jest.config.js`'s `setupFilesAfterEnv` entry. Empty beyond this comment
// today — `jest-expo`'s own preset already supplies the native-module
// mocks every spec file in this app relies on (see individual
// `jest.mock('expo-*', ...)` calls for the behaviour each test actually
// needs beyond "does not crash on import"). Kept as a real file, not
// deleted, because P2.S2b's sync-worker tests are the likely first place
// this needs a real global (e.g. a fake-timers default, or a shared
// `expo-notifications` mock) — one place to add it rather than
// re-discovering the setup-file wiring at that point.
export {};
