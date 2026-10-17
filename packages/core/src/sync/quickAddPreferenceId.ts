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

import type { MeasurementSystem } from '../units/types.js';
import { uuidV5FromSha1, uuidV5HashInput } from '../uuid/uuidV5.js';

/**
 * Which Quick-Add routine a decision is about (P4.S3 slice 5,
 * `docs/sync-contract.md` §7.7): the fields the device groups entries by.
 */
export interface QuickAddRoutine {
  readonly code: string;
  readonly valueMl: number | null;
  readonly method: string | null;
  readonly fluidTypeCode: string | null;
  readonly urineColorCode: string | null;
  readonly enteredMeasurementSystem: MeasurementSystem;
}

/**
 * The routine as one string, the same on every device and on the server.
 *
 * The volume goes through `Number` and back: the device stores the text the
 * patient typed ("350.50") and the server a decimal, and both must name the
 * same routine. Every other field is a code, compared exactly. The separator
 * is a character none of these values may contain.
 */
export function quickAddRoutineKey(routine: QuickAddRoutine): string {
  return [
    routine.code,
    routine.valueMl === null ? '' : String(routine.valueMl),
    routine.method ?? '',
    routine.fluidTypeCode ?? '',
    routine.urineColorCode ?? '',
    routine.enteredMeasurementSystem,
  ].join('|');
}

/**
 * The id of a patient's decision about one routine: a UUIDv5 of the routine
 * key, with the patient's profile id as the namespace.
 *
 * Derived rather than random so that two devices deciding about the same
 * widget write the same row (§7.7). The profile id is the namespace because it
 * is the patient's own stable identifier that a device already holds (§7.5),
 * which also keeps two patients with the same routine on different rows.
 *
 * SHA-1 is passed in: this package has no hash of its own, and each side has
 * one (Node's `crypto` on the server, `expo-crypto` on the phone, which is
 * asynchronous). Not a security use — SHA-1 is what RFC 9562 defines v5 over.
 */
export async function quickAddPreferenceId(
  profileId: string,
  routine: QuickAddRoutine,
  sha1: (input: Uint8Array) => Uint8Array | Promise<Uint8Array>,
): Promise<string> {
  return uuidV5FromSha1(await sha1(uuidV5HashInput(profileId, quickAddRoutineKey(routine))));
}
