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
 * Reads the `sub` claim out of a JWT, for ONE purpose: deciding which
 * patient the local database belongs to (`db/databaseOwner.ts`).
 *
 * ## This is not authentication, and must never become it
 *
 * The signature is not verified here and cannot be — this app holds no
 * JWKS and has no business validating a token it did not issue. Every
 * authorization decision in this system is made by the API, which resolves
 * the patient from the presented token's subject server-side and never
 * from anything a client sends (`docs/sync-contract.md` 2).
 *
 * What this value decides is strictly local and fails safe in one
 * direction: if it is wrong or absent, the app treats the database as
 * belonging to someone else and purges it. An attacker who forged a token
 * to manipulate this would achieve the deletion of data on a device they
 * already control, and would gain no read access to anything — the purge
 * destroys, it never discloses.
 *
 * Returning `undefined` rather than throwing for anything malformed, for
 * the same reason: `undefined` routes to "not the same owner", which is
 * the conservative branch.
 */
export function readSubjectClaim(jwt: string): string | undefined {
  const payload = jwt.split('.')[1];
  if (!payload) {
    return undefined;
  }

  try {
    // base64url -> base64. `atob` is available in React Native's Hermes
    // runtime; `Buffer` is not, without a polyfill this app does not carry.
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const claims: unknown = JSON.parse(atob(padded));

    if (typeof claims !== 'object' || claims === null) {
      return undefined;
    }
    const subject = (claims as Record<string, unknown>)['sub'];
    return typeof subject === 'string' && subject.length > 0 ? subject : undefined;
  } catch {
    // Not a JWT, not base64, not JSON. All mean the same thing here.
    return undefined;
  }
}
