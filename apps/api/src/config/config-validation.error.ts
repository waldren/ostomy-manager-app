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

import type { ZodError } from 'zod';

/**
 * Thrown by `loadConfig` when required environment variables are missing or
 * malformed. The message lists field paths and rule descriptions only —
 * never the offending value — for the same reason a validation error must
 * never echo a clinical value (docs/security-hipaa.md "Never log PHI"):
 * several of these fields (`objectStorage.secretAccessKey`) are secrets, and
 * a startup log is not a safe place for one.
 */
export class ConfigValidationError extends Error {
  constructor(zodError: ZodError) {
    const issues = zodError.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    super(`Invalid or missing configuration:\n${issues}`);
    this.name = 'ConfigValidationError';
  }
}
