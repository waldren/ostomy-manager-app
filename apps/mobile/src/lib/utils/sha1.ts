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

import * as Crypto from 'expo-crypto';

/**
 * SHA-1, for the one thing this app hashes: the id of a Quick-Add decision,
 * a UUIDv5 (`quickAddPreferenceId` in `@ostomy/core/sync`, P4.S3 slice 5).
 * Not a security use; SHA-1 is what RFC 9562 defines version 5 over.
 *
 * Wrapped so the one native call has one place, as `uuid.ts` does for
 * `randomUUID`.
 */
export async function sha1(input: Uint8Array): Promise<Uint8Array> {
  // Copied into a fresh buffer: `digest` takes an ArrayBuffer-backed view, and
  // a `Uint8Array` may in principle sit on a SharedArrayBuffer.
  return new Uint8Array(
    await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA1, new Uint8Array(input)),
  );
}
