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
 * What a command needs from the outside world, gathered in one place so the
 * command logic can be tested against a fake host, a fake build and a fixed
 * clock, while git runs for real against a throwaway repository.
 */
import type { buildImages } from '../images.ts';
import type { Remote } from '../remote.ts';

export interface Context {
  /** The repository releases are resolved in: this tool's own checkout. */
  repo: string;
  remote: Remote;
  log: (line: string) => void;
  buildImages: typeof buildImages;
  /** True once `https://<domain>/api/v1/health/ready` answers 200, within `attempts` tries. */
  waitForReady: (domain: string, attempts?: number) => Promise<boolean>;
  now: () => Date;
}

/** Polls the readiness endpoint from outside the host, as a patient's phone reaches it. */
export async function waitForReady(
  domain: string,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<boolean> {
  const attempts = options.attempts ?? 36;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(`https://${domain}/api/v1/health/ready`, {
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      });
      if (response.status === 200) return true;
    } catch {
      // DNS, TLS or a certificate not issued yet: all worth waiting for.
    }
    if (attempt < attempts - 1)
      await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 5_000));
  }
  return false;
}
