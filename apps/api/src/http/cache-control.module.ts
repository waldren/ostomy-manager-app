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
  Inject,
  Module,
  RequestMethod,
  type MiddlewareConsumer,
  type NestModule,
  type OnModuleInit,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';

/**
 * Nothing this API answers may be kept by an HTTP cache (#152).
 *
 * Found on the Android emulator: React Native's networking (OkHttp) keeps a
 * disk cache, and with no `Cache-Control` header and Express's automatic
 * `ETag` it stored the profile, the patient's target ranges and every sync
 * delta page there, in plain text. That is outside the SQLCipher store
 * (ADR-0014), outside its one-subject binding, and outside the sign-out
 * purge, so a shared phone kept the previous patient's diary on disk after
 * the "everything is deleted" path. Every response here is either PHI or is
 * cached by the client in its own encrypted store already, so the rule is
 * every route, not a list of PHI routes that the next endpoint is missing from.
 *
 * Two parts, because either alone leaves a hole:
 *
 * - `Cache-Control: no-store` stops a cache WRITING a response. It does not
 *   remove an entry written before this change; `apps/mobile` deletes those.
 * - Express's ETag is turned off, so the API never answers `304 Not Modified`.
 *   A client still holding an entry from before sent `If-None-Match`, and a
 *   304 tells it to keep using what it stored. It was also a bug in its own
 *   right: the 304 reached the app's code as a non-2xx, so `GET /profile`
 *   read as "unreachable" and Settings refused every edit with "Your phone
 *   needs to connect once" while the API was answering. Measured on the
 *   emulator before and after this change.
 *
 * A module imported by `AppModule`, rather than a call in `main.ts`, so every
 * test that builds the app gets it too: a setting made only in `main.ts` is
 * absent from every `Test.createTestingModule()` graph, and the test that
 * asserts it would be asserting against something production does differently.
 */
@Module({})
export class CacheControlModule implements NestModule, OnModuleInit {
  constructor(@Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost) {}

  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(noStore)
      // Every method and path, so a guard's 401 or an unknown route's 404 carries it too.
      .forRoutes({ path: '*splat', method: RequestMethod.ALL });
  }

  onModuleInit(): void {
    // Absent when a test compiles the module graph without an HTTP server;
    // there is no response to protect then.
    const instance: unknown = this.adapterHost.httpAdapter?.getInstance();
    if (isExpressApp(instance)) instance.set('etag', false);
  }
}

export function noStore(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store');
  // Express answers `If-None-Match: *` with a 304 even with its ETag turned
  // off, so the header is dropped as well: there is nothing a client may
  // revalidate against, because nothing should have been stored.
  // (`If-Modified-Since` needs no such step: no route sets `Last-Modified`,
  // and without one Express never answers it with a 304.)
  delete req.headers['if-none-match'];
  next();
}

function isExpressApp(value: unknown): value is { set(name: string, value: unknown): unknown } {
  return typeof value === 'function' && typeof (value as { set?: unknown }).set === 'function';
}
