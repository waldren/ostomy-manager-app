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

const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// pnpm workspace: dependencies live in the workspace root's node_modules
// (hoisted) as well as this app's own, and `@ostomy/core` is a sibling
// workspace package, not something installed under apps/mobile/node_modules
// at all — Metro must watch the monorepo root to find it.
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// `@ostomy/core` (ADR-0007) has no root "." export and ships five
// independent subpath exports only (./units, /validation, /hydration,
// /i18n, /sync) — no legacy `main` fallback. Metro's default resolver does
// not read a package's `exports` map unless this is turned on, and without
// it every `@ostomy/core/validation`-shaped import in this app fails to
// resolve even though `tsc` (which does read `exports`) is satisfied.
config.resolver.unstable_enablePackageExports = true;
config.resolver.unstable_conditionNames = ['react-native', 'require', 'default'];

module.exports = config;
