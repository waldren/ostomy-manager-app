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

import { describe, expect, it } from 'vitest';

import { ConfigValidationError } from './config-validation.error';
import { loadConfig } from './load-config';

function validEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    PORT: '4000',
    LOG_LEVEL: 'warn',
    OIDC_ISSUER: 'https://mock-oidc.test/patient-issuer',
    OIDC_JWKS_URI: 'https://mock-oidc.test/patient-issuer/jwks',
    OIDC_AUDIENCE: 'ostomy-patient-app',
    ADMIN_OIDC_ISSUER: 'https://mock-oidc.test/admin-issuer',
    ADMIN_OIDC_JWKS_URI: 'https://mock-oidc.test/admin-issuer/jwks',
    ADMIN_OIDC_AUDIENCE: 'ostomy-admin-console',
    OBJECT_STORAGE_ENDPOINT: 'http://localhost:9000',
    OBJECT_STORAGE_REGION: 'us-east-1',
    OBJECT_STORAGE_ACCESS_KEY_ID: 'test-access-key',
    OBJECT_STORAGE_SECRET_ACCESS_KEY: 'test-secret-key',
    OBJECT_STORAGE_FORCE_PATH_STYLE: 'true',
    DATABASE_URL: 'postgresql://ostomy_runtime:test-password@localhost:5432/ostomy_test',
  };
}

describe('loadConfig', () => {
  it('parses a fully-specified, valid environment', () => {
    const config = loadConfig(validEnv());

    expect(config.port).toBe(4000);
    expect(config.logLevel).toBe('warn');
    expect(config.oidc.issuer).toBe('https://mock-oidc.test/patient-issuer');
    expect(config.oidc.claimMapping.subjectClaim).toBe('sub');
    expect(config.objectStorage.forcePathStyle).toBe(true);
  });

  it('applies defaults for optional variables', () => {
    const env = validEnv();
    delete env.PORT;
    delete env.LOG_LEVEL;
    delete env.NODE_ENV;
    delete env.OIDC_CLOCK_TOLERANCE_SECONDS;

    const config = loadConfig(env);

    expect(config.port).toBe(3000);
    expect(config.logLevel).toBe('info');
    expect(config.nodeEnv).toBe('development');
    expect(config.oidcClockToleranceSeconds).toBe(30);
  });

  it('parses an overridden clock tolerance', () => {
    const env = validEnv();
    env.OIDC_CLOCK_TOLERANCE_SECONDS = '60';

    const config = loadConfig(env);

    expect(config.oidcClockToleranceSeconds).toBe(60);
  });

  it('fails with a clear, field-naming message when a required variable is missing', () => {
    const env = validEnv();
    delete env.OIDC_ISSUER;

    expect(() => loadConfig(env)).toThrow(ConfigValidationError);
    try {
      loadConfig(env);
      expect.unreachable('loadConfig should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as Error).message).toContain('oidc.issuer');
    }
  });

  it('fails when a boolean-shaped variable is malformed', () => {
    const env = validEnv();
    env.OBJECT_STORAGE_FORCE_PATH_STYLE = 'sometimes';

    expect(() => loadConfig(env)).toThrow(ConfigValidationError);
  });

  it('parses the runtime-role database URL (ADR-0011 — never the owner/migration DSN)', () => {
    const config = loadConfig(validEnv());

    expect(config.databaseUrl).toBe(
      'postgresql://ostomy_runtime:test-password@localhost:5432/ostomy_test',
    );
  });

  it('fails with a clear, field-naming message when DATABASE_URL is missing', () => {
    const env = validEnv();
    delete env.DATABASE_URL;

    try {
      loadConfig(env);
      expect.unreachable('loadConfig should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as Error).message).toContain('databaseUrl');
    }
  });

  it('fails when the patient and admin issuers are the same — the identity-layer boundary must not degrade to a single OIDC config by accident', () => {
    const env = validEnv();
    env.ADMIN_OIDC_ISSUER = env.OIDC_ISSUER;

    expect(() => loadConfig(env)).toThrow(ConfigValidationError);
  });

  it('fails when the patient and admin issuers are the same modulo a trailing slash — raw string equality must not be what this check relies on', () => {
    const env = validEnv();
    env.ADMIN_OIDC_ISSUER = `${env.OIDC_ISSUER}/`;

    expect(() => loadConfig(env)).toThrow(ConfigValidationError);
  });

  it('fails when the patient and admin audiences are the same', () => {
    const env = validEnv();
    env.ADMIN_OIDC_AUDIENCE = env.OIDC_AUDIENCE;

    expect(() => loadConfig(env)).toThrow(ConfigValidationError);
  });

  it('fails when the patient and admin JWKS endpoints are the same, even with different issuers and audiences — identical signing key material is one pool wearing two names', () => {
    const env = validEnv();
    env.ADMIN_OIDC_JWKS_URI = env.OIDC_JWKS_URI;

    expect(() => loadConfig(env)).toThrow(ConfigValidationError);
  });

  it('never includes a secret value in the thrown message, even when a different field is what actually failed validation', () => {
    const env = validEnv();
    // A distinctive, non-empty sentinel — not an empty string. The point of
    // this test is that a *valid-looking* secret never leaks when some
    // unrelated field fails; asserting on an empty string would trivially
    // pass no matter how the error message were built.
    const secretSentinel = 'sentinel-should-never-appear-nc7x9k2p';
    env.OBJECT_STORAGE_SECRET_ACCESS_KEY = secretSentinel;
    env.OIDC_ISSUER = 'not a valid url';

    try {
      loadConfig(env);
      expect.unreachable('loadConfig should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toContain(secretSentinel);
    }
  });
});
