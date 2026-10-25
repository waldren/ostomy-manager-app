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
 * The API's two guards against tokens a real Keycloak mints from the committed
 * realm exports (D.S1 slice 2, ADR-0022 item 5).
 *
 * Every other auth test signs its own tokens, so it proves the guards follow
 * their configuration and nothing about whether that configuration matches
 * what an issuer actually sends. This one starts the pinned Keycloak image,
 * imports `infra/selfhost/keycloak/realms/` exactly as the self-hosted stack
 * does, signs in through the browser flow over HTTP the way a phone does, and
 * hands the results to `JwtAuthGuard` and `AdminJwtAuthGuard` configured with
 * the environment `infra/selfhost/compose.yml` gives the API.
 *
 * Nothing here holds a real credential: the users and passwords are created by
 * the test and destroyed with the container.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';

import { createRemoteJWKSet, decodeJwt, decodeProtectedHeader } from 'jose';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ADMIN_AUTH_ERROR_CODE, AdminJwtAuthGuard } from '../admin/admin-jwt-auth.guard';
import type { AppConfig } from '../config/env.schema';
import { loadConfig } from '../config/load-config';
import {
  createHttpExecutionContext,
  requestWithAuthHeader,
} from '../test-support/execution-context';
import { AUTH_ERROR_CODE, JwtAuthGuard } from './jwt-auth.guard';

function isDockerAvailable(): boolean {
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], {
      stdio: 'ignore',
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

const dockerAvailable = isDockerAvailable();
if (!dockerAvailable) {
  if (process.env.CI) {
    throw new Error(
      '[keycloak-realm.integration.spec.ts] Docker is not reachable, but CI is set — ' +
        'refusing to silently skip.',
    );
  }
  // eslint-disable-next-line no-console
  console.warn('[keycloak-realm.integration.spec.ts] Docker is not reachable — skipping.');
}

/** Must match `infra/selfhost/compose.yml`'s `keycloak` image. */
const KEYCLOAK_IMAGE =
  'quay.io/keycloak/keycloak:26.7@sha256:37dbaf6f0722c9ec246335f36e1ef8b2e6cb960f7c27e0d8c615121a3d475a85';
const REALMS_DIR = path.resolve(__dirname, '../../../../infra/selfhost/keycloak/realms');

/**
 * The public URL Keycloak is told it lives at. Strict hostname checking means
 * every issuer and form action carries this, whatever URL the request used,
 * which is exactly the property the stack depends on. The test reaches the
 * container on a mapped port and rewrites this origin to it.
 */
const PUBLIC_AUTH_ORIGIN = 'https://auth.ostomy.test';
const WEB_ORIGIN = 'https://ostomy.test';
const ADMIN_ORIGIN = 'https://admin.ostomy.test';
const MOBILE_REDIRECT = 'ostomydiary://redirect';
const BOOTSTRAP_ADMIN = { username: 'bootstrap', password: 'bootstrap-test-only-password' };

/** The API environment `infra/selfhost/compose.yml` sets, with the JWKS reached through the mapped port. */
function apiConfig(internalOrigin: string): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://ostomy_runtime:unused@localhost:5432/unused',
    OIDC_ISSUER: `${PUBLIC_AUTH_ORIGIN}/realms/patient`,
    OIDC_JWKS_URI: `${internalOrigin}/realms/patient/protocol/openid-connect/certs`,
    OIDC_AUDIENCE: 'ostomy-patient-app',
    OIDC_SUBJECT_CLAIM: 'sub',
    OIDC_TOKEN_USE_CLAIM: 'typ',
    OIDC_REQUIRED_TOKEN_USE: 'Bearer',
    ADMIN_OIDC_ISSUER: `${PUBLIC_AUTH_ORIGIN}/realms/admin`,
    ADMIN_OIDC_JWKS_URI: `${internalOrigin}/realms/admin/protocol/openid-connect/certs`,
    ADMIN_OIDC_AUDIENCE: 'ostomy-admin-console',
    ADMIN_OIDC_SUBJECT_CLAIM: 'sub',
    ADMIN_OIDC_TOKEN_USE_CLAIM: 'typ',
    ADMIN_OIDC_REQUIRED_TOKEN_USE: 'Bearer',
    OBJECT_STORAGE_ENDPOINT: 'http://object-storage.invalid',
    OBJECT_STORAGE_REGION: 'unused',
    OBJECT_STORAGE_ACCESS_KEY_ID: 'unused',
    OBJECT_STORAGE_SECRET_ACCESS_KEY: 'unused',
    OBJECT_STORAGE_FORCE_PATH_STYLE: 'true',
  });
}

