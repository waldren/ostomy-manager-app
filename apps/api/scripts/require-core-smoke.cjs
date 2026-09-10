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

// ADR-0010 proof, run for real rather than inferred from a green test suite.
//
// apps/api is a CommonJS workspace ("type": "commonjs"). packages/core is
// ESM ("type": "module") and is the first ESM package apps/api imports.
// That import path depends on Node's require(esm), stable since Node
// 22.12, which throws ERR_REQUIRE_ASYNC_MODULE if the required module's
// entry graph contains top-level await anywhere. Vitest transforms
// everything to ESM and never exercises this path — a regression here
// would leave `pnpm verify`'s test step green and only fail when the
// built API actually starts (first on the dev host, or worse, in a
// container at P9).
//
// This file is plain CommonJS, run with plain `node` (not compiled, not
// bundled), from inside apps/api, resolving `@ostomy/core`'s subpaths
// through apps/api's own node_modules (pnpm workspace link) exactly the
// way the running API would. If any of these five `require()` calls ever
// throws, this script's non-zero exit fails `pnpm verify`.
//
// `require()` here is the point of the file, not a style slip — the
// no-require-imports rule exists for ordinary TypeScript source, which
// this deliberately is not.
/* eslint-disable @typescript-eslint/no-require-imports */
require('@ostomy/core/validation');
require('@ostomy/core/units');
require('@ostomy/core/hydration');
require('@ostomy/core/i18n');
require('@ostomy/core/sync');
