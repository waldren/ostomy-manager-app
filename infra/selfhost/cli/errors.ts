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
 * Exit status, matching scripts/admin-config.mjs and dev-stack-status.sh:
 *
 *   0  what was asked for happened
 *   1  refused: a gate said no, or the input was wrong
 *   2  something could not be reached (the host over SSH, Docker, git)
 *   3  this tool failed in a way it does not account for
 *
 * A refusal and a crash must never share a code. "The readiness checklist
 * is unsigned" and "a bug threw" both stopping an `init` would otherwise look
 * the same to anything branching on the result.
 */
export const EXIT = { ok: 0, refused: 1, unreachable: 2, unexpected: 3 } as const;

/** A gate refused, or the operator's input was wrong. Exit 1. */
export class Refusal extends Error {
  override readonly name = 'Refusal';
}

/** The host, Docker or git could not be reached or run. Exit 2. */
export class Unreachable extends Error {
  override readonly name = 'Unreachable';
}
