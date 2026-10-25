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
 * `connect`'s retry (D.S1 slice 2 review, #176): the one-off tasks retry while
 * the server is still starting, and fail at once on anything else. The server
 * here is a socket that answers PostgreSQL's startup message with one error
 * and hangs up, which is all either case needs, with no Docker.
 */
import { createRequire } from 'node:module';
import { createServer, type AddressInfo, type Server } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { connect } = require('../tasks/db-common.cjs') as {
  connect: (
    login: { user: string; password: string; database: string },
    options?: { attempts?: number; delayMs?: number },
  ) => Promise<{ end(): Promise<void> }>;
};

/** A PostgreSQL ErrorResponse ('E') carrying `code`. */
function errorResponse(code: string): Buffer {
  const fields = Buffer.from(`SFATAL\0C${code}\0Mtest\0\0`, 'utf8');
  const header = Buffer.alloc(5);
  header.write('E', 0);
  header.writeInt32BE(fields.length + 4, 1);
  return Buffer.concat([header, fields]);
}

/** A server that answers every connection with `code`, counting connections. */
async function refusingServer(
  code: string,
): Promise<{ server: Server; port: number; count: () => number }> {
  let connections = 0;
  const server = createServer((socket) => {
    connections++;
    socket.once('data', () => socket.end(errorResponse(code)));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port, count: () => connections };
}

const LOGIN = { user: 'nobody', password: 'test-only-password', database: 'none' };

describe('connect', () => {
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv('DB_HOST', '127.0.0.1');
    vi.stubEnv('DB_TLS', 'off');
    stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    stderr.mockRestore();
  });

  it('retries a server that is still starting (57P03), then gives up with its error', async () => {
    const { server, port, count } = await refusingServer('57P03');
    vi.stubEnv('DB_PORT', String(port));
    try {
      await expect(connect(LOGIN, { attempts: 3, delayMs: 10 })).rejects.toMatchObject({
        code: '57P03',
      });
      expect(count()).toBe(3);
      expect(stderr).toHaveBeenCalledTimes(2);
    } finally {
      server.close();
    }
  });

  it('retries a refused connection', async () => {
    const { server, port } = await refusingServer('57P03');
    server.close();
    vi.stubEnv('DB_PORT', String(port));
    await expect(connect(LOGIN, { attempts: 2, delayMs: 10 })).rejects.toMatchObject({
      code: 'ECONNREFUSED',
    });
    expect(stderr).toHaveBeenCalledTimes(1);
  });

  it('fails a wrong password (28P01) at once, and prints neither it nor the host', async () => {
    const { server, port, count } = await refusingServer('28P01');
    vi.stubEnv('DB_PORT', String(port));
    try {
      await expect(connect(LOGIN, { attempts: 5, delayMs: 10 })).rejects.toMatchObject({
        code: '28P01',
      });
      expect(count()).toBe(1);
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('never prints the password or the host while retrying', async () => {
    const { server, port } = await refusingServer('57P03');
    vi.stubEnv('DB_PORT', String(port));
    try {
      await expect(connect(LOGIN, { attempts: 2, delayMs: 10 })).rejects.toBeDefined();
      const printed = stderr.mock.calls.flat().join('\n');
      expect(printed).not.toContain(LOGIN.password);
      expect(printed).not.toContain('127.0.0.1');
    } finally {
      server.close();
    }
  });
});
