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

import type { SyncDeltaChange, SyncDeltaTombstone } from './delta.js';
import type { EntityId, ServerSequence } from './identifiers.js';
import type { ObservationSyncPayload, WireInstant } from './payload.js';

/**
 * Type-level proof that a tombstone change entry carries no `payload`
 * (`docs/sync-contract.md` §5.2).
 *
 * This is a PHI-exposure control, not a tidiness rule: "sending the
 * clinical values of a deleted entry would transmit PHI that serves no
 * purpose, and the minimum-necessary rule applies to a protocol as much as
 * to a screen." The receiving device needs the entity id to remove its
 * local row and nothing else.
 *
 * `payload?: ObservationSyncPayload` on a single change type would satisfy
 * the wire format and put the decision at every call site that builds one.
 * The tombstone variant not having the property at all puts it in the
 * build.
 *
 * This file has no runtime assertions and is never imported by anything —
 * the proof IS the compile errors suppressed below, checked by
 * `pnpm typecheck`.
 */

type Equals<TLeft, TRight> =
  (<TProbe>() => TProbe extends TLeft ? 1 : 2) extends <TProbe>() => TProbe extends TRight ? 1 : 2
    ? true
    : false;

type Expect<TAssertion extends true> = TAssertion;

/**
 * Adding `payload` — or any other property that could carry clinical
 * content, such as a "last known values" convenience field — makes
 * `Equals` resolve to `false` and fails the build with "Type 'false' does
 * not satisfy the constraint 'true'". `clientUpdatedAt` IS in this set:
 * §5.2 puts it on both arms so a device can resolve an unpushed local
 * edit against an incoming delete by the same last-write-wins rule the
 * server applies. It is a write timestamp, not clinical content.
 */
type _TombstoneCarriesExactlyTheseKeys = Expect<
  Equals<
    keyof SyncDeltaTombstone,
    'entityId' | 'serverSequence' | 'clientUpdatedAt' | 'entityType' | 'deleted'
  >
>;

declare const change: SyncDeltaChange;

// @ts-expect-error — not present on every arm of the union; narrow on `deleted` first.
void change.payload;

if (change.deleted) {
  // @ts-expect-error — a tombstone carries no payload (§5.2): entity id in, clinical values never out.
  void change.payload;
} else {
  // The live arm has one, non-optionally.
  const payload: ObservationSyncPayload = change.payload;
  void payload;
}

declare const entityId: EntityId;
declare const serverSequence: ServerSequence;
declare const clientUpdatedAt: WireInstant;
declare const payload: ObservationSyncPayload;

const tombstoneWithPayload: SyncDeltaTombstone = {
  entityType: 'Observation',
  entityId,
  serverSequence,
  deleted: true,
  clientUpdatedAt,
  // @ts-expect-error — object literal may only specify known properties; a tombstone has nowhere to put clinical values.
  payload,
};
void tombstoneWithPayload;

// The legitimate tombstone shape typechecks with no suppression needed.
const tombstone: SyncDeltaTombstone = {
  entityType: 'Observation',
  entityId,
  serverSequence,
  deleted: true,
  clientUpdatedAt,
};
void tombstone;

export type { _TombstoneCarriesExactlyTheseKeys };
