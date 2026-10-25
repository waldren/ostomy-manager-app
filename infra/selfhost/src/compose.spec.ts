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
 * `compose.yml` held to ADR-0022's rules, read as data. Each rule here is one
 * that a plausible edit breaks with nothing else failing: a port published
 * "temporarily", a password moved into `environment:` for convenience, a
 * service added to the edge network so it can reach something.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { readComposeFile, SELFHOST_ROOT } from './compose-file';

const compose = readComposeFile();
const services = Object.entries(compose.services);

describe('compose.yml', () => {
  it('publishes 80 and 443 to the internet from Caddy alone, and the console port on loopback only', () => {
    const published = services.flatMap(([name, service]) =>
      (service.ports ?? []).map((port) => `${name} ${port}`),
    );
    expect(published).toEqual([
      'caddy 80:80/tcp',
      'caddy 443:443/tcp',
      'caddy 127.0.0.1:8081:8081/tcp',
    ]);
  });

  it('puts every service but Caddy on internal networks only, which have no route off the host', () => {
    for (const [name, network] of Object.entries(compose.networks)) {
      if (name !== 'edge')
        expect({ name, internal: network?.internal }).toEqual({ name, internal: true });
    }
    const onEdge = services.filter(([, service]) => service.networks?.includes('edge'));
    expect(onEdge.map(([name]) => name)).toEqual(['caddy']);
  });

  it('keeps each database reachable from its own consumers only', () => {
    const on = (network: string) =>
      services.filter(([, service]) => service.networks?.includes(network)).map(([name]) => name);
    expect(on('data').sort()).toEqual(['api', 'db-setup', 'postgres']);
    expect(on('idp-data').sort()).toEqual(['keycloak', 'keycloak-db']);
  });

  it('pins every image it pulls by digest', () => {
    for (const [name, service] of services) {
      if (service.build !== undefined) continue;
      expect({ name, image: service.image }).toEqual({
        name,
        image: expect.stringMatching(/@sha256:[0-9a-f]{64}$/),
      });
    }
  });

  it('runs the same Keycloak image as the API’s realm test', () => {
    const realmTest = readFileSync(
      path.join(SELFHOST_ROOT, '../../apps/api/src/auth/keycloak-realm.integration.spec.ts'),
      'utf8',
    );
    expect(realmTest).toContain(`'${compose.services.keycloak!.image!}'`);
  });

  /**
   * ADR-0022 item 9: no secret in `environment:`, where `docker inspect` shows
   * it. A service that needs one reads its file in its own command.
   */
  it('passes no secret through the environment', () => {
    const secretKeys =
      /PASSWORD$|DATABASE_URL$|SECRET|^DB_.*_PASSWORD$|^KC_DB_PASSWORD$|^KC_BOOTSTRAP_ADMIN_PASSWORD$/;
    for (const [name, service] of services) {
      for (const [key, value] of Object.entries(service.environment ?? {})) {
        if (!secretKeys.test(key)) continue;
        // The object-storage key is a placeholder until P5.S3 gives the API
        // something to store; it is pinned so a real one cannot slip in here.
        if (key === 'OBJECT_STORAGE_SECRET_ACCESS_KEY') {
          expect(value).toBe('unused-until-p5s3');
          continue;
        }
        expect({ service: name, key }).toEqual({
          service: name,
          key: expect.stringMatching(/_FILE$/),
        });
      }
    }
  });

  it('reads every secret from the host’s secrets directory, and gives each only to the services that use it', () => {
    for (const secret of Object.values(compose.secrets)) {
      expect(secret.file).toMatch(/^\$\{OSTOMY_SECRETS_DIR:\?[^}]*\}\/[a-z_]+$/);
    }
    const holders = (secret: string) =>
      services
        .filter(([, service]) => service.secrets?.includes(secret))
        .map(([name]) => name)
        .sort();
    expect(holders('postgres_superuser_password')).toEqual(['db-setup', 'postgres']);
    expect(holders('db_owner_password')).toEqual(['db-setup']);
    expect(holders('db_runtime_password')).toEqual(['api', 'db-setup']);
    expect(holders('keycloak_db_password')).toEqual(['keycloak', 'keycloak-db']);
    expect(holders('keycloak_bootstrap_admin_password')).toEqual(['keycloak']);
  });

  it('bounds every service’s log, and refuses privilege escalation in each', () => {
    for (const [name, service] of services) {
      expect({ name, logging: service.logging }).toEqual({
        name,
        logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '5' } },
      });
      expect({ name, security_opt: service.security_opt }).toEqual({
        name,
        security_opt: ['no-new-privileges:true'],
      });
    }
  });

  it('keeps PostgreSQL’s log free of rows, statements and parameters, on both databases', () => {
    for (const name of ['postgres', 'keycloak-db']) {
      const command = compose.services[name]!.command as string[];
      for (const setting of [
        'log_error_verbosity=terse',
        'log_statement=none',
        'log_min_duration_statement=-1',
        'log_parameter_max_length=0',
        'log_parameter_max_length_on_error=0',
      ]) {
        expect({ name, has: command.includes(setting) ? setting : undefined }).toEqual({
          name,
          has: setting,
        });
      }
    }
  });

  it('gives the API the claim mapping that refuses a Keycloak ID token', () => {
    const environment = compose.services.api!.environment!;
    for (const prefix of ['OIDC', 'ADMIN_OIDC']) {
      expect(environment[`${prefix}_TOKEN_USE_CLAIM`]).toBe('typ');
      expect(environment[`${prefix}_REQUIRED_TOKEN_USE`]).toBe('Bearer');
    }
    expect(environment.NODE_ENV).toBe('production');
  });

  it('pins Keycloak’s hostname strictly', () => {
    const environment = compose.services.keycloak!.environment!;
    expect(environment.KC_HOSTNAME).toBe('https://${OSTOMY_AUTH_DOMAIN}');
    expect(environment.KC_HOSTNAME_STRICT).toBe('true');
  });
});

