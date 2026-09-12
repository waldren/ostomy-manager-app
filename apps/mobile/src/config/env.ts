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

import { z } from 'zod';

/**
 * The typed, schema-validated environment contract for @ostomy/mobile —
 * the same discipline `apps/api/src/config/env.schema.ts` applies, adapted
 * to how Expo actually supplies configuration: every `EXPO_PUBLIC_*`
 * variable is inlined into the JS bundle at build time by Metro, so this
 * reads `process.env` directly rather than a runtime-loaded `.env` file.
 *
 * Nothing OIDC-provider-specific is named here — issuer, client id,
 * audience and scopes are configuration, matching CLAUDE.md's "never
 * import a Cognito SDK" rule and this app's own `src/auth/oidcConfig.ts`,
 * which only ever speaks standard OIDC discovery.
 */

const envSchema = z.object({
  apiUrl: z.string().min(1, 'EXPO_PUBLIC_API_URL is required'),
  oidcIssuer: z.string().min(1, 'EXPO_PUBLIC_OIDC_ISSUER is required'),
  oidcClientId: z.string().min(1, 'EXPO_PUBLIC_OIDC_CLIENT_ID is required'),
  oidcAudience: z.string().min(1, 'EXPO_PUBLIC_OIDC_AUDIENCE is required'),
  oidcScopes: z.string().min(1, 'EXPO_PUBLIC_OIDC_SCOPES is required'),
});

export type MobileEnv = z.infer<typeof envSchema>;

let cached: MobileEnv | undefined;

/**
 * Parses `process.env` once and throws with a plain-language, field-named
 * error on first access if a required value is missing — fail loudly at
 * startup rather than produce a confusing runtime error deep inside the
 * auth or sync path. Cached because `process.env.EXPO_PUBLIC_*` reads are
 * static string replacements at bundle time (Metro), so re-parsing on every
 * call buys nothing.
 */
export function loadEnv(): MobileEnv {
  if (cached) return cached;

  const parsed = envSchema.safeParse({
    apiUrl: process.env.EXPO_PUBLIC_API_URL,
    oidcIssuer: process.env.EXPO_PUBLIC_OIDC_ISSUER,
    oidcClientId: process.env.EXPO_PUBLIC_OIDC_CLIENT_ID,
    oidcAudience: process.env.EXPO_PUBLIC_OIDC_AUDIENCE,
    oidcScopes: process.env.EXPO_PUBLIC_OIDC_SCOPES,
  });

  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => issue.message).join('; ');
    throw new Error(`Invalid mobile environment configuration: ${issues}`);
  }

  cached = parsed.data;
  return cached;
}

/** Test-only: clears the memoized value so a test can reset `process.env` between cases. */
export function resetEnvCacheForTests(): void {
  cached = undefined;
}
