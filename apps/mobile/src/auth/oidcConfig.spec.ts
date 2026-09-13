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

import { resetEnvCacheForTests } from '../config/env';

import { getOidcClientConfig } from './oidcConfig';

describe('getOidcClientConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetEnvCacheForTests();
    process.env.EXPO_PUBLIC_API_URL = 'http://localhost:3000';
    process.env.EXPO_PUBLIC_OIDC_ISSUER = 'http://localhost:8090/patient-issuer';
    process.env.EXPO_PUBLIC_OIDC_CLIENT_ID = 'ostomy-patient-app';
    process.env.EXPO_PUBLIC_OIDC_AUDIENCE = 'ostomy-patient-app';
    process.env.EXPO_PUBLIC_OIDC_SCOPES = 'openid profile offline_access';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetEnvCacheForTests();
  });

  it('splits scopes on whitespace into an array', () => {
    const config = getOidcClientConfig();
    expect(config.scopes).toEqual(['openid', 'profile', 'offline_access']);
  });

  it('carries the issuer, clientId, and audience through unchanged', () => {
    const config = getOidcClientConfig();
    expect(config.issuer).toBe('http://localhost:8090/patient-issuer');
    expect(config.clientId).toBe('ostomy-patient-app');
    expect(config.audience).toBe('ostomy-patient-app');
  });
});