const base64url = (buffer: Buffer): string => buffer.toString('base64url');

/** RFC 6238 TOTP, as Keycloak computes it: HMAC-SHA1 over the secret string's bytes, 30 s, 6 digits. */
function totp(secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const digest = createHmac('sha1', Buffer.from(secret, 'utf8')).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return value.toString().padStart(6, '0');
}

interface TokenResponse {
  access_token: string;
  id_token?: string;
  refresh_token?: string;
  scope?: string;
}

/** Outcome of driving the browser flow: a code, an OAuth error, or the page Keycloak showed instead. */
type SignInOutcome =
  | { kind: 'code'; code: string }
  | { kind: 'error'; error: string }
  | { kind: 'page'; html: string };

class KeycloakDriver {
  constructor(private readonly origin: string) {}

  /** Rewrites Keycloak's public origin to the reachable one, so form actions can be followed. */
  private reachable(url: string): string {
    return url.replace(PUBLIC_AUTH_ORIGIN, this.origin);
  }

  async adminToken(): Promise<string> {
    const response = await fetch(`${this.origin}/realms/master/protocol/openid-connect/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'admin-cli',
        username: BOOTSTRAP_ADMIN.username,
        password: BOOTSTRAP_ADMIN.password,
      }),
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as TokenResponse).access_token;
  }

  async admin<T>(method: string, apiPath: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.origin}/admin/realms${apiPath}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.adminToken()}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      throw new Error(`${method} ${apiPath} answered ${response.status}: ${await response.text()}`);
    }
    const text = await response.text();
    return (text === '' ? undefined : JSON.parse(text)) as T;
  }

  async createUser(
    realm: string,
    username: string,
    credentials: Record<string, unknown>[],
  ): Promise<void> {
    await this.admin('POST', `/${realm}/users`, {
      username,
      enabled: true,
      email: `${username}@example.test`,
      emailVerified: true,
      credentials,
    });
  }

  /**
   * The authorization-code + PKCE flow, driven over HTTP: open the login page,
   * post the password (and a one-time code if asked), and stop at the redirect.
   */
  async signIn(options: {
    realm: string;
    clientId: string;
    redirectUri: string;
    username: string;
    password: string;
    scope?: string;
    otpSecret?: string;
  }): Promise<{ outcome: SignInOutcome; verifier: string }> {
    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    const state = base64url(randomBytes(16));
    const cookies = new Map<string, string>();

    const send = async (url: string, form?: Record<string, string>): Promise<Response> => {
      const response = await fetch(this.reachable(url), {
        method: form ? 'POST' : 'GET',
        redirect: 'manual',
        headers: {
          cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
        },
        ...(form ? { body: new URLSearchParams(form) } : {}),
      });
      for (const header of response.headers.getSetCookie()) {
        const [pair] = header.split(';');
        const index = pair!.indexOf('=');
        cookies.set(pair!.slice(0, index), pair!.slice(index + 1));
      }
      return response;
    };

    const authorize = new URL(
      `${PUBLIC_AUTH_ORIGIN}/realms/${options.realm}/protocol/openid-connect/auth`,
    );
    authorize.search = new URLSearchParams({
      client_id: options.clientId,
      redirect_uri: options.redirectUri,
      response_type: 'code',
      scope: options.scope ?? 'openid',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();

    let response = await send(authorize.toString());
    if (response.status === 302) {
      // Refused before any page: an OAuth error on the redirect.
      const refused = new URL(response.headers.get('location')!);
      return { outcome: { kind: 'error', error: refused.searchParams.get('error')! }, verifier };
    }
    let html = await response.text();
    response = await send(formAction(html), {
      username: options.username,
      password: options.password,
      credentialId: '',
    });
    if (response.status === 200 && options.otpSecret !== undefined) {
      html = await response.text();
      if (html.includes('name="otp"')) {
        response = await send(formAction(html), { otp: totp(options.otpSecret) });
      } else {
        return { outcome: { kind: 'page', html }, verifier };
      }
    }
    // A redirect within Keycloak (a required action) is followed to its page.
    while (
      response.status === 302 &&
      response.headers.get('location')!.includes('/login-actions/')
    ) {
      response = await send(response.headers.get('location')!);
    }
    if (response.status !== 302) {
      return { outcome: { kind: 'page', html: await response.text() }, verifier };
    }
    const location = new URL(response.headers.get('location')!);
    expect(location.searchParams.get('state')).toBe(state);
    const code = location.searchParams.get('code');
    if (code === null) {
      return { outcome: { kind: 'page', html: location.toString() }, verifier };
    }
    return { outcome: { kind: 'code', code }, verifier };
  }

  async tokenRequest(realm: string, form: Record<string, string>): Promise<Response> {
    return fetch(`${this.origin}/realms/${realm}/protocol/openid-connect/token`, {
      method: 'POST',
      body: new URLSearchParams(form),
    });
  }

  async exchange(
    realm: string,
    clientId: string,
    redirectUri: string,
    signIn: { outcome: SignInOutcome; verifier: string },
  ): Promise<TokenResponse> {
    if (signIn.outcome.kind !== 'code') {
      throw new Error('sign-in did not reach the redirect');
    }
    const response = await this.tokenRequest(realm, {
      grant_type: 'authorization_code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code: signIn.outcome.code,
      code_verifier: signIn.verifier,
    });
    expect(response.status).toBe(200);
    return (await response.json()) as TokenResponse;
  }
}

/** The login form's action, from Keycloak's own page. */
function formAction(html: string): string {
  const match = /<form[^>]*action="([^"]+)"/.exec(html);
  if (!match) {
    throw new Error('no form on the page Keycloak returned');
  }
  return match[1]!.replaceAll('&amp;', '&');
}

async function guardOutcome(
  guard: JwtAuthGuard | AdminJwtAuthGuard,
  token: string,
): Promise<string> {
  try {
    await guard.canActivate(createHttpExecutionContext(requestWithAuthHeader(`Bearer ${token}`)));
    return 'accepted';
  } catch (error) {
    return (error as { response?: { code?: string } }).response?.code ?? String(error);
  }
}

describe.skipIf(!dockerAvailable)('the committed Keycloak realms, against the API guards', () => {
  let container: StartedTestContainer;
  let keycloak: KeycloakDriver;
  let patientGuard: JwtAuthGuard;
  let adminGuard: AdminJwtAuthGuard;
  const patientPassword = `patient-${base64url(randomBytes(12))}`;

  beforeAll(async () => {
    container = await new GenericContainer(KEYCLOAK_IMAGE)
      .withEnvironment({
        KC_BOOTSTRAP_ADMIN_USERNAME: BOOTSTRAP_ADMIN.username,
        KC_BOOTSTRAP_ADMIN_PASSWORD: BOOTSTRAP_ADMIN.password,
        OSTOMY_WEB_ORIGIN: WEB_ORIGIN,
        OSTOMY_ADMIN_ORIGIN: ADMIN_ORIGIN,
      })
      .withCopyDirectoriesToContainer([{ source: REALMS_DIR, target: '/opt/keycloak/data/import' }])
      // `start`, not `start-dev`: production mode, with the stack's hostname
      // settings. Only the database differs (the stack uses PostgreSQL).
      .withCommand([
        'start',
        '--import-realm',
        '--db=dev-file',
        '--http-enabled=true',
        `--hostname=${PUBLIC_AUTH_ORIGIN}`,
        '--hostname-strict=true',
        '--health-enabled=true',
      ])
      .withExposedPorts(8080, 9000)
      .withWaitStrategy(Wait.forHttp('/health/ready', 9000).withStartupTimeout(180_000))
      .start();

    const origin = `http://${container.getHost()}:${container.getMappedPort(8080)}`;
    keycloak = new KeycloakDriver(origin);
    const config = apiConfig(origin);
    patientGuard = new JwtAuthGuard(config, createRemoteJWKSet(new URL(config.oidc.jwksUri)));
    adminGuard = new AdminJwtAuthGuard(
      config,
      createRemoteJWKSet(new URL(config.adminOidc.jwksUri)),
    );

    await keycloak.createUser('patient', 'patient-one', [
      { type: 'password', value: patientPassword, temporary: false },
    ]);
  }, 240_000);

