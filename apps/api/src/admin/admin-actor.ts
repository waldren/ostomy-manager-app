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

import type { Request } from 'express';

/**
 * INTENTIONAL DUPLICATION of `../auth/patient-actor.ts`, same reasoning as
 * `AdminJwtAuthGuard` vs `JwtAuthGuard`: ADR-0008 keeps the admin/patient
 * boundary at the identity layer, so admin request-context plumbing shares
 * no code with the patient side. Do not merge these into one generic
 * `Actor<T>` accessor.
 */
export interface AdminActor {
  id: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    admin?: AdminActor;
  }
}

/**
 * The single place application code reads "which admin made this request".
 * Same fail-loudly reasoning as `getPatientActor` — an admin configuration
 * write with no actor is an audit-logging bug, not a value to paper over.
 */
export function getAdminActor(request: Request): AdminActor {
  if (!request.admin) {
    throw new Error(
      'getAdminActor() called on a request with no admin actor attached — ' +
        'this route is not behind AdminJwtAuthGuard, or getAdminActor() was called before the guard ran.',
    );
  }
  return request.admin;
}
