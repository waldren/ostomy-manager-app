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
 * DI token for the admin guard's JWKS key resolver. Deliberately a separate
 * token from `PATIENT_JWKS_RESOLVER` (../auth/patient-jwks-resolver.token.ts)
 * — see the "INTENTIONAL DUPLICATION" note on `AdminJwtAuthGuard`.
 */
export const ADMIN_JWKS_RESOLVER = Symbol('ADMIN_JWKS_RESOLVER');
