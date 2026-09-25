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

import { describe, expect, it } from 'vitest';

import type { AppConfig } from '../config/env.schema';

import { HealthController } from './health.controller';

function controllerFor(overrides: Partial<AppConfig> = {}): HealthController {
  return new HealthController({
    nodeEnv: 'development',
    buildCommit: 'ea81a75',
    ...overrides,
  } as AppConfig);
}

describe('HealthController', () => {
  it('reports ok with a timestamp, and nothing about dependencies that do not exist yet', () => {
    const result = controllerFor().check();

    expect(result.status).toBe('ok');
    expect(new Date(result.timestamp).toString()).not.toBe('Invalid Date');
    expect(result).not.toHaveProperty('dependencies');
  });

  /**
   * `buildCommit` exists for #76: the development stack ran three merges behind
   * `main` and nothing surfaced it, because a deploy that never ran looks
   * exactly like one that did.
   */
  describe('buildCommit', () => {
    it('reports the stamped commit in development', () => {
      expect(controllerFor().check().buildCommit).toBe('ea81a75');
    });

    /**
     * The assertion that matters most here, and the reason this is gated rather
     * than simply reported.
     *
     * This endpoint is unauthenticated by design and this project is AGPL-3.0 —
     * the source is public. An exact commit therefore tells an unauthenticated
     * caller which known issues a deployment has not yet taken. That is a real
     * gift to an attacker outside a developer's own stack, and the staleness
     * problem it solves is a development-environment problem.
     */
    it.each(['production', 'test'] as const)('withholds it when NODE_ENV is %s', (nodeEnv) => {
      expect(controllerFor({ nodeEnv }).check().buildCommit).toBeNull();
    });

    /**
     * `null`, not an omitted key — the reason `docs/sync-contract.md` gives for
     * `method`: an absent field cannot be told apart from a server too old to
     * implement it. A caller has to distinguish "this build will not tell you"
     * from "this build does not know the question".
     */
    it('reports null rather than omitting the key when nothing stamped it', () => {
      const result = controllerFor({ buildCommit: undefined }).check();

      expect(result.buildCommit).toBeNull();
      expect('buildCommit' in result).toBe(true);
    });
  });
});
