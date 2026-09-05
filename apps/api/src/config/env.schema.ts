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
 * The typed, schema-validated environment contract for @ostomy/api.
 *
 * Every field here is configuration in the sense CLAUDE.md and SRS_v2 §4.3
 * mean it: nothing about a specific identity or storage provider is baked
 * in. `oidc` and `adminOidc` are two independent, identically-shaped OIDC
 * descriptors (issuer, JWKS URI, audience, claim mapping) — the API only
 * ever talks to whatever standard OIDC issuer each one names, whether that
 * is the mock-oauth2-server in development or the production identity
 * provider's user pool. Never add a vendor-specific field here; that would
 * defeat the whole point of the adapter.
 */
import { z } from 'zod';

/**
 * `z.string().url()` varies in strictness across zod major versions. A
 * direct `URL` construction check is unambiguous and version-stable, and is
 * arguably more correct anyway since it is the same parser Node uses.
 */
function urlString(fieldLabel: string) {
  return z
    .string()
    .min(1, `${fieldLabel} is required`)
    .refine(
      (value) => {
        try {
          new URL(value);
          return true;
        } catch {
          return false;
        }
      },
      { message: `${fieldLabel} must be a valid URL` },
    );
}

const oidcSchema = z.object({
  issuer: urlString('issuer'),
  jwksUri: urlString('jwksUri'),
  audience: z.string().min(1, 'audience is required'),
  claimMapping: z.object({
    subjectClaim: z.string().min(1).default('sub'),
  }),
});

export type OidcConfig = z.infer<typeof oidcSchema>;

const booleanFromString = z.enum(['true', 'false']).transform((value) => value === 'true');

export const rawEnvSchema = z.object({
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  port: z.coerce.number().int().positive().default(3000),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  oidc: oidcSchema,
  adminOidc: oidcSchema,

  objectStorage: z.object({
    endpoint: urlString('endpoint'),
    region: z.string().min(1, 'region is required'),
    accessKeyId: z.string().min(1, 'accessKeyId is required'),
    secretAccessKey: z.string().min(1, 'secretAccessKey is required'),
    forcePathStyle: booleanFromString,
  }),
});

export type AppConfig = z.infer<typeof rawEnvSchema>;
