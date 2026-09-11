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
 * The barrier between Prisma's errors and this application's logs.
 *
 * P1.S5 established the finding this file acts on (`AuditPersistenceError`,
 * B3): `PrismaClientValidationError` renders the offending `data` argument
 * into its own `.message`, `logging/serializers.ts`'s `errSerializer`
 * allow-lists `message` through verbatim, and `logging/redaction.ts` matches
 * object *paths* rather than substrings inside a string. A deny-list cannot
 * reach inside a message, so the only control that works is never letting
 * the original error travel.
 *
 * P1.S5's version guarded writes to `audit_events`. This one guards the
 * observation write itself, which is where the clinical value actually is.
 * The rule for both is the same and is worth stating once more because the
 * tempting fix is the wrong one: do **not** widen `errSerializer` or the
 * redaction lists to handle this. Wrap the error at the throw site.
 *
 * What crosses this barrier: the entity id (a client-generated UUID, not a
 * clinical value), and the original error's `name` and `code` — the two
 * fields that make an incident diagnosable. Never its `message`, never its
 * `meta`, never the `data` argument.
 */

/** Postgres/Prisma unique-constraint violation. */
const UNIQUE_CONSTRAINT_ERROR_CODE = 'P2002';

function errorCodeOf(error: unknown): string | number | undefined {
  const raw = (error as { code?: unknown } | null | undefined)?.code;
  return typeof raw === 'string' || typeof raw === 'number' ? raw : undefined;
}

function modelNameOf(error: unknown): string | undefined {
  const meta = (error as { meta?: { modelName?: unknown } } | null | undefined)?.meta;
  return typeof meta?.modelName === 'string' ? meta.modelName : undefined;
}

/**
 * A unique-constraint violation raised by a write to `model`, and not by any
 * other write in the same transaction.
 *
 * The model check is not incidental (P2.S1a review, finding 9).
 * `insertWithAudit` wraps a `$transaction` containing TWO inserts — the
 * observation and its audit row — so an unqualified `P2002` test attributes
 * an **audit** constraint violation to the observation id and returns HTTP
 * 409 `ENTITY_ID_CONFLICT`. A client's offline queue reads a 409 as a
 * permanent, non-retryable conflict (`docs/sync-contract.md` §9), so it
 * stops retrying: an entry the patient made is never persisted, never
 * surfaced for correction, and the audit failure that actually caused it is
 * reported as something else entirely.
 *
 * `meta.modelName` is absent on some Prisma error shapes, so an unqualified
 * `P2002` with no model no longer reads as an id conflict — it falls through
 * to the generic wrap, which is a 500. That is the safe direction: a 500
 * tells the client the outcome is unknown and to re-push, which is true,
 * where a wrong 409 tells it to give up, which is not.
 */
export function isUniqueConstraintViolationOn(error: unknown, model: string): boolean {
  return errorCodeOf(error) === UNIQUE_CONSTRAINT_ERROR_CODE && modelNameOf(error) === model;
}

export class ObservationPersistenceError extends Error {
  /**
   * Opts this type's `message` into being logged verbatim by
   * `ErrorSanitizerFilter` (`http/error-sanitizer.filter.ts`). Safe here by
   * construction: the message is assembled from `entityId`/`action`/type
   * names and the original error's `name`/`code` only — never the original
   * error object, and never its `message`, which for a Prisma validation
   * error renders the offending `data` verbatim.
   */
  readonly phiSafeMessage = true as const;

  readonly entityId: string;
  readonly originalErrorName: string | undefined;
  readonly originalErrorCode: string | number | undefined;

  constructor(entityId: string, originalError: unknown) {
    const originalErrorName = originalError instanceof Error ? originalError.name : undefined;
    const originalErrorCode = errorCodeOf(originalError);

    super(
      `Failed to persist observation ${entityId}. ` +
        `Underlying error: ${originalErrorName ?? 'unknown'}` +
        (originalErrorCode !== undefined ? ` (code ${originalErrorCode})` : '') +
        `. The original error's message is deliberately not included — it may embed the ` +
        `offending clinical value (see this file's own doc comment).`,
    );

    this.name = 'ObservationPersistenceError';
    this.entityId = entityId;
    this.originalErrorName = originalErrorName;
    this.originalErrorCode = originalErrorCode;
    // Not `cause`: an `Error.cause` is walked by most logging and error
    // reporting, which would carry the original message straight back into
    // the log line this class exists to keep it out of.
  }
}
