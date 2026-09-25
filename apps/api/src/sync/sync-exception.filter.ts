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
import {
  isSyncProtocolErrorCode,
  SYNC_PROTOCOL_ERROR_CODE,
  type SyncProtocolErrorCode,
  type SyncProtocolErrorResponse,
} from '@ostomy/core/sync';

import { SyncProtocolException } from './sync-protocol.error';

/**
 * The code a 5xx carries. Deliberately **outside** §6.1's closed set: that
 * table enumerates protocol errors, which are client bugs, and a server
 * failure is not one. Matches what the global `ErrorSanitizerFilter` emits
 * for a 500 elsewhere in the API, so one shape and one vocabulary cover
 * "the server broke" across both surfaces.
 */
const SERVER_ERROR_CODE = 'INTERNAL_ERROR';

/**
 * Guarantees that **every** non-2xx response leaving `/api/v1/sync/**` is
 * exactly `{ "error": { "code": <SyncProtocolErrorCode> } }` and nothing
 * else. This is the filter `docs/sync-contract.md` §6.1 owes this sprint.
 *
 * ## Why a second filter, when `ErrorSanitizerFilter` is already global
 *
 * The global filter (P2.S1a, `http/error-sanitizer.filter.ts`) guarantees a
 * *safe* body — no framework message, nothing derived from the request. It
 * does not guarantee *this* body. Its neutral shape uses HTTP-derived codes
 * (`BAD_REQUEST`, `PAYLOAD_TOO_LARGE`), and §6.1 pins a closed vocabulary of
 * seven protocol codes instead, because the code is the thing two
 * independent client implementations log for the same server condition.
 * Without it, P2.S1b and P2.S2b each invent a shape and neither can read the
 * other's diagnostics.
 *
 * This filter is bound to `SyncController` and runs first; the global one
 * stays the backstop for everything else.
 *
 * ## What §6.1 warns will otherwise leak through
 *
 * Three framework defaults, each of which produces a different envelope:
 *
 *  - A NestJS `ValidationPipe` emits `{"statusCode":400,"message":[...]}`,
 *    and with the `forbidNonWhitelisted` §2 requires, those messages read
 *    `property patientId should not exist` — echoing a client-supplied key
 *    straight back, which §6.2 forbids. (This module decodes with zod in
 *    its own pipe rather than `ValidationPipe`, so that shape should never
 *    arise here; the filter does not rely on that being true.)
 *  - Express's body-size limit produces its own `PayloadTooLargeError`.
 *  - `JwtAuthGuard` (P1.S1) throws `{"code":"AUTH_MISSING_TOKEN"}` — a
 *    different envelope *and* a different vocabulary from `UNAUTHENTICATED`.
 *
 * ## The `UNAUTHENTICATED` decision
 *
 * §6.1 flagged that the guard's `AUTH_*` codes and the contract's
 * `UNAUTHENTICATED` disagreed, and that `UNAUTHENTICATED` was a code nothing
 * emitted. Resolved in favour of the contract: **every `401` leaving this
 * surface becomes `UNAUTHENTICATED`**, and the guard keeps its finer-grained
 * codes everywhere else (the observations endpoints already return them).
 *
 * The contract is the artifact two independent implementations read, and it
 * already said `UNAUTHENTICATED`, so a client coded against the document
 * keeps working. The detail is not lost to anyone who needs it: whether a
 * token was missing or expired is something the client can determine from
 * its own state, and the server still logs the distinction.
 */
