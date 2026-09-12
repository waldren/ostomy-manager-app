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

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchDiscoveryDocument, resetDiscoveryCacheForTests } from './discovery.js';

describe('fetchDiscoveryDocument', () => {
  beforeEach(() => {
    resetDiscoveryCacheForTests();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('fetches the standard well-known discovery path — never a hardcoded, vendor-specific endpoint', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          issuer: 'https://issuer.example',
          authorization_endpoint: 'https://issuer.example/authorize',
          token_endpoint: 'https://issuer.example/token',
        }),
        { status: 200 },
      ),
    );

    const document = await fetchDiscoveryDocument('https://issuer.example');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://issuer.example/.well-known/openid-configuration',
    );
    expect(document.authorization_endpoint).toBe('https://issuer.example/authorize');
  });

  it('caches the result per issuer so a second call does not re-fetch', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          issuer: 'https://issuer.example',
          authorization_endpoint: 'https://issuer.example/authorize',
          token_endpoint: 'https://issuer.example/token',
        }),
        { status: 200 },
      ),
    );

    await fetchDiscoveryDocument('https://issuer.example');
    await fetchDiscoveryDocument('https://issuer.example');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects and does not cache a failed lookup, so a later retry can succeed', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response('', { status: 500 }));

    await expect(fetchDiscoveryDocument('https://issuer.example')).rejects.toThrow();

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          issuer: 'https://issuer.example',
          authorization_endpoint: 'https://issuer.example/authorize',
          token_endpoint: 'https://issuer.example/token',
        }),
        { status: 200 },
      ),
    );

    await expect(fetchDiscoveryDocument('https://issuer.example')).resolves.toMatchObject({
      authorization_endpoint: 'https://issuer.example/authorize',
    });
  });

  describe('issuer validation (OpenID Connect Discovery 1.0 §4.3)', () => {
    /**
     * The attack this blocks, concretely: anything that can answer for the
     * well-known URL — a hijacked DNS response, a compromised proxy on a
     * clinic LAN, or simply `VITE_OIDC_ISSUER` misconfigured to a host
     * someone else controls — returns a well-formed document naming its
     * own `authorization_endpoint`. Without this check the app sends the
     * clinician there to type their credentials, and every subsequent step
     * still looks like a normal, successful sign-in.
     */
    it('refuses a document whose issuer is not the one that was asked', async () => {
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({
            issuer: 'https://attacker.example',
            authorization_endpoint: 'https://attacker.example/authorize',
            token_endpoint: 'https://attacker.example/token',
          }),
          { status: 200 },
        ),
      );

      await expect(fetchDiscoveryDocument('https://issuer.example')).rejects.toThrow(
        /different issuer/i,
      );
    });

    it('refuses a document with no issuer claim at all', async () => {
      // §3 makes `issuer` REQUIRED. Absent means either not an OIDC
      // discovery document or one that has been stripped — and treating a
      // missing claim as "nothing to compare, carry on" would make the
      // check above trivially bypassable.
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({
            authorization_endpoint: 'https://issuer.example/authorize',
            token_endpoint: 'https://issuer.example/token',
          }),
          { status: 200 },
        ),
      );

      await expect(fetchDiscoveryDocument('https://issuer.example')).rejects.toThrow(
        /different issuer/i,
      );
    });

    it('accepts a trailing-slash difference, which is the one normalization applied', async () => {
      // `fetchDiscoveryDocument` strips the trailing slash when building the
      // well-known URL, so a configured `https://issuer.example/` would
      // otherwise never match a document saying `https://issuer.example`.
      // This is a real deployment shape, not a hypothetical.
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({
            issuer: 'https://issuer.example',
            authorization_endpoint: 'https://issuer.example/authorize',
            token_endpoint: 'https://issuer.example/token',
          }),
          { status: 200 },
        ),
      );

      await expect(fetchDiscoveryDocument('https://issuer.example/')).resolves.toMatchObject({
        issuer: 'https://issuer.example',
      });
    });

    it('does not treat a different path on the same host as a match', async () => {
      // Multi-tenant issuers differ only by path (`/realms/a` vs
      // `/realms/b`), so a comparison loose enough to ignore the path would
      // let one tenant's document stand in for another's.
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({
            issuer: 'https://issuer.example/realms/other',
            authorization_endpoint: 'https://issuer.example/realms/other/authorize',
            token_endpoint: 'https://issuer.example/realms/other/token',
          }),
          { status: 200 },
        ),
      );

      await expect(
        fetchDiscoveryDocument('https://issuer.example/realms/patients'),
      ).rejects.toThrow(/different issuer/i);
    });
  });
});
