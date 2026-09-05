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
 * The authenticated patient identity `JwtAuthGuard` attaches to the request.
 * Deliberately just `{ id }` — see the guard's own file comment for why the
 * rest of the verified JWT claims (email, phone_number, birthdate, name —
 * four of the eighteen HIPAA identifiers on a typical Cognito token) never
 * make it onto the request object at all.
 */
export interface PatientActor {
  id: string;
}

/**
 * Single point of module augmentation for the patient actor. Before this
 * file existed, `JwtAuthGuard` and `PatientStubController` each declared
 * their own inline `Request & { patient?: ... }` shape — harmless while both
 * were four lines long, but exactly the kind of duplication that lets one
 * copy drift (e.g. re-adding `claims`) while the other doesn't. Every file
 * that reads or writes `request.patient` should import this module (or
 * `getPatientActor` below) rather than re-declaring the shape.
 */
declare module 'express-serve-static-core' {
  interface Request {
    patient?: PatientActor;
  }
}

/**
 * The single place application code — controllers, and the P1.S5 audit
 * interceptor once it lands — reads "which patient made this request".
 *
 * Throws rather than returning `undefined`, on purpose: a caller reaching
 * this with no actor attached means the route isn't behind `JwtAuthGuard`,
 * which for a PHI-touching route is a bug to fail loudly on, not a value to
 * silently thread through as a null actor into an audit row.
 */
export function getPatientActor(request: Request): PatientActor {
  if (!request.patient) {
    throw new Error(
      'getPatientActor() called on a request with no patient actor attached — ' +
        'this route is not behind JwtAuthGuard, or getPatientActor() was called before the guard ran.',
    );
  }
  return request.patient;
}
