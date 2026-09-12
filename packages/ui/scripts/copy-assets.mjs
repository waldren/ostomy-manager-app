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

// `tsc` only emits .ts/.tsx — it never touches styles.css. This copies the
// one plain stylesheet the built components' classNames depend on into
// dist/, alongside the compiled JS, so `./styles.css` (package.json's
// "exports" entry) resolves to something that exists after `pnpm build`.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '../src/styles.css');
const dest = resolve(here, '../dist/styles.css');

mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
