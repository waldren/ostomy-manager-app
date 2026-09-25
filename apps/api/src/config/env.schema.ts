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

/**
 * A browser **origin** — scheme + host + port, and nothing else.
 *
 * Validated with `new URL(value).origin === value`, which rejects the three
 * mistakes that otherwise fail silently: a trailing slash
 * (`http://localhost:8088/`), a path (`http://localhost:8088/app`), and a
 * query or fragment. The `Origin` header a browser sends carries none of
 * those, so any of them produces an allowlist entry that can never match
 * and presents as "CORS is broken" with nothing naming the cause.
 */
function originString(fieldLabel: string) {
  return z
    .string()
    .min(1, `${fieldLabel} is required`)
    .refine(
      (value) => {
        try {
          return new URL(value).origin === value;
        } catch {
          return false;
        }
      },
      {
        message: `${fieldLabel} must be a bare origin (scheme://host[:port]), with no trailing slash or path`,
      },
    );
}

/**
 * The origins allowed to read responses from this API in a browser.
 *
 * **There is deliberately no wildcard, and no way to express one.** This API
 * serves PHI; `Access-Control-Allow-Origin: *` would let any page on the
 * internet read a patient's clinical values with a token it had obtained by
 * any means. An unset or empty value means **no cross-origin access at
 * all** — the safe direction, and the same default the API had before CORS
 * existed here.
 *
 * Comma-separated, because that is what an environment variable can carry.
 * Blank entries are dropped so a trailing comma is not an error.
 */
const corsAllowedOrigins = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  )
  .pipe(z.array(originString('CORS_ALLOWED_ORIGINS entry')));

export const rawEnvSchema = z.object({
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  /**
   * The commit this image was built from, stamped in at build time.
   *
   * Exists so "what is actually running" is answerable without shell access to
   * the host. #76: the development stack sat three merges behind `main` with
   * nothing surfacing it, because the only way to tell was to inspect the
   * container by hand — and a deploy that never ran looks exactly like one that
   * did.
   *
   * Optional, and absent is a legitimate state: a locally-run `pnpm start` has
   * no build step to stamp it. `/health` reports `null` rather than pretending.
   */
  buildCommit: z.string().trim().min(1).optional(),
  port: z.coerce.number().int().positive().default(3000),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // jose defaults to zero clock-skew tolerance. Fargate host clocks and
  // mobile-device clocks both drift; without this, `exp`/`iat`/`nbf` checks
  // produce 401s that look random rather than a legitimate, boundable skew.
  // Not admin-managed configuration (unlike clinical thresholds) — this is
  // ordinary server tuning, not something a clinician needs to change.
  oidcClockToleranceSeconds: z.coerce.number().int().nonnegative().default(30),

  // Browser origins allowed to read responses from this API. Empty by
  // default, which means no cross-origin access — see `corsAllowedOrigins`.
  //
  // This is NOT the admin/patient boundary and must never be mistaken for
  // it. That boundary is the two disjoint identity pools and the
  // structurally separate guards (SRS_v2 §4.6): listing the admin console's
  // origin here does not let a patient token reach `/api/v1/admin/...`,
  // because `AdminJwtAuthGuard` rejects it on audience and issuer. Removing
  // an origin from this list is a browser-access change, not a
  // security-boundary change.
  corsAllowedOrigins,

  oidc: oidcSchema,
  adminOidc: oidcSchema,

  // The RUNTIME role's DSN (ADR-0011) — the only one the running API
  // process ever connects with. The migration/owner role's DSN is a
  // separate, CLI-only concern (apps/api/prisma.config.ts,
  // infra/docker-compose.yml's `migrate` service); it is never read by
  // application code, so it has no field here.
  databaseUrl: urlString('databaseUrl'),

  /**
   * Sync transport bounds (`docs/sync-contract.md` §3.3, §5.1).
   *
   * Ordinary configuration, deliberately NOT `validation_thresholds` rows:
   * these bound the transport, not a clinical judgement. An admin lowering
   * the batch size changes how many operations fit in one request; it does
   * not change what counts as a plausible stoma output. `packages/core/src/sync`
   * names none of them for the same reason — §5.1's own comment calls them
   * "server configuration".
   *
   * `syncClockSkewAllowanceSeconds` is the exception and is NOT here: §3.8
   * makes it an admin-managed threshold read from `validation_thresholds`,
   * because it is the same clinical quantity as `maxClockSkewMs` and both
   * must derive from one row.
   */
  syncPushMaxOperations: z.coerce.number().int().positive().default(500),
  syncDeltaDefaultLimit: z.coerce.number().int().positive().default(200),
  syncDeltaMaxLimit: z.coerce.number().int().positive().default(1000),

  objectStorage: z.object({
    endpoint: urlString('endpoint'),
    region: z.string().min(1, 'region is required'),
    accessKeyId: z.string().min(1, 'accessKeyId is required'),
    secretAccessKey: z.string().min(1, 'secretAccessKey is required'),
    forcePathStyle: booleanFromString,
  }),
});

export type AppConfig = z.infer<typeof rawEnvSchema>;