  afterAll(async () => {
    await container?.stop();
  });

  const mobileSignIn = (scope = 'openid offline_access') =>
    keycloak.signIn({
      realm: 'patient',
      clientId: 'ostomy-patient-app',
      redirectUri: MOBILE_REDIRECT,
      username: 'patient-one',
      password: patientPassword,
      scope,
    });

  it('the mobile app’s access token is accepted by the patient guard and refused by the admin guard', async () => {
    const tokens = await keycloak.exchange(
      'patient',
      'ostomy-patient-app',
      MOBILE_REDIRECT,
      await mobileSignIn(),
    );

    const claims = decodeJwt(tokens.access_token);
    expect(decodeProtectedHeader(tokens.access_token).alg).toBe('RS256');
    expect(claims.iss).toBe(`${PUBLIC_AUTH_ORIGIN}/realms/patient`);
    expect(claims.typ).toBe('Bearer');
    expect(claims.azp).toBe('ostomy-patient-app');
    // The API's audience and nothing else: no `account` from the default
    // `roles` scope, which the app clients do not carry.
    expect([claims.aud].flat()).toEqual(['ostomy-patient-app']);
    expect(typeof claims.sub).toBe('string');
    // No contact details in a token the phone sends on every request.
    expect(claims).not.toHaveProperty('email');
    expect(claims).not.toHaveProperty('preferred_username');

    expect(await guardOutcome(patientGuard, tokens.access_token)).toBe('accepted');
    // Refused on its key before its issuer is read: the two realms sign with
    // disjoint keys, so the admin JWKS has no key with this token's `kid`.
    expect(await guardOutcome(adminGuard, tokens.access_token)).toBe(
      ADMIN_AUTH_ERROR_CODE.MALFORMED_TOKEN,
    );
  });

