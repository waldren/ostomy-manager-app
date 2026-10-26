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
 * The internet-facing allowlist (ADR-0022 items 6 and 7), asserted against the
 * pinned Caddy image running `caddy/sites.caddy` unchanged.
 *
 * The upstreams are one stub that answers with which service it is pretending
 * to be and the URI it received, so each case can say both whether a request
 * got through and what it arrived as. Only the global block differs from the
 * host: a local certificate authority stands in for Let's Encrypt.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';

import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CADDY_IMAGE, SELFHOST_ROOT } from './compose-file';

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
    throw new Error('[caddy.integration.spec.ts] Docker is not reachable, but CI is set.');
  }
  console.warn('[caddy.integration.spec.ts] Docker is not reachable — skipping.');
}

const APP = 'app.ostomy.test';
const AUTH = 'auth.ostomy.test';

/** The host's global block, minus ACME: a local CA, the same protocols and logging. */
const TEST_CADDYFILE = `{
	local_certs
	skip_install_trust
	admin off
	servers {
		protocols h1 h2
	}
	import /etc/caddy/logging.caddy
}

import /etc/caddy/sites.caddy
`;

/**
 * The same, without logging.caddy: the control that shows what Caddy writes
 * by default, so the logging test's clean log is evidence and not an artefact
 * of a request that never failed.
 */
const UNFILTERED_CADDYFILE = TEST_CADDYFILE.replace('\timport /etc/caddy/logging.caddy\n', '');

const STUB_CADDYFILE = `{
	admin off
}
:3000 {
	respond "api {uri}"
}
:3001 {
	respond "web {uri}"
}
:3002 {
	respond "keycloak {uri}"
}
`;

interface Answer {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

type TlsVersion = 'TLSv1.2' | 'TLSv1.3';

function collect(res: IncomingMessage, resolve: (answer: Answer) => void): void {
  let body = '';
  res.setEncoding('utf8');
  res.on('data', (chunk: string) => (body += chunk));
  res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
}

class Proxy {
  readonly container: StartedTestContainer;
  /** The root of the proxy's own local CA, trusted for this client only. */
  private readonly ca: string;

  constructor(container: StartedTestContainer, ca: string) {
    this.container = container;
    this.ca = ca;
  }

  get(
    host: string,
    rawPath: string,
    tls: { minVersion?: TlsVersion; maxVersion?: TlsVersion } = {},
  ): Promise<Answer> {
    return new Promise((resolve, reject) => {
      const req = httpsRequest(
        {
          host: this.container.getHost(),
          port: this.container.getMappedPort(443),
          // Sent as written: the bypass cases below depend on the path not
          // being normalised by the client before Caddy sees it.
          path: rawPath,
          servername: host,
          headers: { host },
          ca: this.ca,
          ...tls,
        },
        (res) => collect(res, resolve),
      );
      req.on('error', reject);
      req.end();
    });
  }

  getPlain(port: number, host: string, rawPath: string): Promise<Answer> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: this.container.getHost(),
          port: this.container.getMappedPort(port),
          path: rawPath,
          headers: { host },
        },
        (res) => collect(res, resolve),
      );
      req.on('error', reject);
      req.end();
    });
  }
}

