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

import type { Request } from 'express';

/**
 * `pino-http` (wired via `LoggingModule`) already assigns `req.id` to every
 * request — this file exists only to give application code a typed,
 * discoverable way to read it, instead of every future handler reaching for
 * an untyped `(request as any).id`.
 *
 * Establishing this now, ahead of any code that needs it, matters because
 * sync (P2) is a batch endpoint: one HTTP request produces N audit rows, and
 * a last-write-wins conflict loser produces an audit row with no HTTP
 * request of its own. Both cases need a stable correlation id to tie those
 * rows back to the request that produced them — retrofitting that id onto
 * an existing audit schema is far more expensive than reading it from here
 * from the start.
 */
declare module 'express-serve-static-core' {
  interface Request {
    id?: string | number;
  }
}

/** Returns the request's correlation id as a string, or `undefined` if the logging pipeline hasn't assigned one (should not happen once `LoggingModule` is wired — see its `pinoHttp` config). */
export function getRequestId(request: Request): string | undefined {
  return request.id === undefined ? undefined : String(request.id);
}