  it('refuses the ID token, which carries the same audience, by its `typ`', async () => {
    const tokens = await keycloak.exchange(
      'patient',
      'ostomy-patient-app',
      MOBILE_REDIRECT,
      await mobileSignIn('openid'),
    );
    expect(tokens.id_token).toBeDefined();
    const claims = decodeJwt(tokens.id_token!);
    expect(claims.typ).toBe('ID');
    expect([claims.aud].flat()).toContain('ostomy-patient-app');

    expect(await guardOutcome(patientGuard, tokens.id_token!)).toBe(
      AUTH_ERROR_CODE.INVALID_TOKEN_USE,
    );
  });

  it('the web SPA’s access token carries the same API audience and is accepted', async () => {
    const tokens = await keycloak.exchange(
      'patient',
      'ostomy-web',
      `${WEB_ORIGIN}/`,
      await keycloak.signIn({
        realm: 'patient',
        clientId: 'ostomy-web',
        redirectUri: `${WEB_ORIGIN}/`,
        username: 'patient-one',
        password: patientPassword,
      }),
    );
    expect(decodeJwt(tokens.access_token).azp).toBe('ostomy-web');
    expect(await guardOutcome(patientGuard, tokens.access_token)).toBe('accepted');
  });

  it('a built-in client’s token never carries the API audience, so the guard refuses it', async () => {
    const redirectUri = `${PUBLIC_AUTH_ORIGIN}/realms/patient/account/`;
    const tokens = await keycloak.exchange(
      'patient',
      'account-console',
      redirectUri,
      await keycloak.signIn({
        realm: 'patient',
        clientId: 'account-console',
        redirectUri,
        username: 'patient-one',
        password: patientPassword,
      }),
    );
    expect([decodeJwt(tokens.access_token).aud].flat()).not.toContain('ostomy-patient-app');
    expect(await guardOutcome(patientGuard, tokens.access_token)).toBe(
      AUTH_ERROR_CODE.INVALID_AUDIENCE,
    );
  });

