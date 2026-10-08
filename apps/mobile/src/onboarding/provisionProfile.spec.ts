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

import { ApiError } from '@ostomy/core/api-client';
import { SURGERY_DATE_RULE_CODE } from '@ostomy/core/validation';

import type { LocalProfile } from '../db/repositories/profileRepository';

import { lookUpProfile, provisionProfile, type ProfilePort } from './provisionProfile';

const PROFILE: LocalProfile = {
  ostomyType: 'ileostomy',
  surgeryDate: '2026-09-01',
  measurementSystem: 'metric',
};

const REQUEST = {
  ostomyType: 'ileostomy',
  surgeryDate: '2026-09-01',
  measurementSystem: 'metric',
} as const;

function port(overrides: Partial<ProfilePort>): ProfilePort {
  return {
    provision: () => Promise.resolve(PROFILE),
    read: () => Promise.resolve(PROFILE),
    ...overrides,
  };
}

const rejecting = (error: unknown) => () => Promise.reject(error);

const invalidOnboarding = (rule: string) =>
  new ApiError(400, {
    error: { code: 'INVALID_ONBOARDING', fields: [{ field: 'surgeryDate', rule }] },
  });

describe('provisionProfile', () => {
  it('returns the profile the server created', async () => {
    await expect(provisionProfile(port({}), REQUEST)).resolves.toEqual({
      status: 'provisioned',
      profile: PROFILE,
    });
  });

  it('sends exactly the three fields it was given', async () => {
    const sent: unknown[] = [];
    await provisionProfile(
      port({
        provision: (body) => {
          sent.push(body);
          return Promise.resolve(PROFILE);
        },
      }),
      REQUEST,
    );

    expect(sent).toEqual([REQUEST]);
  });

  /**
   * The profile that lands on the device is the SERVER's, not the patient's
   * answers echoed back. They are the same today, and the distinction is what
   * keeps a surgery date the server adjusted or normalised from being recorded
   * differently on the device than in the record that bounds entries.
   */
  it('carries the server’s response through, not the request', async () => {
    const serverProfile: LocalProfile = { ...PROFILE, surgeryDate: '2026-08-31' };

    await expect(
      provisionProfile(port({ provision: () => Promise.resolve(serverProfile) }), REQUEST),
    ).resolves.toEqual({ status: 'provisioned', profile: serverProfile });
  });

  describe('a 409 is a success, not an error', () => {
    /**
     * `ALREADY_ONBOARDED` is reachable without anyone doing anything wrong: a
     * retry after a request that actually landed, or a reinstall whose local store
     * is gone while the account is not. Showing an error on a form the patient
     * filled in correctly would leave them with nothing to do.
     */
    it('reads the profile the server already holds', async () => {
      const existing: LocalProfile = { ...PROFILE, ostomyType: 'colostomy' };

      await expect(
        provisionProfile(
          port({
            provision: rejecting(new ApiError(409, { error: { code: 'ALREADY_ONBOARDED' } })),
            read: () => Promise.resolve(existing),
          }),
          REQUEST,
        ),
      ).resolves.toEqual({ status: 'provisioned', profile: existing });
    });

    /**
     * And it must be the server's profile that wins, never the request — otherwise
     * a patient who re-ran onboarding with a different answer would have the device
     * bound by a date the server rejected as a duplicate and never stored.
     */
    it('does not fall back to what was submitted', async () => {
      const existing: LocalProfile = { ...PROFILE, surgeryDate: '2020-01-01' };
      const outcome = await provisionProfile(
        port({
          provision: rejecting(new ApiError(409, { error: { code: 'ALREADY_ONBOARDED' } })),
          read: () => Promise.resolve(existing),
        }),
        { ...REQUEST, surgeryDate: '2026-10-01' },
      );

      expect(outcome).toEqual({ status: 'provisioned', profile: existing });
    });

    it('reports unreachable when the follow-up read fails, because the patient does exist', async () => {
      await expect(
        provisionProfile(
          port({
            provision: rejecting(new ApiError(409, { error: { code: 'ALREADY_ONBOARDED' } })),
            read: rejecting(new TypeError('Network request failed')),
          }),
          REQUEST,
        ),
      ).resolves.toEqual({ status: 'unreachable' });
    });
  });

  describe('a refused surgery date names the rule, so the screen can say what to change', () => {
    it.each([
      SURGERY_DATE_RULE_CODE.IN_THE_FUTURE,
      SURGERY_DATE_RULE_CODE.IMPLAUSIBLY_OLD,
      SURGERY_DATE_RULE_CODE.NOT_A_DATE,
    ])('carries %s through', async (rule) => {
      await expect(
        provisionProfile(port({ provision: rejecting(invalidOnboarding(rule)) }), REQUEST),
      ).resolves.toEqual({ status: 'refused', surgeryDateRule: rule });
    });

    /**
     * `implausibly_old` is the case this path exists for: the client deliberately
     * does not know the fifty-year bound, so a slipped century reaches the server
     * looking valid and comes back named. Without this narrowing the patient would
     * get a generic failure on the one field they could fix.
     */
    it('turns a slipped century into a field-level answer', async () => {
      await expect(
        provisionProfile(port({ provision: rejecting(invalidOnboarding('implausibly_old')) }), {
          ...REQUEST,
          surgeryDate: '1025-03-04',
        }),
      ).resolves.toEqual({
        status: 'refused',
        surgeryDateRule: SURGERY_DATE_RULE_CODE.IMPLAUSIBLY_OLD,
      });
    });

    it('reports failed for a 400 about some other field, rather than blaming the date', async () => {
      await expect(
        provisionProfile(
          port({
            provision: rejecting(
              new ApiError(400, {
                error: {
                  code: 'INVALID_ONBOARDING',
                  fields: [{ field: 'ostomyType', rule: 'invalid_value' }],
                },
              }),
            ),
          }),
          REQUEST,
        ),
      ).resolves.toEqual({ status: 'failed' });
    });

    it('reports failed for a rule code this build has no copy for', async () => {
      await expect(
        provisionProfile(
          port({ provision: rejecting(invalidOnboarding('surgery_date_on_a_tuesday')) }),
          REQUEST,
        ),
      ).resolves.toEqual({ status: 'failed' });
    });

    it.each([
      ['a body that is not an object', 'nope'],
      ['a body with no error', {}],
      ['fields that are not an array', { error: { fields: 'surgeryDate' } }],
      ['an entry that is not an object', { error: { fields: ['surgeryDate'] } }],
    ])('reports failed for %s rather than throwing', async (_label, body) => {
      await expect(
        provisionProfile(port({ provision: rejecting(new ApiError(400, body)) }), REQUEST),
      ).resolves.toEqual({ status: 'failed' });
    });
  });

  describe('unknown fate is kept apart from a dead end', () => {
    /**
     * §9.3's category, applied to the one write that is not queued: a retry is the
     * right offer, and it is safe, because a second call that finds the patient
     * provisioned comes back as the profile rather than an error.
     */
    it.each([
      ['a network failure', new TypeError('Network request failed')],
      ['a 500', new ApiError(500, {})],
      ['a 503', new ApiError(503, {})],
    ])('reports unreachable for %s', async (_label, error) => {
      await expect(
        provisionProfile(port({ provision: rejecting(error) }), REQUEST),
      ).resolves.toEqual({ status: 'unreachable' });
    });

    it.each([
      ['a 401', new ApiError(401, {})],
      ['a 403', new ApiError(403, {})],
    ])('reports failed for %s, which a retry does not fix', async (_label, error) => {
      await expect(
        provisionProfile(port({ provision: rejecting(error) }), REQUEST),
      ).resolves.toEqual({ status: 'failed' });
    });
  });
});

describe('lookUpProfile', () => {
  it('returns the profile when the server has one', async () => {
    await expect(lookUpProfile(port({}))).resolves.toEqual({
      status: 'found',
      profile: PROFILE,
    });
  });

  /**
   * The one answer that routes a signed-in patient to the three questions. It has
   * to be told apart from every other failure: showing the questions on a network
   * error would walk someone who IS provisioned through a form whose submit can
   * only 409.
   */
  it('reads a 403 PATIENT_NOT_PROVISIONED as "this patient is new"', async () => {
    await expect(
      lookUpProfile(
        port({
          read: rejecting(new ApiError(403, { error: { code: 'PATIENT_NOT_PROVISIONED' } })),
        }),
      ),
    ).resolves.toEqual({ status: 'not-provisioned' });
  });

  it.each([
    ['a network failure', new TypeError('Network request failed')],
    ['a 500', new ApiError(500, {})],
    ['a 401', new ApiError(401, {})],
  ])('reports unreachable for %s rather than "new"', async (_label, error) => {
    await expect(lookUpProfile(port({ read: rejecting(error) }))).resolves.toEqual({
      status: 'unreachable',
    });
  });
});