describe('the Caddy configuration', () => {
  const caddyfile = readFileSync(path.join(SELFHOST_ROOT, 'caddy/Caddyfile'), 'utf8');
  const sites = readFileSync(path.join(SELFHOST_ROOT, 'caddy/sites.caddy'), 'utf8');
  const code = (text: string) =>
    text
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');

  // The allowlist test runs sites.caddy under its own global block, so the
  // host's global block is checked here instead.
  it('turns off the admin API and HTTP/3 in the global block, and imports the sites the test covers', () => {
    expect(code(caddyfile)).toMatch(/^\s*admin off$/m);
    expect(code(caddyfile)).toMatch(/^\s*protocols h1 h2$/m);
    expect(code(caddyfile)).toMatch(/^import \/etc\/caddy\/sites\.caddy$/m);
  });

  it('writes no access log', () => {
    expect(code(caddyfile)).not.toMatch(/\blog\b/);
    expect(code(sites)).not.toMatch(/\blog\b/);
  });

  // No access log does not stop `http.log.error` recording each failed
  // request with its URI and client address; caddy.integration.spec.ts shows
  // that it does, and that this exclusion stops it.
  it('excludes the request-carrying error loggers from the default log, inside the global block', () => {
    const logging = readFileSync(path.join(SELFHOST_ROOT, 'caddy/logging.caddy'), 'utf8');
    expect(code(logging)).toMatch(
      /^log default \{[^}]*^\s*exclude http\.log\.error http\.handlers\.reverse_proxy$[^}]*\}/ms,
    );
    const globalBlock = /^\{\n([\s\S]*?)^\}/m.exec(code(caddyfile))?.[1] ?? '';
    expect(globalBlock).toMatch(/^\s*import \/etc\/caddy\/logging\.caddy$/m);
    expect(compose.services.caddy!.volumes).toContain(
      './caddy/logging.caddy:/etc/caddy/logging.caddy:ro',
    );
  });
});
