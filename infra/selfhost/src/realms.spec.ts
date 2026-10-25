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
 * The committed realm files, read as data (RD-16). What Keycloak actually does
 * with them is `apps/api/src/auth/keycloak-realm.integration.spec.ts`, which
 * imports them into the pinned image and signs in. This file catches an edit
 * in review time, without Docker.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { SELFHOST_ROOT } from './compose-file';

interface Client {
  clientId: string;
  publicClient?: boolean;
  directAccessGrantsEnabled?: boolean;
  implicitFlowEnabled?: boolean;
  serviceAccountsEnabled?: boolean;
  redirectUris?: string[];
  attributes?: Record<string, string>;
  defaultClientScopes?: string[];
  protocolMappers?: { protocolMapper: string; config: Record<string, string> }[];
}

interface Realm {
  realm: string;
  sslRequired: string;
  registrationAllowed: boolean;
  resetPasswordAllowed: boolean;
  bruteForceProtected: boolean;
  passwordPolicy: string;
  revokeRefreshToken: boolean;
  refreshTokenMaxReuse: number;
  browserFlow?: string;
  clients: Client[];
  requiredActions?: { alias: string; enabled: boolean }[];
  authenticationFlows?: {
    alias: string;
    authenticationExecutions: { authenticator?: string; requirement: string }[];
  }[];
}

const read = (name: string) =>
  JSON.parse(
    readFileSync(path.join(SELFHOST_ROOT, 'keycloak/realms', `${name}-realm.json`), 'utf8'),
  ) as Realm;

const realms = { patient: read('patient'), admin: read('admin') };
const appClients = {
  patient: ['ostomy-patient-app', 'ostomy-web'],
  admin: ['ostomy-admin-console'],
};

describe.each(Object.entries(realms))('the %s realm', (name, realm) => {
  it('is named for its file', () => {
    expect(realm.realm).toBe(name);
  });

  it('has brute-force detection, a password policy, rotating refresh tokens, and no self-service', () => {
    expect(realm).toMatchObject({
      sslRequired: 'external',
      registrationAllowed: false,
      resetPasswordAllowed: false,
      bruteForceProtected: true,
      revokeRefreshToken: true,
      refreshTokenMaxReuse: 0,
    });
    expect(realm.passwordPolicy).toMatch(/^length\(1[2-9]\)/);
  });

  it('lets no client it declares take a password grant, a service account or an implicit flow', () => {
    for (const client of realm.clients) {
      expect(client).toMatchObject({
        directAccessGrantsEnabled: false,
        serviceAccountsEnabled: false,
        implicitFlowEnabled: false,
      });
    }
  });

  it('makes each app client public, PKCE-only, with exact redirects', () => {
    const declared = realm.clients.filter((client) =>
      appClients[name as keyof typeof appClients].includes(client.clientId),
    );
    expect(declared.map((client) => client.clientId)).toEqual(
      appClients[name as keyof typeof appClients],
    );
    for (const client of declared) {
      expect(client.publicClient).toBe(true);
      expect(client.attributes?.['pkce.code.challenge.method']).toBe('S256');
      for (const uri of client.redirectUris ?? []) {
        expect(uri).not.toContain('*');
      }
    }
  });

  /**
   * ADR-0022 item 5: the API's audience comes from a mapper on each app client
   * and never from a client scope, so a built-in client cannot carry it. And
   * no app client takes the `roles` scope, whose audience-resolve mapper adds
   * `account` to `aud`.
   */
  it('puts the API audience in access tokens through each app client’s own mapper', () => {
    for (const client of realm.clients) {
      if (!appClients[name as keyof typeof appClients].includes(client.clientId)) continue;
      const audiences = (client.protocolMappers ?? []).filter(
        (mapper) => mapper.protocolMapper === 'oidc-audience-mapper',
      );
      expect(audiences).toHaveLength(1);
      expect(audiences[0]!.config).toMatchObject({
        'access.token.claim': 'true',
        'id.token.claim': 'false',
      });
      expect(client.defaultClientScopes).not.toContain('roles');
      expect(client.defaultClientScopes).not.toContain('profile');
      expect(client.defaultClientScopes).not.toContain('email');
    }
  });
});

describe('the admin realm’s sign-in', () => {
  const admin = realms.admin;

  /**
   * Keycloak's default browser flow makes OTP conditional, which signs in an
   * account with no OTP configured on its password alone (ADR-0022 item 5).
   */
  it('requires a password and OTP, neither conditional', () => {
    const flow = admin.authenticationFlows!.find((f) => f.alias === admin.browserFlow);
    expect(flow).toBeDefined();
    const forms = admin.authenticationFlows!.find((f) => f.alias === 'admin browser forms')!;
    expect(forms.authenticationExecutions).toEqual([
      expect.objectContaining({
        authenticator: 'auth-username-password-form',
        requirement: 'REQUIRED',
      }),
      expect.objectContaining({ authenticator: 'auth-otp-form', requirement: 'REQUIRED' }),
    ]);
    const requirements = admin
      .authenticationFlows!.flatMap((f) => f.authenticationExecutions)
      .map((execution) => execution.requirement);
    expect(requirements).not.toContain('CONDITIONAL');
  });

  /** So an account is never enrolled by whoever first holds its password. */
  it('turns off OTP enrolment at sign-in', () => {
    expect(admin.requiredActions).toContainEqual(
      expect.objectContaining({ alias: 'CONFIGURE_TOTP', enabled: false }),
    );
  });
});
