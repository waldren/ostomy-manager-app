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
});
