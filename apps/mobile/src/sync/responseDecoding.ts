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

import type {
  Observation,
  SyncDeltaChange,
  SyncDeltaResponse,
  SyncOperationResult,
  SyncPushResponse,
} from '@ostomy/core/api-client';

/**
 * The decode boundary between the generated API client and this app.
 *
 * ## Why it exists at all
 *
 * `docs/sync-contract.md` models a push result as a discriminated union:
 * `appliedServerSequence` is present on `accepted`/`superseded` and absent
 * on `rejected`, `reasonCode`/`field` the other way round, and
 * `packages/core/src/sync` encodes exactly that. The **generated** client
 * cannot: OpenAPI flattens a union into one object with optional members,
 * so `@ostomy/core/api-client`'s `SyncOperationResult` has every field
 * optional and a three-valued `status`.
 *
 * That flattening is not a defect in the generator — it is what the schema
 * language can express — but it means the type the app receives no longer
 * makes the contract's invariants true. An `accepted` result with no
 * `appliedServerSequence` typechecks, and `String(undefined)` would write
 * the literal text `"undefined"` into `observations.server_sequence`.
 *
 * So the response is treated as what it is: **untrusted input**, decoded
 * once, here, into shapes whose fields are guaranteed. Same "decode, don't
 * cast" discipline `db/types.ts` applies to a SQLite row, for the same
 * reason.
 *
 * ## What an undecodable result must NOT become
 *
 * Not a rejection. §9.3: a rejection is only ever a `rejected` result the
 * server actually sent; anything else leaves the operation's fate unknown,
 * and the recovery is to re-push and let idempotency settle it (§3.7).
 * `undecodable` therefore means "this result settles nothing" — the caller
 * leaves the operation on the queue.
 *
 * ## Unknown values degrade, never throw
 *
 * §8 makes a new `reasonCode` additive and requires an old client to
 * tolerate it, with §6.4 spelling out how: degrade to the generic "this
 * entry could not be saved" and keep the code for diagnostics. So an
 * unrecognized `reasonCode` decodes as a rejection carrying that code
 * verbatim — it is the *renderer's* job to notice it has no patient-facing
 * copy, not this decoder's job to reject it.
 */

export type DecodedPushResult =
  | {
      readonly kind: 'applied';
      readonly status: 'accepted' | 'superseded';
      readonly operationId: string;
      readonly entityId: string;
      readonly appliedServerSequence: string;
    }
  | {
      readonly kind: 'rejected';
      readonly operationId: string;
      readonly entityId: string;
      readonly reasonCode: string;
      /** `null` when the server named none. Never invented — §6.1/§6.3 forbid echoing a path the server did not send. */
      readonly field: string | null;
    }
  | {
      readonly kind: 'undecodable';
      /** Present whenever the result named an operation at all; the caller needs it to leave that row alone. */
      readonly operationId: string | undefined;
    };

export function decodePushResults(response: SyncPushResponse): DecodedPushResult[] {
  return response.results.map(decodePushResult);
}

function decodePushResult(result: SyncOperationResult): DecodedPushResult {
  const operationId = nonEmptyString(result.operationId);
  const entityId = nonEmptyString(result.entityId);

  if (operationId === undefined || entityId === undefined) {
    return { kind: 'undecodable', operationId };
  }

  if (result.status === 'rejected') {
    const reasonCode = nonEmptyString(result.reasonCode);
    if (reasonCode === undefined) {
      // A rejection the server refused to explain. Still a rejection — §9.1
      // forbids dropping it and §9.2 forbids retrying it unchanged — so it
      // must not decode as `undecodable`, which would put it straight back
      // on the queue for an unchanged retry. It carries a code this app
      // recognises as "no copy", which §6.4 already renders generically.
      return {
        kind: 'rejected',
        operationId,
        entityId,
        reasonCode: UNSPECIFIED_REJECTION_CODE,
        field: null,
      };
    }
    return {
      kind: 'rejected',
      operationId,
      entityId,
      reasonCode,
      field: nonEmptyString(result.field) ?? null,
    };
  }

  if (result.status === 'accepted' || result.status === 'superseded') {
    const appliedServerSequence = nonEmptyString(result.appliedServerSequence);
    if (appliedServerSequence === undefined) {
      // §3.6 requires it on both. Without it there is nothing to stamp, and
      // removing the operation from the queue on the strength of a result
      // this malformed would lose the write. Fate unknown; re-push.
      return { kind: 'undecodable', operationId };
    }
    return {
      kind: 'applied',
      status: result.status,
      operationId,
      entityId,
      appliedServerSequence,
    };
  }

  // A status outside the three §3.5 defines. §8 makes response additions
  // tolerable, but a fourth STATUS is not additive — it changes what the
  // client must do — so this degrades to "settles nothing" rather than
  // guessing.
  return { kind: 'undecodable', operationId };
}

/**
 * The code recorded when a server rejects an operation without saying why.
 *
 * Deliberately not a member of `SyncReasonCode`: it is this client's own
 * marker for a malformed response, not something the wire ever carries, and
 * putting it in the shared vocabulary would let a server appear to send it.
 * It has no patient-facing copy, which routes it to §6.4's generic message —
 * the correct rendering for a code that explains nothing.
 */
export const UNSPECIFIED_REJECTION_CODE = 'REJECTED_WITHOUT_REASON_CODE';

