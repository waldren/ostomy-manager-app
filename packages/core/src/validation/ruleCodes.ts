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
 * Tier 1 (hard block) rule codes for a volumetric entry (SRS §3.8, AC 2.1
 * AC1, AC 2.2 AC1). A code, never the offending value, is what a
 * `ValidationError` ever carries (docs/security-hipaa.md).
 *
 * ## Why this is its own module
 *
 * It is a **leaf**: it imports nothing, so anything may import it. That is
 * the point. These codes used to live in `tier1.ts`, which composes
 * `entryTimestamp.ts` — and `entryTimestamp.ts` needs the codes, so the two
 * modules imported each other. Metro reported the cycle at runtime on a
 * device:
 *
 *     Require cycle: validation/tier1.js -> validation/entryTimestamp.js
 *                 -> validation/tier1.js
 *
 * A cycle is not merely untidy here. Whichever module the bundler evaluates
 * second sees the first only partly initialised, so `TIER1_RULE_CODE` can be
 * `undefined` at the moment a rule builds its error — and a Tier 1 rule that
 * yields `{ ruleCode: undefined }` is a hard block that silently stops
 * blocking. The whole point of Tier 1 is that structurally impossible input
 * cannot get through.
 *
 * So: keep this module importing nothing. Adding an import here re-creates
 * the cycle by a longer route.
 *
 * `tier1.ts` re-exports these, so `@ostomy/core/validation`'s public surface
 * is unchanged and no caller needs to know this module exists.
 */
export const TIER1_RULE_CODE = {
  VALUE_NOT_NUMERIC: 'VALUE_NOT_NUMERIC',
  VALUE_NOT_POSITIVE: 'VALUE_NOT_POSITIVE',
  VALUE_EXCEEDS_MAX_MAGNITUDE: 'VALUE_EXCEEDS_MAX_MAGNITUDE',
  VALUE_EXCEEDS_MAX_PRECISION: 'VALUE_EXCEEDS_MAX_PRECISION',
  METHOD_REQUIRED: 'METHOD_REQUIRED',
  /**
   * The mirror of `METHOD_REQUIRED`, for an observation with NO volume.
   *
   * Measured/Estimated describes how a number was arrived at, so on an
   * entry that records no number there is nothing for it to describe — a
   * colour-only voided-urine entry (SRS AC 12.1 AC2). Without this rule the
   * contradiction is caught only by the database CHECK, which surfaces as a
   * 500; `docs/sync-contract.md` §9 then tells a client to re-push a
   * payload that can never succeed, so the entry retries forever instead of
   * reaching the patient's correction inbox.
   */
  METHOD_NOT_APPLICABLE: 'METHOD_NOT_APPLICABLE',
  EFFECTIVE_DATE_TIME_IN_FUTURE: 'EFFECTIVE_DATE_TIME_IN_FUTURE',
  EFFECTIVE_DATE_TIME_BEFORE_SURGERY: 'EFFECTIVE_DATE_TIME_BEFORE_SURGERY',
} as const;
