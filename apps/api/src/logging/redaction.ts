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
 * Defence-in-depth redaction paths for the Pino logger. The primary control
 * is `logging/serializers.ts`, whose request/response/error serializers
 * name an exact, fixed field set and never assemble a request body, sync
 * payload, or entity contents into a log entry in the first place — there is
 * no field for these paths to redact in the common case.
 *
 * This module is deliberately two separate lists, not one, because they were
 * previously conflated under a single misleading name (`PHI_REDACTION_PATHS`)
 * that contained no PHI paths — only credentials. Docs describing this file
 * as a "PHI-scrubbing logger" were wrong for the same reason: nothing here
 * scrubs PHI out of an assembled payload, because no PHI payload is ever
 * assembled into a log line to begin with. Do not restore that framing.
 *
 * IMPORTANT — pino `redact` path wildcards are single-level: `*.token`
 * matches `foo.token` but not `foo.bar.token`. That is fine for the fields
 * the serializers might log by hand today, but it will not hold against an
 * arbitrarily-nested sync payload (P2) if one is ever logged directly
 * instead of through a typed serializer. This deny-list is a second line of
 * defence, not the control to lean on for nested, attacker/client-shaped
 * data — an allow-list (as `serializers.ts` already does for req/res/err) or
 * a typed logger wrapper is the version of this that survives that case.
 */

/** Credential-shaped fields: API keys, tokens, and secrets. Never PHI. */
export const CREDENTIAL_REDACTION_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'password',
  '*.password',
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'secretAccessKey',
  '*.secretAccessKey',
  'clientSecret',
  '*.clientSecret',
];

/**
 * PHI-shaped fields: request/response bodies, sync payloads, and verified
 * JWT claims (which routinely carry email, phone_number, birthdate, and
 * name — see `auth/patient-actor.ts` for why those never reach the request
 * object in the first place; this is the second line of defence, not the
 * first, for the same reason described above).
 */
export const PHI_SHAPED_REDACTION_PATHS: readonly string[] = [
  'err.response',
  'err.meta',
  'err.query',
  'err.params',
  'body',
  '*.body',
  'payload',
  '*.payload',
  'claims',
  '*.claims',
];
