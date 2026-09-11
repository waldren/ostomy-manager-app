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

import { ZodError } from 'zod';

import { rawEnvSchema, type AppConfig } from './env.schema';
import { ConfigValidationError } from './config-validation.error';

/**
 * Reads `env` (defaults to `process.env`) into the typed `AppConfig` shape
 * and validates it against `rawEnvSchema`.
 *
 * This is deliberately synchronous and deliberately not routed through
 * `@nestjs/config`'s own validation hook: called before `NestFactory.create`
 * in `main.ts`, a missing or malformed variable fails loudly with a clear,
 * field-level message before any part of Nest — or a network listener —
 * starts. A misconfigured issuer must not degrade into "auth silently allows
 * everything"; failing to construct `AppConfig` at all is the only shape of
 * failure that cannot do that.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const raw = {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    oidcClockToleranceSeconds: env.OIDC_CLOCK_TOLERANCE_SECONDS,
    databaseUrl: env.DATABASE_URL,
    oidc: {
      issuer: env.OIDC_ISSUER,
      jwksUri: env.OIDC_JWKS_URI,
      audience: env.OIDC_AUDIENCE,
      claimMapping: {
        subjectClaim: env.OIDC_SUBJECT_CLAIM,
      },
    },
    adminOidc: {
      issuer: env.ADMIN_OIDC_ISSUER,
      jwksUri: env.ADMIN_OIDC_JWKS_URI,
      audience: env.ADMIN_OIDC_AUDIENCE,
      claimMapping: {
        subjectClaim: env.ADMIN_OIDC_SUBJECT_CLAIM,
      },
    },
    syncPushMaxOperations: env.SYNC_PUSH_MAX_OPERATIONS,
    syncDeltaDefaultLimit: env.SYNC_DELTA_DEFAULT_LIMIT,
    syncDeltaMaxLimit: env.SYNC_DELTA_MAX_LIMIT,
    objectStorage: {
      endpoint: env.OBJECT_STORAGE_ENDPOINT,
      region: env.OBJECT_STORAGE_REGION,
      accessKeyId: env.OBJECT_STORAGE_ACCESS_KEY_ID,
      secretAccessKey: env.OBJECT_STORAGE_SECRET_ACCESS_KEY,
      forcePathStyle: env.OBJECT_STORAGE_FORCE_PATH_STYLE,
    },
  };

  const result = rawEnvSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigValidationError(result.error);
  }

  // Reject silently-wrong-but-plausible config the schema cannot catch:
  // the patient and admin surfaces must never resolve to the same issuer,
  // audience, or JWKS endpoint, or the identity-layer boundary ADR-0008
  // requires is gone.
  //
  // Issuer comparison is on the *normalised* URL, not the raw string:
  // `https://idp/realms/x` and `https://idp/realms/x/` are the same issuer
  // to any OIDC-compliant verifier, and raw string equality would let that
  // trailing slash silently defeat this check.
  if (normalizedUrl(result.data.oidc.issuer) === normalizedUrl(result.data.adminOidc.issuer)) {
    throw new ConfigValidationError(
      makeCrossFieldError(
        'adminOidc.issuer',
        'must differ from oidc.issuer (SRS_v2 §4.6, ADR-0008)',
      ),
    );
  }
  if (result.data.oidc.audience === result.data.adminOidc.audience) {
    throw new ConfigValidationError(
      makeCrossFieldError(
        'adminOidc.audience',
        'must differ from oidc.audience (SRS_v2 §4.6, ADR-0008)',
      ),
    );
  }
  // Identical JWKS endpoints mean identical signing key material even if
  // the issuer and audience strings above happen to differ — i.e. one
  // identity pool wearing two audience strings, not two disjoint pools.
  if (normalizedUrl(result.data.oidc.jwksUri) === normalizedUrl(result.data.adminOidc.jwksUri)) {
    throw new ConfigValidationError(
      makeCrossFieldError(
        'adminOidc.jwksUri',
        'must differ from oidc.jwksUri — identical JWKS endpoints share signing key material (SRS_v2 §4.6, ADR-0008)',
      ),
    );
  }

  return result.data;
}

/**
 * Resolves an equivalent-but-differently-written URL (mismatched host
 * casing, an explicit default port, a trailing slash) to a single canonical
 * string, so two issuer/JWKS values a real OIDC verifier would treat as
 * identical cannot slip past raw string equality.
 *
 * `new URL(v).href` alone normalises casing and default ports, but — unlike
 * what its name suggests — does **not** collapse a trailing slash on a
 * non-root path: `new URL('https://idp/x').href` and
 * `new URL('https://idp/x/').href` are `https://idp/x` and `https://idp/x/`
 * respectively, still unequal. That trailing slash is exactly the
 * plausible-in-practice mistake this check exists to catch, so it is
 * stripped explicitly (the bare root path `/` is left alone: `https://idp`
 * and `https://idp/` are the same origin either way).
 */
function normalizedUrl(value: string): string {
  const url = new URL(value);
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1);
  }
  return url.href;
}

/** Builds a `ConfigValidationError`-compatible ZodError for a cross-field rule that `.safeParse` cannot express as a single-field check. */
function makeCrossFieldError(path: string, message: string): ZodError {
  return new ZodError([
    {
      code: 'custom',
      path: path.split('.'),
      message,
      input: undefined,
    },
  ]);
}
