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
import { SURGERY_DATE_RULE_CODE, type SurgeryDateRuleCode } from '@ostomy/core/validation';

import type { LocalProfile } from '../db/repositories/profileRepository';

/**
 * The profile endpoints this module needs, declared as a port rather than taken
 * as the whole generated client.
 *
 * Same reason `SyncClientPort` exists: a test supplies two functions instead of
 * stubbing a global `fetch` and a token provider, and the screen cannot reach any
 * other endpoint through it.
 */
export interface ProfilePort {
  readonly provision: (body: {
    readonly ostomyType: LocalProfile['ostomyType'];
    readonly surgeryDate: string;
    readonly measurementSystem: LocalProfile['measurementSystem'];
  }) => Promise<LocalProfile>;
  readonly read: () => Promise<LocalProfile>;
}

/**
 * What came of asking the server to create this patient.
 *
 * Four outcomes, and the distinctions are the point — three of them look like
 * "it failed" from the screen's perspective and only one of them is something the
 * patient can fix by changing what they typed.
 */
export type ProvisionOutcome =
  /** Created, or already there and now read back. The profile is what the server holds. */
  | { readonly status: 'provisioned'; readonly profile: LocalProfile }
  /**
   * The server refused the surgery date. The only outcome that names a field,
   * because it is the only one the patient can act on from this screen.
   */
  | { readonly status: 'refused'; readonly surgeryDateRule: SurgeryDateRuleCode }
  /**
   * The request did not get an answer — no network, a 5xx, a response that did
   * not parse. **Unknown fate**, the same category `docs/sync-contract.md` §9.3
   * puts a failed push in: the patient may or may not now exist server-side, so
   * the screen offers a retry and the retry is safe, because a second call to a
   * provisioned subject answers 409 and this module turns that into the profile.
   */
  | { readonly status: 'unreachable' }
  /** A refusal this build has no copy for. Reported as itself rather than guessed at. */
  | { readonly status: 'failed' };

const SURGERY_DATE_RULES: readonly string[] = Object.values(SURGERY_DATE_RULE_CODE);

/** `{ error: { code, fields: [{ field, rule }] } }`, narrowed from the server-controlled body. */
function surgeryDateRuleFrom(body: unknown): SurgeryDateRuleCode | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return undefined;
  const fields = (error as { fields?: unknown }).fields;
  if (!Array.isArray(fields)) return undefined;

  for (const entry of fields) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { field, rule } = entry as { field?: unknown; rule?: unknown };
    if (field !== 'surgeryDate') continue;
    if (typeof rule === 'string' && SURGERY_DATE_RULES.includes(rule)) {
      return rule as SurgeryDateRuleCode;
    }
  }
  return undefined;
}

/**
 * Creates this patient and their profile (P4.S1 slice 2, SRS §3.0).
 *
 * ## Online, and that is not a gap
 *
 * Every other write in this app goes to local SQLite first and syncs later. This
 * one cannot: a sync push requires a provisioned patient, so the bootstrap cannot
 * be the thing that needs the bootstrap. It also does not need to be offline —
 * the patient has just completed an OIDC sign-in, so they had a connection
 * seconds ago. What the screen owes them is an honest retry when that connection
 * has since gone, which `unreachable` is for.
 *
 * ## A 409 is a success here
 *
 * `ALREADY_ONBOARDED` means the server already has this patient — a retry after
 * an `unreachable` whose request actually landed, or a reinstall whose local
 * store is gone while the account is not. The right answer is not an error on a
 * form the patient has already filled in correctly: it is to read the profile the
 * server holds and carry on with THAT, which is also what keeps the device from
 * believing a surgery date the server never accepted.
 *
 * If that read then fails, the outcome is `unreachable` rather than `failed`: the
 * patient is provisioned and one more attempt will find it.
 */
export async function provisionProfile(
  port: ProfilePort,
  request: {
    readonly ostomyType: LocalProfile['ostomyType'];
    readonly surgeryDate: string;
    readonly measurementSystem: LocalProfile['measurementSystem'];
  },
): Promise<ProvisionOutcome> {
  try {
    const profile = await port.provision(request);
    return { status: 'provisioned', profile };
  } catch (error) {
    if (!(error instanceof ApiError)) return { status: 'unreachable' };

    if (error.status === 409) return readExisting(port);

    if (error.status === 400) {
      /**
       * Read through the one accessor for a refusal body, which exists because a
       * refusal is clinically expressive — a surgery-date rule discloses that this
       * subject has a surgery date (`docs/sync-contract.md` §6.3). It goes onto the
       * screen in front of the patient and nowhere else: not a log, not a report.
       */
      const rule = surgeryDateRuleFrom(error.refusalForPatientOnThisDevice());
      if (rule !== undefined) return { status: 'refused', surgeryDateRule: rule };
      return { status: 'failed' };
    }

    /**
     * A 5xx is unknown fate and retryable; a 401/403 is not something a retry
     * fixes. Both are told apart here rather than at the screen, so the copy
     * decision is made once.
     */
    if (error.status >= 500) return { status: 'unreachable' };
    return { status: 'failed' };
  }
}

/** Reads the profile the server already holds, after a 409. */
async function readExisting(port: ProfilePort): Promise<ProvisionOutcome> {
  try {
    return { status: 'provisioned', profile: await port.read() };
  } catch {
    // The patient IS provisioned — the 409 said so — so this is a connection
    // problem rather than a dead end, and a retry resolves it.
    return { status: 'unreachable' };
  }
}

/**
 * Reads the server's profile for a patient this device has no row for.
 *
 * Separate from `provisionProfile` because the answers mean different things: a
 * 403 `PATIENT_NOT_PROVISIONED` here is not a failure at all, it is the fact that
 * routes the patient to onboarding. Anything else is unknown, and `ProfileProvider`
 * must not show the three questions on unknown — see its comment.
 */
export type ProfileLookup =
  | { readonly status: 'found'; readonly profile: LocalProfile }
  | { readonly status: 'not-provisioned' }
  | { readonly status: 'unreachable' };

export async function lookUpProfile(port: ProfilePort): Promise<ProfileLookup> {
  try {
    return { status: 'found', profile: await port.read() };
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
      return { status: 'not-provisioned' };
    }
    return { status: 'unreachable' };
  }
}
