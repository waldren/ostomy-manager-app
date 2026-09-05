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
 * Defence-in-depth redaction paths for the Pino logger (docs/security-hipaa.md
 * "Never log PHI"). The primary control is `logging.module.ts`'s request/
 * response serializers, which never assemble a body or header object into
 * the log entry in the first place — there is no field for these paths to
 * redact in the common case. This list exists for the paths a future
 * `logger.info({...})` call elsewhere in the app might still construct by
 * hand, so a credential-shaped field is scrubbed even if someone bypasses the
 * serializer.
 *
 * Extend this list rather than adding a second redaction mechanism — the
 * P1.S5 audit interceptor and any later Sentry `beforeSend` hook should read
 * from here, not maintain their own copy.
 */
export const PHI_REDACTION_PATHS: readonly string[] = [
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
