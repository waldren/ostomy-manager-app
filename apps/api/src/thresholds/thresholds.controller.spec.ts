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

import { thresholdsResponseSchema } from './thresholds-openapi';
import { ThresholdsController } from './thresholds.controller';
import type { ThresholdsService } from './thresholds.service';

function controllerReturning(thresholds: Record<string, unknown>): ThresholdsController {
  const service = {
    getVolumetricThresholds: () => Promise.resolve(thresholds),
  } as unknown as ThresholdsService;
  return new ThresholdsController(service);
}

describe('ThresholdsController', () => {
  it('projects the active thresholds onto the wire field names', async () => {
    const response = await controllerReturning({
      softWarningMaxMl: 2000,
      maxClockSkewMs: 300_000,
    }).get();

    expect(response).toEqual({ stomaOutputSoftWarningMl: 2000, maxClockSkewMs: 300_000 });
  });

  /**
   * The response is built by naming fields, never by spreading
   * `VolumetricValidationThresholds`. That type is internal and free to grow;
   * a spread would turn every future addition into unversioned public API the
   * moment it was added, silently. This asserts the projection rather than
   * trusting the implementation to keep reading correctly — and the schema is
   * `.strict()`, so a leaked field fails here as well.
   */
  it('does not leak a field the service grows later', async () => {
    const response = await controllerReturning({
      softWarningMaxMl: 2000,
      maxClockSkewMs: 300_000,
      someInternalThresholdAddedLater: 42,
    }).get();

    expect(response).not.toHaveProperty('someInternalThresholdAddedLater');
    expect(Object.keys(response).sort()).toEqual(['maxClockSkewMs', 'stomaOutputSoftWarningMl']);
    expect(() => thresholdsResponseSchema.parse(response)).not.toThrow();
  });

  /**
   * Nothing here is patient-scoped: the endpoint takes no actor, and the
   * response is the same bytes for every patient. That is the property that
   * makes it correct for this route to carry no `@Audited()` (SRS §5.2), so
   * it is worth pinning rather than leaving to a reader of the controller.
   */
  it('takes no patient identifier and returns nothing derived from one', async () => {
    const controller = controllerReturning({ softWarningMaxMl: 2000, maxClockSkewMs: 300_000 });

    expect(controller.get.length).toBe(0);
  });
});
