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

import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';

/**
 * Global filter. Guarantees that **no framework- or library-authored error
 * message ever reaches a client or a log line.**
 *
 * ## Why this exists (P2.S1a review, finding H1)
 *
 * Before it, `apps/api` had no exception filter at all, so anything thrown
 * outside a handler got Nest's defaults:
 *
 *  - **Malformed JSON.** `express.json()` throws a `SyntaxError`, and the
 *    Express adapter maps it to `new BadRequestException(error.message)`.
 *    That message is V8's `JSON.parse` text, which quotes a window of the
 *    raw input around the error position — for a body the size of an
 *    observation, effectively the whole payload. A body corrupted in
 *    transit, double-encoded by a proxy, or carrying one stray character
 *    came back with the patient's own clinical value in the 400, which the
 *    mobile client then persists in its correction queue.
 *    `docs/sync-contract.md` §6.3 forbids precisely that.
 *  - **A bad percent-escape in the path** (`/observations/%FF`) throws
 *    `URIError` through the same mapping.
 *  - **An oversized body.** `PayloadTooLargeError` is not a `SyntaxError`,
 *    so it missed that mapping entirely and surfaced as a **500**, logged
 *    with a stack, for what is a client error with a defined status.
 *
 * ## Why global, and why it must be
 *
 * A first attempt bound this to `ObservationsController` with `@UseFilters`.
 * That does not work and the integration test proved it: `express.json()`
 * runs as **middleware, before routing**, so a controller-scoped filter is
 * never reached — the request never got as far as being that controller's.
 * Only a globally-registered filter sees it. Registered via `APP_FILTER` in
 * `ErrorSanitizerModule` rather than `useGlobalFilters()` in `main.ts`, so
 * every `Test.createTestingModule({ imports: [AppModule.register(...)] })`
 * gets it too — a filter present in production and absent under test is a
 * filter whose tests prove nothing.
 *
 * ## What it emits
 *
 * One neutral, message-free body: `{ error: { code } }`, where `code` comes
 * from a closed set keyed off the HTTP status. Never a `message`, never a
 * field name, never a value.
 *
 * Exceptions this codebase authors deliberately pass through untouched —
 * `ObservationRejectedException`'s `{ error: { code, errors } }` and the auth
 * guards' `{ code }` — because their bodies are built field by field from a
 * closed vocabulary, which is the property that makes them safe. What gets
 * rewritten is anything carrying the framework's own envelope keys
 * (`statusCode`/`message`) or a bare string body. See `isSafeAuthoredBody()`
 * for why the check is shaped that way round.
 */
@Catch()
export class ErrorSanitizerFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorSanitizerFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();

      // Authored by this codebase, so its shape is a closed vocabulary and
      // it is forwarded as-is. Nest's own default — a bare string, or
      // `{ statusCode, message, error }` with a framework message inside —
      // is rewritten below.
      if (isSafeAuthoredBody(body)) {
        response.status(status).json(body);
        return;
      }

      response.status(status).json({ error: { code: codeForStatus(status) } });
      return;
    }

    // Not an HttpException: a bug, or an error that escaped its wrapper.
    this.logServerError(exception);
    response
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json({ error: { code: codeForStatus(HttpStatus.INTERNAL_SERVER_ERROR) } });
  }

  /**
   * A 500 must still be diagnosable. Catching everything took that job from
   * Nest's `BaseExceptionFilter.handleUnknownError`, which logged
   * `exception.message` and a stack — safe for the errors this repo builds
   * to be value-free, and the PHI-leak path for anything else, because
   * `logging/serializers.ts`'s `errSerializer` allow-lists `message` through
   * and a `PrismaClientValidationError`'s message renders the offending
   * `data` verbatim.
   *
   * So: the error's constructor `name` always, and its `message` only when
   * the error type declares itself value-free by setting `phiSafeMessage`.
   * `ObservationPersistenceError` and `AuditPersistenceError` both do.
   * Anything else is logged by name alone — enough to know what threw and
   * where to look, without trusting text this module did not author.
   */
  private logServerError(exception: unknown): void {
    if (isPhiSafeError(exception)) {
      this.logger.error(`${exception.name}: ${exception.message}`);
      return;
    }

    const name = exception instanceof Error ? exception.name : typeof exception;
    this.logger.error(
      `Unhandled ${name}. Message withheld: it was not produced by an error type ` +
        'that declares its message value-free, and may embed a clinical value.',
    );
  }
}

/** Errors that opt in to having their `message` logged — see `logServerError`. */
interface PhiSafeError extends Error {
  readonly phiSafeMessage: true;
}

function isPhiSafeError(value: unknown): value is PhiSafeError {
  return value instanceof Error && (value as Partial<PhiSafeError>).phiSafeMessage === true;
}

/**
 * `true` for an object body this codebase built, `false` for Nest's defaults.
 *
 * Authored bodies here come in two shapes — `{ code }` from the auth guards
 * and `{ error: { code, errors } }` from the observations module — and both
 * are safe for the same reason: every field is drawn from a closed
 * vocabulary this repo defines. Nest's defaults are a bare string, or
 * `{ statusCode, message, error }` with a framework- or V8-authored
 * `message` inside.
 *
 * So the test is not "does it look like one of ours" (a list that would go
 * stale the first time someone adds a third shape) but "does it carry the
 * two keys that mark the framework's own envelope." That also enforces a
 * rule worth having: **an authored error body must never carry a `message`
 * key.** One that does gets flattened here rather than forwarded, which is
 * the safe direction — `message` is precisely the field that ends up holding
 * text nobody audited.
 *
 * A string body is never safe: that is the framework default, and
 * `new BadRequestException(err.message)` is exactly how V8's JSON.parse text
 * (which quotes the raw request body) got in front of a client.
 */
function isSafeAuthoredBody(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  return !('statusCode' in body) && !('message' in body);
}

const STATUS_CODE: Readonly<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: 'BAD_REQUEST',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHORIZED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.METHOD_NOT_ALLOWED]: 'METHOD_NOT_ALLOWED',
  [HttpStatus.NOT_ACCEPTABLE]: 'NOT_ACCEPTABLE',
  [HttpStatus.CONFLICT]: 'CONFLICT',
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: 'UNSUPPORTED_MEDIA_TYPE',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'UNPROCESSABLE_ENTITY',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'PAYLOAD_TOO_LARGE',
  [HttpStatus.TOO_MANY_REQUESTS]: 'TOO_MANY_REQUESTS',
};

function codeForStatus(status: number): string {
  return STATUS_CODE[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_REFUSED');
}