async function startProxy(
  network: StartedNetwork,
  allowedIps: string,
  options: { upstreamHost?: string; caddyfile?: string } = {},
): Promise<Proxy> {
  const upstream = options.upstreamHost ?? 'stub';
  const container = await new GenericContainer(CADDY_IMAGE)
    .withNetwork(network)
    .withEnvironment({
      OSTOMY_DOMAIN: APP,
      OSTOMY_AUTH_DOMAIN: AUTH,
      OSTOMY_ADMIN_ALLOWED_IPS: allowedIps,
      OSTOMY_API_UPSTREAM: `${upstream}:3000`,
      OSTOMY_WEB_UPSTREAM: `${upstream}:3001`,
      OSTOMY_KEYCLOAK_UPSTREAM: `${upstream}:3002`,
    })
    .withCopyContentToContainer([
      { content: options.caddyfile ?? TEST_CADDYFILE, target: '/etc/caddy/Caddyfile' },
    ])
    .withCopyFilesToContainer([
      { source: path.join(SELFHOST_ROOT, 'caddy/sites.caddy'), target: '/etc/caddy/sites.caddy' },
      {
        source: path.join(SELFHOST_ROOT, 'caddy/logging.caddy'),
        target: '/etc/caddy/logging.caddy',
      },
    ])
    .withExposedPorts(80, 443, 8081)
    .withWaitStrategy(Wait.forLogMessage(/serving initial configuration/))
    .start();
  // The local CA's root is written once the first certificate is issued.
  let ca = '';
  for (let attempt = 0; ca === ''; attempt++) {
    const { output, exitCode } = await container.exec([
      'cat',
      '/data/caddy/pki/authorities/local/root.crt',
    ]);
    if (exitCode === 0) ca = output;
    else if (attempt > 40) throw new Error('Caddy wrote no local CA');
    else await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const proxy = new Proxy(container, ca);
  for (let attempt = 0; ; attempt++) {
    try {
      await proxy.get(APP, '/');
      return proxy;
    } catch (error) {
      if (attempt > 40) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

describe.skipIf(!dockerAvailable)('the Caddy allowlist', () => {
  let network: StartedNetwork;
  let stub: StartedTestContainer;
  /** The operator allowlist holds a documentation address, so the test client is not on it. */
  let outsider: Proxy;
  /** The operator allowlist holds every address, so the test client is on it. */
  let operator: Proxy;

  beforeAll(async () => {
    network = await new Network().start();
    stub = await new GenericContainer(CADDY_IMAGE)
      .withNetwork(network)
      .withNetworkAliases('stub')
      .withCopyContentToContainer([{ content: STUB_CADDYFILE, target: '/etc/caddy/Caddyfile' }])
      .withWaitStrategy(Wait.forLogMessage(/serving initial configuration/))
      .start();
    [outsider, operator] = await Promise.all([
      startProxy(network, '203.0.113.7/32'),
      startProxy(network, '0.0.0.0/0 ::/0'),
    ]);
  });

  afterAll(async () => {
    await Promise.all([outsider?.container.stop(), operator?.container.stop(), stub?.stop()]);
    await network?.stop();
  });

  describe('forwards what is named', () => {
    it.each([
      [APP, '/api/v1/observations', 'api /api/v1/observations'],
      [APP, '/api/v1/sync/delta?since=0', 'api /api/v1/sync/delta?since=0'],
      [APP, '/api/v1/health/ready', 'api /api/v1/health/ready'],
      [APP, '/', 'web /'],
      [APP, '/?code=abc&state=def', 'web /?code=abc&state=def'],
      [APP, '/assets/index.js', 'web /assets/index.js'],
      [
        AUTH,
        '/realms/patient/protocol/openid-connect/auth?client_id=x',
        'keycloak /realms/patient/protocol/openid-connect/auth?client_id=x',
      ],
      [
        AUTH,
        '/realms/patient/protocol/openid-connect/token',
        'keycloak /realms/patient/protocol/openid-connect/token',
      ],
      [
        AUTH,
        '/realms/patient/login-actions/authenticate?session_code=x',
        'keycloak /realms/patient/login-actions/authenticate?session_code=x',
      ],
      [
        AUTH,
        '/realms/patient/.well-known/openid-configuration',
        'keycloak /realms/patient/.well-known/openid-configuration',
      ],
      [
        AUTH,
        '/resources/abc/login/keycloak.v2/css/styles.css',
        'keycloak /resources/abc/login/keycloak.v2/css/styles.css',
      ],
    ])('%s%s', async (host, requestPath, expected) => {
      const answer = await outsider.get(host, requestPath);
      expect({ status: answer.status, body: answer.body }).toEqual({ status: 200, body: expected });
    });
  });

  describe('refuses everything else, without reaching a container', () => {
    it.each([
      // Keycloak's console, its master realm, its operational endpoints, and
      // every patient-realm path that is not sign-in.
      [AUTH, '/admin/'],
      [AUTH, '/admin/master/console/'],
      [AUTH, '/realms/master/protocol/openid-connect/token'],
      [AUTH, '/realms/master/'],
      [AUTH, '/metrics'],
      [AUTH, '/health'],
      [AUTH, '/health/ready'],
      [AUTH, '/realms/patient/account/'],
      [AUTH, '/realms/patient'],
      [AUTH, '/realms/patient/clients-registrations/default'],
      [AUTH, '/admin/realms/patient/users'],
      [AUTH, '/'],
      // The API's liveness check.
      [APP, '/api/v1/health'],
    ])('%s%s', async (host, requestPath) => {
      // From an allowed address, so a refusal here is the path, not the IP.
      const answer = await operator.get(host, requestPath);
      expect(answer.status).toBe(404);
      expect(answer.body).not.toMatch(/^(api|web|keycloak) /);
    });
  });

  describe('the operator allowlist', () => {
    it.each([
      [APP, '/api/v1/admin/thresholds'],
      [APP, '/api/v1/admin'],
      [AUTH, '/realms/admin/protocol/openid-connect/auth?client_id=x'],
      [AUTH, '/realms/admin/login-actions/authenticate'],
      [AUTH, '/realms/admin/.well-known/openid-configuration'],
    ])('refuses %s%s from any other address', async (host, requestPath) => {
      const answer = await outsider.get(host, requestPath);
      expect(answer.status).toBe(403);
      expect(answer.body).not.toMatch(/^(api|web|keycloak) /);
    });

    it.each([
      [APP, '/api/v1/admin/thresholds', 'api /api/v1/admin/thresholds'],
      [
        AUTH,
        '/realms/admin/protocol/openid-connect/token',
        'keycloak /realms/admin/protocol/openid-connect/token',
      ],
    ])('forwards %s%s from an allowed address', async (host, requestPath, expected) => {
      const answer = await operator.get(host, requestPath);
      expect({ status: answer.status, body: answer.body }).toEqual({ status: 200, body: expected });
    });

    // Spellings of an admin path that a server behind the proxy might
    // normalise to one. Caddy's path matcher decodes, cleans and compares
    // case-insensitively before matching, so each is the admin path to it.
    it.each([
      '/api/v1/Admin/thresholds',
      '/api/v1/ADMIN/thresholds',
      '/api/v1/%61dmin/thresholds',
      '/api/v1/./admin/thresholds',
      '/api/v1/x/../admin/thresholds',
      '/api/v1//admin/thresholds',
      '/api/v1/admin%2Fthresholds',
    ])('refuses %s from any other address too', async (requestPath) => {
      const answer = await outsider.get(APP, requestPath);
      expect({ status: answer.status, body: answer.body }).toEqual({ status: 403, body: '' });
    });
  });

  describe('transport', () => {
    it('refuses TLS 1.2', async () => {
      await expect(
        outsider.get(APP, '/', { minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' }),
      ).rejects.toThrow();
    });

    it.each([
      [APP, '/'],
      [AUTH, '/realms/patient/.well-known/openid-configuration'],
    ])('sends HSTS on %s, and no Server header', async (host, requestPath) => {
      const answer = await outsider.get(host, requestPath);
      expect(answer.headers['strict-transport-security']).toBe(
        'max-age=31536000; includeSubDomains',
      );
      expect(answer.headers.server).toBeUndefined();
    });

    it('redirects plain HTTP to HTTPS', async () => {
      const answer = await outsider.getPlain(80, APP, '/api/v1/observations');
      expect(answer.status).toBe(308);
      expect(answer.headers.location).toBe(`https://${APP}/api/v1/observations`);
    });

    it('serves Keycloak’s console on the tunnel port, which compose.yml binds to loopback', async () => {
      const answer = await outsider.getPlain(8081, 'localhost:8081', '/admin/master/console/');
      expect({ status: answer.status, body: answer.body }).toEqual({
        status: 200,
        body: 'keycloak /admin/master/console/',
      });
    });
  });
});

/**
 * ADR-0022 item 14. With no access log, a request that succeeds is written
 * nowhere, but one a handler fails is written by `http.log.error` with its
 * URI and the client's address. Every request in flight during a deploy or an
 * outage fails that way. Both proxies here point at an upstream that does not
 * exist, so every request is a 502: the control, with Caddy's default logging,
 * shows the leak is real, and the host's configuration shows it is closed.
 */
describe.skipIf(!dockerAvailable)('Caddy’s log when an upstream is down', () => {
  let network: StartedNetwork;
  let unfiltered: Proxy;
  let host: Proxy;
  const marker = `m${Date.now().toString(36)}`;
  const requests = [
    [APP, `/?code=code-${marker}&state=state-${marker}`],
    [APP, `/api/v1/sync/delta?since=cursor-${marker}`],
    [AUTH, `/realms/patient/protocol/openid-connect/auth?login_hint=hint-${marker}`],
  ] as const;

  const containerLog = (proxy: Proxy): string => {
    const result = spawnSync('docker', ['logs', proxy.container.getId()], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    return `${result.stdout}${result.stderr}`;
  };

  beforeAll(async () => {
    network = await new Network().start();
    [unfiltered, host] = await Promise.all([
      startProxy(network, '203.0.113.7/32', {
        upstreamHost: 'nowhere',
        caddyfile: UNFILTERED_CADDYFILE,
      }),
      startProxy(network, '203.0.113.7/32', { upstreamHost: 'nowhere' }),
    ]);
    for (const proxy of [unfiltered, host]) {
      for (const [requestHost, requestPath] of requests) {
        expect((await proxy.get(requestHost, requestPath)).status).toBe(502);
      }
    }
  });

  afterAll(async () => {
    await Promise.all([unfiltered?.container.stop(), host?.container.stop()]);
    await network?.stop();
  });

  it('records each failed request’s URI and address under Caddy’s default logging (the control)', () => {
    const log = containerLog(unfiltered);
    expect(log).toContain(`cursor-${marker}`);
    expect(log).toContain('"remote_ip"');
  });

  it('records neither under the host’s logging.caddy, and still logs its own startup', () => {
    const log = containerLog(host);
    expect(log).toContain('serving initial configuration');
    expect(log).not.toContain(marker);
    expect(log).not.toContain('"remote_ip"');
    expect(log).not.toContain('"uri"');
  });
});
