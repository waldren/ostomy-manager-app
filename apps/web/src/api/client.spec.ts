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

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWebApiClient } from './client.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('createWebApiClient', () => {
  it('refuses to build a client with no configured API origin', () => {
    // Without this the generated client resolves request paths against
    // `undefined`, which fails at request time as a confusing URL error
    // rather than at startup as a configuration one.
    vi.stubEnv('VITE_API_BASE_URL', '');
    expect(() => createWebApiClient(async () => 'token')).toThrow(/VITE_API_BASE_URL/);
  });

  it('sends the bearer token the caller supplies', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'http://api.example');
    // Parameters declared so `mock.calls` is typed as the fetch signature
    // rather than an empty tuple — indexing into `[]` is a type error.
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ observations: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = createWebApiClient(async () => 'the-token');
    await client.observations.list();

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer the-token');
  });

  it('calls getAccessToken per request, so a refreshed token is picked up', async () => {
    // The property that makes the single-flight refresh in `AuthContext`
    // reach the wire: a client that captured the token once at construction
    // would keep sending the expired one after every refresh, and the page
    // memoizes this client for the lifetime of the session.
    vi.stubEnv('VITE_API_BASE_URL', 'http://api.example');
    // Parameters declared so `mock.calls` is typed as the fetch signature
    // rather than an empty tuple — indexing into `[]` is a type error.
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ observations: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const tokens = ['first', 'second'];
    const client = createWebApiClient(async () => tokens.shift());

    await client.observations.list();
    await client.observations.list();

    const sent = fetchMock.mock.calls.map((call) =>
      new Headers((call[1] as RequestInit | undefined)?.headers).get('authorization'),
    );
    expect(sent).toEqual(['Bearer first', 'Bearer second']);
  });
});