  it('the phone gets an offline session and the web SPA does not', async () => {
    const mobile = await keycloak.exchange(
      'patient',
      'ostomy-patient-app',
      MOBILE_REDIRECT,
      await mobileSignIn(),
    );
    expect(decodeJwt(mobile.refresh_token!).typ).toBe('Offline');

    const web = await keycloak.exchange(
      'patient',
      'ostomy-web',
      `${WEB_ORIGIN}/`,
      await keycloak.signIn({
        realm: 'patient',
        clientId: 'ostomy-web',
        redirectUri: `${WEB_ORIGIN}/`,
        username: 'patient-one',
        password: patientPassword,
      }),
    );
    expect(decodeJwt(web.refresh_token!).typ).toBe('Refresh');

    const webOffline = await keycloak.signIn({
      realm: 'patient',
      clientId: 'ostomy-web',
      redirectUri: `${WEB_ORIGIN}/`,
      username: 'patient-one',
      password: patientPassword,
      scope: 'openid offline_access',
    });
    expect(webOffline.outcome).toEqual({ kind: 'error', error: 'invalid_scope' });
  });

  it('refuses the `profile` scope, so a client built to request it fails at sign-in rather than putting names in tokens', async () => {
    const { outcome } = await mobileSignIn('openid profile offline_access');
    expect(outcome).toEqual({ kind: 'error', error: 'invalid_scope' });
  });

