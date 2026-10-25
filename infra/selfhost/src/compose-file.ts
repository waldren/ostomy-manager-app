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

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

/** `infra/selfhost/`. */
export const SELFHOST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface ComposeService {
  image?: string;
  build?: unknown;
  environment?: Record<string, string | null>;
  secrets?: string[];
  ports?: string[];
  networks?: string[];
  command?: string[] | string;
  entrypoint?: string[] | string;
  logging?: { driver: string; options: Record<string, string> };
  security_opt?: string[];
  restart?: string;
}

export interface ComposeFile {
  services: Record<string, ComposeService>;
  networks: Record<string, { internal?: boolean } | null>;
  secrets: Record<string, { file: string }>;
}

/** `compose.yml`, parsed with its anchors and merge keys resolved. */
export function readComposeFile(): ComposeFile {
  return parse(readFileSync(path.join(SELFHOST_ROOT, 'compose.yml'), 'utf8'), {
    merge: true,
  }) as ComposeFile;
}

/** The Caddy image the stack runs, so the allowlist test runs the same one. */
export const CADDY_IMAGE = readComposeFile().services.caddy!.image!;