@Catch()
export class SyncExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(SyncExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof SyncProtocolException) {
      // Already this shape, built from the closed code set.
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }

    const status = statusOf(exception);

    // A 5xx is not a protocol error and must not be dressed as one. §6.1's
    // table enumerates CLIENT bugs; §9.3 tells a client to treat a 5xx as an
    // unknown outcome and re-push, which is the opposite instruction from
    // "this request was wrong, do not retry it unchanged." Handing it
    // MALFORMED_REQUEST would route a server failure into the client's
    // do-not-retry path and strand the batch.
    //
    // So the code set does not stretch to cover it: the body keeps the same
    // `error.code` shape for one parser on the client, with a code outside
    // §6.1's closed set. §8 already requires clients to tolerate a code they
    // do not recognise, and the status is what carries the meaning here.
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logServerError(exception);
      response.status(status).json({ error: { code: SERVER_ERROR_CODE } });
      return;
    }

    // The rejection's OWN code first, status only as a fallback.
    //
    // Mapping by status alone is what made every 403 `UNAUTHENTICATED` (#80),
    // including `PATIENT_NOT_PROVISIONED` — a condition that is not an
    // authentication failure and needs the opposite client behaviour. A status
    // cannot tell "no token" from "no patient record", so it must not be the
    // only thing consulted.
    const code = protocolCodeOf(exception) ?? protocolCodeForStatus(status);
    const body: SyncProtocolErrorResponse = { error: { code } };
    response.status(status).json(body);
  }

  /**
   * As in `ErrorSanitizerFilter`: the error's `name` always, its `message`
   * only when the type declares itself value-free via `phiSafeMessage`.
   * A push batch is the largest concentration of clinical values this API
   * handles, so an unwrapped message here is the worst available log line.
   */
  private logServerError(exception: unknown): void {
    if (isPhiSafeError(exception)) {
      this.logger.error(`${exception.name}: ${exception.message}`);
      return;
    }
    const name = exception instanceof Error ? exception.name : typeof exception;
    this.logger.error(
      `Unhandled ${name} on a sync route. Message withheld: it was not produced by ` +
        'an error type that declares its message value-free, and a sync request body ' +
        'is a batch of clinical values.',
    );
  }
}

interface PhiSafeError extends Error {
  readonly phiSafeMessage: true;
}

function isPhiSafeError(value: unknown): value is PhiSafeError {
  return value instanceof Error && (value as Partial<PhiSafeError>).phiSafeMessage === true;
}

function statusOf(exception: unknown): number {
  return exception instanceof HttpException
    ? exception.getStatus()
    : HttpStatus.INTERNAL_SERVER_ERROR;
}

/**
 * Maps an HTTP status onto §6.1's closed code set.
 *
 * Every 4xx that is not one of the specific statuses §6.1 names collapses to
 * `MALFORMED_REQUEST` — a 404 on an unknown sync path, a 405, a 415. That is
 * the honest reading: from the client's side each of those is "this request
 * was not something the server accepts", and inventing a code outside §6.1's
 * table to describe it would put a value on the wire no client has been told
 * to expect.
 *
 * Only 4xx reaches this function — `catch` handles 5xx before calling it,
 * for the reason given there.
 */
/**
 * The §6.1 code an exception names for itself, when it names one.
 *
 * Reads the code off an `ObservationRejectedException`-shaped error and keeps
 * it **only if §6.1 defines it**, via `isSyncProtocolErrorCode`. That guard is
 * the point rather than a formality: `observation-rejection.ts` carries codes
 * this surface has never promised a client (`UNSUPPORTED_CODE`,
 * `ENTITY_ID_CONFLICT`), and §6.1's set is closed precisely so that two client
 * implementations log the same value for the same server condition. Letting an
 * unvetted string through would put a code on the wire no client was told to
 * expect — which §8 notes is not a safely additive change.
 *
 * Deliberately structural rather than an `instanceof`: the sync module does not
 * import the observations module's exception class, and a shape check keeps
 * that boundary while still reading the one field that matters.
 */
function protocolCodeOf(exception: unknown): SyncProtocolErrorCode | undefined {
  if (!(exception instanceof HttpException)) return undefined;
  const body = exception.getResponse();
  if (typeof body !== 'object' || body === null) return undefined;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && isSyncProtocolErrorCode(code) ? code : undefined;
}

function protocolCodeForStatus(status: number): SyncProtocolErrorCode {
  if (status === HttpStatus.UNAUTHORIZED || status === HttpStatus.FORBIDDEN) {
    return SYNC_PROTOCOL_ERROR_CODE.UNAUTHENTICATED;
  }
  if (status === HttpStatus.PAYLOAD_TOO_LARGE) {
    return SYNC_PROTOCOL_ERROR_CODE.BATCH_TOO_LARGE;
  }
  if (status === HttpStatus.CONFLICT) {
    return SYNC_PROTOCOL_ERROR_CODE.CURSOR_TOO_OLD;
  }
  return SYNC_PROTOCOL_ERROR_CODE.MALFORMED_REQUEST;
}