  // ADR-0022 item 5 left this to be measured rather than assumed. Measured on
  // Keycloak 26.7: the replay is refused AND it ends the session for that
  // client, so the newer token, which nobody replayed, stops working too. A
  // phone that refreshed twice at once would be signed out of a good session,
  // which is why apps/mobile's `renewAccessToken` is single-flight.
  it('refuses a replayed refresh token, and the replay ends the session for the newer one as well', async () => {
    const first = await keycloak.exchange(
      'patient',
      'ostomy-patient-app',
      MOBILE_REDIRECT,
      await mobileSignIn(),
    );
    const refresh = (token: string) =>
      keycloak.tokenRequest('patient', {
        grant_type: 'refresh_token',
        client_id: 'ostomy-patient-app',
        refresh_token: token,
      });

    const rotated = await refresh(first.refresh_token!);
    expect(rotated.status).toBe(200);
    const second = (await rotated.json()) as TokenResponse;
    expect(second.refresh_token).not.toBe(first.refresh_token);

    const replay = await refresh(first.refresh_token!);
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: string }).error).toBe('invalid_grant');

    const afterReplay = await refresh(second.refresh_token!);
    expect(afterReplay.status).toBe(400);
    expect(((await afterReplay.json()) as { error: string }).error).toBe('invalid_grant');
  });

  it('a temporary password stops at the change-password page, with no code issued', async () => {
    const temporary = `temporary-${base64url(randomBytes(12))}`;
    await keycloak.createUser('patient', 'patient-new', [
      { type: 'password', value: temporary, temporary: true },
    ]);
    const { outcome } = await keycloak.signIn({
      realm: 'patient',
      clientId: 'ostomy-patient-app',
      redirectUri: MOBILE_REDIRECT,
      username: 'patient-new',
      password: temporary,
    });
    expect(outcome.kind).toBe('page');
    expect(outcome.kind === 'page' && outcome.html).toContain('name="password-new"');
  });

  it('no client in either realm accepts a password grant', async () => {
    for (const realm of ['patient', 'admin']) {
      const clients = await keycloak.admin<
        { clientId: string; directAccessGrantsEnabled: boolean }[]
      >('GET', `/${realm}/clients`);
      expect(clients.length).toBeGreaterThan(5);
      for (const client of clients) {
        expect({
          realm,
          clientId: client.clientId,
          directAccessGrantsEnabled: client.directAccessGrantsEnabled,
        }).toEqual({
          realm,
          clientId: client.clientId,
          directAccessGrantsEnabled: false,
        });
        const response = await keycloak.tokenRequest(realm, {
          grant_type: 'password',
          client_id: client.clientId,
          username: 'patient-one',
          password: patientPassword,
        });
        expect({ realm, clientId: client.clientId, status: response.status }).not.toMatchObject({
          status: 200,
        });
      }
    }
  });

  it('patients cannot change their own email or name', async () => {
    const profile = await keycloak.admin<{
      attributes: { name: string; permissions: { edit: string[] } }[];
    }>('GET', '/patient/users/profile');
    for (const attribute of profile.attributes) {
      expect({ name: attribute.name, edit: attribute.permissions.edit }).toEqual({
        name: attribute.name,
        edit: ['admin'],
      });
    }
  });

  // ADR-0022 item 14. Keycloak's default `jboss-logging` listener writes each
  // failed sign-in, username as typed and client address included, to stdout,
  // which is the container log. The realms turn it off with an empty listener
  // list and keep the database store, so the event must be in one and not the
  // other. Reading it back from the store first is what makes the log's
  // silence mean something: it proves the failures were recorded at all.
  it('records a failed sign-in in its database and writes nothing about it to the log', async () => {
    const marker = base64url(randomBytes(9))
      .toLowerCase()
      .replaceAll(/[^a-z0-9]/g, 'x');
    const knownUser = `log-probe-${marker}`;
    const typedEmail = `typed-${marker}@example.test`;
    await keycloak.createUser('patient', knownUser, [
      { type: 'password', value: patientPassword, temporary: false },
    ]);
    for (const [username, password] of [
      [knownUser, `wrong-${patientPassword}`],
      [typedEmail, patientPassword],
    ] as const) {
      const { outcome } = await keycloak.signIn({
        realm: 'patient',
        clientId: 'ostomy-patient-app',
        redirectUri: MOBILE_REDIRECT,
        username,
        password,
      });
      expect(outcome.kind).toBe('page');
    }

    const stored = await keycloak.admin<{ details?: { username?: string } }[]>(
      'GET',
      '/patient/events?type=LOGIN_ERROR&max=100',
    );
    const storedUsernames = stored.map((event) => event.details?.username);
    expect(storedUsernames).toEqual(expect.arrayContaining([knownUser, typedEmail]));

    const log = spawnSync('docker', ['logs', container.getId()], { encoding: 'utf8' });
    expect(log.status).toBe(0);
    const combined = `${log.stdout}${log.stderr}`;
    expect(combined).not.toContain(marker);
    expect(combined).not.toContain('LOGIN_ERROR');
  });

  describe('the admin realm', () => {
    const adminSignIn = (username: string, password: string, otpSecret?: string) =>
      keycloak.signIn({
        realm: 'admin',
        clientId: 'ostomy-admin-console',
        redirectUri: `${ADMIN_ORIGIN}/`,
        username,
        password,
        ...(otpSecret === undefined ? {} : { otpSecret }),
      });

    it('refuses an account with no OTP enrolled, rather than offering to enrol it', async () => {
      const password = `admin-${base64url(randomBytes(12))}`;
      await keycloak.createUser('admin', 'admin-no-otp', [
        { type: 'password', value: password, temporary: false },
      ]);
      const { outcome } = await adminSignIn('admin-no-otp', password, 'unused');
      expect(outcome.kind).toBe('page');
      expect(outcome.kind === 'page' && outcome.html).not.toContain('name="totp"');
      expect(outcome.kind === 'page' && outcome.html).not.toContain('name="otp"');
    });

    it('signs in with a password and a one-time code, and only the admin guard accepts the token', async () => {
      const password = `admin-${base64url(randomBytes(12))}`;
      const otpSecret = base64url(randomBytes(15));
      await keycloak.createUser('admin', 'admin-with-otp', [
        { type: 'password', value: password, temporary: false },
        {
          type: 'otp',
          userLabel: 'test authenticator',
          secretData: JSON.stringify({ value: otpSecret }),
          credentialData: JSON.stringify({
            subType: 'totp',
            digits: 6,
            counter: 0,
            period: 30,
            algorithm: 'HmacSHA1',
          }),
        },
      ]);

      const withoutCode = await adminSignIn('admin-with-otp', password);
      expect(withoutCode.outcome.kind).toBe('page');

      const tokens = await keycloak.exchange(
        'admin',
        'ostomy-admin-console',
        `${ADMIN_ORIGIN}/`,
        await adminSignIn('admin-with-otp', password, otpSecret),
      );
      const claims = decodeJwt(tokens.access_token);
      expect([claims.aud].flat()).toEqual(['ostomy-admin-console']);
      expect(await guardOutcome(adminGuard, tokens.access_token)).toBe('accepted');
      expect(await guardOutcome(patientGuard, tokens.access_token)).toBe(
        AUTH_ERROR_CODE.MALFORMED_TOKEN,
      );
    });
  });
});