export type DecodedDeltaChange =
  | {
      readonly kind: 'tombstone';
      readonly entityType: 'Observation' | 'Meal';
      readonly entityId: string;
      readonly serverSequence: string;
      readonly clientUpdatedAt: string;
    }
  | {
      readonly kind: 'upsert';
      readonly entityType: 'Observation';
      readonly entityId: string;
      readonly serverSequence: string;
      readonly clientUpdatedAt: string;
      readonly payload: Observation;
    }
  | {
      readonly kind: 'meal-upsert';
      readonly entityId: string;
      readonly serverSequence: string;
      readonly clientUpdatedAt: string;
      readonly payload: {
        readonly id: string;
        readonly description: string | null;
        readonly size: string;
        readonly tagCodes: readonly string[];
        readonly effectiveDateTime: string;
        readonly enteredTimezone: string;
      };
    }
  /**
   * An entity type this build does not handle.
   *
   * Distinct from `undecodable`, which means the server sent something
   * malformed. This one is well-formed and simply not ours yet — and
   * `docs/sync-contract.md` §8 has required clients to tolerate a new
   * `entityType` since P2.S0: the client skips it and **still advances its
   * cursor**, which is safe because §5.3's invariant is about never being
   * DENIED a change, not about applying every one. A client that later learns
   * the type re-syncs from `since=0`.
   *
   * Counted separately so a pull that is quietly dropping half the server's
   * changes is visible rather than looking like an empty day.
   */
  | { readonly kind: 'unsupported-entity'; readonly entityType: string }
  | { readonly kind: 'undecodable' };

export interface DecodedDeltaPage {
  readonly changes: readonly DecodedDeltaChange[];
  readonly cursor: string;
  readonly hasMore: boolean;
}

export function decodeDeltaPage(response: SyncDeltaResponse): DecodedDeltaPage {
  return {
    changes: response.changes.map(decodeDeltaChange),
    cursor: String(response.cursor),
    hasMore: response.hasMore === true,
  };
}

function decodeDeltaChange(change: SyncDeltaChange): DecodedDeltaChange {
  const entityId = nonEmptyString(change.entityId);
  const serverSequence = nonEmptyString(change.serverSequence);
  const clientUpdatedAt = nonEmptyString(change.clientUpdatedAt);

  if (entityId === undefined || serverSequence === undefined || clientUpdatedAt === undefined) {
    return { kind: 'undecodable' };
  }

  // BEFORE any payload interpretation, and that order is the whole fix. This
  // decoder used to branch only on `deleted` and payload presence, so once the
  // server began sending `Meal` changes (P3.S1) a meal decoded as an
  // observation upsert and `deltaPull` wrote its fields into the observations
  // table — a well-formed row of nonsense, with no error anywhere.
  if (change.entityType !== 'Observation' && change.entityType !== 'Meal') {
    return { kind: 'unsupported-entity', entityType: String(change.entityType) };
  }

  if (change.deleted) {
    // One tombstone shape for both, carrying which table it belongs to. §5.2
    // gives a tombstone no payload at all, so there is nothing entity-specific
    // left to decode — only somewhere to apply it.
    return {
      kind: 'tombstone',
      entityType: change.entityType,
      entityId,
      serverSequence,
      clientUpdatedAt,
    };
  }

  if (change.payload === undefined) {
    // §5.2 gives an upsert a payload and a tombstone none. A change that is
    // neither is uninterpretable, and writing a row from it would invent
    // clinical values. Skipped — and note the cursor still advances past it
    // (`applyDeltaPage`), because re-requesting the same malformed page
    // forever is the worse failure.
    return { kind: 'undecodable' };
  }

  if (change.entityType === 'Meal') {
    const meal = decodeMealPayload(change.payload);
    // A meal whose payload is not the §7.4 shape is skipped rather than
    // written with invented fields — `size` in particular is a mandatory
    // clinical judgement (AC 2.4 AC2), and defaulting it would record an
    // answer the patient never gave.
    return meal === undefined
      ? { kind: 'undecodable' }
      : { kind: 'meal-upsert', entityId, serverSequence, clientUpdatedAt, payload: meal };
  }

  return {
    kind: 'upsert',
    entityType: 'Observation',
    entityId,
    serverSequence,
    clientUpdatedAt,
    payload: change.payload,
  };
}

/**
 * Narrows a delta payload to the §7.4 Meal shape.
 *
 * The generated client types `SyncDeltaChange.payload` as an `Observation`,
 * because OpenAPI cannot express a payload that varies with `entityType`. So
 * a meal arrives typed as something it is not, and this is the decode that
 * makes it what it is — the same "decode, don't cast" boundary this file
 * exists for.
 */
function decodeMealPayload(
  payload: unknown,
): Extract<DecodedDeltaChange, { kind: 'meal-upsert' }>['payload'] | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const raw = payload as Record<string, unknown>;

  const id = nonEmptyString(raw.id);
  const size = nonEmptyString(raw.size);
  const effectiveDateTime = nonEmptyString(raw.effectiveDateTime);
  const enteredTimezone = nonEmptyString(raw.enteredTimezone);
  if (
    id === undefined ||
    size === undefined ||
    effectiveDateTime === undefined ||
    enteredTimezone === undefined
  ) {
    return undefined;
  }

  return {
    id,
    description: typeof raw.description === 'string' ? raw.description : null,
    size,
    // Absent or malformed becomes no tags rather than undecodable: tags are an
    // optional annotation, and losing them degrades the row where refusing it
    // would lose the meal.
    tagCodes: Array.isArray(raw.tagCodes)
      ? raw.tagCodes.filter((code): code is string => typeof code === 'string')
      : [],
    effectiveDateTime,
    enteredTimezone,
  };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
