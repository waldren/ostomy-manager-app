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

import { SetMetadata } from '@nestjs/common';

/**
 * Metadata key `AuditInterceptor` and `route-guard-coverage.spec.ts` both
 * read. A `Symbol`, matching this codebase's other metadata/DI-token
 * convention (`config.tokens.ts`, `patient-jwks-resolver.token.ts`), so it
 * cannot collide with a NestJS-internal or third-party metadata key by
 * coincidence.
 */
export const AUDITED_KEY = Symbol('AUDITED');

/**
 * Marks a route handler as a PHI mutation that `AuditInterceptor` (global,
 * `APP_INTERCEPTOR` — see that class's doc comment for why this is the one
 * enhancer in this app that is registered globally rather than
 * per-controller) must audit.
 *
 * This decorator alone does not write anything: the handler must also call
 * `stageAuditEntry()` (`audit-recorder.ts`) before returning. What this
 * decorator buys is the other half of that contract — `AuditInterceptor`
 * throws if a route it decorates completes having staged nothing, and
 * `route-guard-coverage.spec.ts` fails the build if a mutating
 * (POST/PUT/PATCH/DELETE) route carries no `@Audited()` at all. Together
 * those two checks are what makes "every PHI write is audited" a property
 * of the route table rather than something a handler author has to
 * remember unaided — see that spec file's own comment for the second half.
 */
export const Audited = (): MethodDecorator => SetMetadata(AUDITED_KEY, true);
