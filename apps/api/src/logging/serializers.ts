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
 * Pino serializers used by `LoggingModule`. Split out of that module so each
 * one is independently unit-testable — the failure mode they exist to
 * prevent (a stray field carrying a rejected clinical value, a full
 * connection string, or a date-bearing query string) only shows up by
 * inspecting the exact shape of the object each serializer returns.
 */

interface SerializableRequest {
  id?: unknown;
  method: string;
  url: string;
  path?: string;
  route?: { path?: unknown };
}

interface SerializableResponse {
  statusCode: number;
}

/**
 * Named field set only: `id`, `method`, `path`, `route`.
 *
 * `req.url` on an Express request includes the query string — at P2 that is
 * `?from=2026-09-01&to=...`, and a date is HIPAA identifier #3. `req.path`
 * (Express-specific, present once the router has attached it) is the
 * pathname with no query string; `pathOnly()` is the fallback for the rare
 * case a raw `url` is all that's available. `route`, when the router has
 * matched one, is the *pattern* (`/api/v1/observations/:id`), not the
 * resolved id — useful for grouping log lines by endpoint without leaking
 * the identifier value.
 */
export function reqSerializer(req: SerializableRequest): {
  id: unknown;
  method: string;
  path: string;
  route: string | undefined;
} {
  return {
    id: req.id,
    method: req.method,
    path: req.path ?? pathOnly(req.url),
    route: typeof req.route?.path === 'string' ? req.route.path : undefined,
  };
}

export function resSerializer(res: SerializableResponse): { statusCode: number } {
  return { statusCode: res.statusCode };
}

/**
 * Fixed field set only: `type`, `message`, `code`, `statusCode`, `stack`.
 *
 * Pino's default `err` serializer copies every own enumerable property of
 * the error, which is unsafe here: a NestJS `HttpException.response` carries
 * the `ValidationPipe` message array — i.e. the rejected clinical value
 * itself — and a Prisma error carries `.meta`, `.query`, `.params`, which
 * can carry PHI-shaped column values. This serializer allow-lists instead,
 * so a new error subtype thrown somewhere in the app can never introduce a
 * new logged field just by having one.
 */
export function errSerializer(err: unknown): {
  type: string | undefined;
  message: string | undefined;
  code: string | number | undefined;
  statusCode: number | undefined;
  stack: string | undefined;
} {
  const candidate = (err ?? {}) as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    statusCode?: unknown;
    stack?: unknown;
  };

  return {
    type: typeof candidate.name === 'string' ? candidate.name : undefined,
    message: typeof candidate.message === 'string' ? candidate.message : undefined,
    code:
      typeof candidate.code === 'string' || typeof candidate.code === 'number'
        ? candidate.code
        : undefined,
    statusCode: typeof candidate.statusCode === 'number' ? candidate.statusCode : undefined,
    stack: typeof candidate.stack === 'string' ? candidate.stack : undefined,
  };
}

function pathOnly(url: string): string {
  const queryIndex = url.indexOf('?');
  return queryIndex === -1 ? url : url.slice(0, queryIndex);
}
