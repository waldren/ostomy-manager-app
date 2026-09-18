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
 * The Measured/Estimated toggle (AC 2.2, AC 2.5 AC 2), and the D4 gap, made
 * explicit and typed rather than left as a comment.
 *
 * **What D4 is.** SRS §4.4 and CLAUDE.md say the mandatory Measured vs.
 * Estimated selection is stored as FHIR `Observation.method`, populated with
 * the SNOMED CT "Estimation technique" code when the entry was estimated.
 * *That code has not been verified* — `design-specs/data-model/
 * fhir-rxnorm-integration.md` records it as open decision D4, and
 * `packages/core` models it as a discriminated union sitting in the
 * `{ resolved: false }` state so that no write path can typecheck against an
 * unresolved code by accident.
 *
 * **What that means for this endpoint today.** The toggle is fully enforced:
 * an entry with no selection at all is blocked by Tier 1 `METHOD_REQUIRED`,
 * and `method: null` (measured) is accepted and stored as NULL, which is the
 * FHIR-idiomatic representation of "obtained the ordinary way". What cannot
 * happen yet is an *estimated* entry: there is no code to write, so a
 * non-null `method` is refused with `PAYLOAD_FIELD_INVALID`
 * (`docs/sync-contract.md` §7.2, verbatim: "until it resolves the server
 * accepts `null` and rejects any non-null value").
 *
 * **What changes when D4 lands.** `ESTIMATION_METHOD_CODE` in
 * `packages/core/src/validation/estimationMethod.ts` becomes
 * `{ resolved: true, code: '<SNOMED code>' }`. This file needs **no edit** —
 * the `resolved` branch below starts accepting that exact code and the
 * `estimated` case starts being reachable, carrying the code straight into
 * `observations.method`. `estimation-method.spec.ts` has a test that fails
 * the moment the constant resolves, so the change is noticed and its
 * behaviour re-asserted rather than silently switching on. The only other
 * work is the clients' toggle sending the code instead of `null`, and (if
 * ever wanted) a migration to backfill nothing — no existing row can be
 * wrong, because none can have been written estimated.
 *
 * Note what is deliberately *not* here: any acceptance of an arbitrary
 * method string. The union below can only ever produce the one code
 * `packages/core` resolved, so "a `method` the server cannot recognize"
 * (§6.2) is unrepresentable rather than merely unlikely.
 */
import {
  ESTIMATION_METHOD_CODE,
  MEASURED_METHOD_CODE,
  type MeasuredOrEstimated,
} from '@ostomy/core/validation';

export type MethodWireInterpretation =
  /** `method: null` — the entry was measured. Stored as SQL NULL. */
  | { readonly kind: 'measured' }
  /**
   * `method: '<the resolved SNOMED code>'` — the entry was estimated.
   * Unreachable until D4 resolves; the code it carries can only ever be the
   * one `packages/core` published.
   */
  | { readonly kind: 'estimated'; readonly methodCode: string }
  /** The key was absent: no selection was made at all. Tier 1 blocks it. */
  | { readonly kind: 'not-selected' }
  /** A non-null `method` this release cannot accept. */
  | { readonly kind: 'unrecognized' };

export function interpretMethodWireValue(raw: unknown): MethodWireInterpretation {
  if (raw === undefined) {
    return { kind: 'not-selected' };
  }
  // `null` is still accepted and still means measured, and it must stay that
  // way for the life of v1. A client built before ADR-0018's amendment sends
  // it, and §8 requires the server to keep understanding an older client —
  // refusing `null` would reject a correct entry from an app the patient has
  // simply not updated, and §9 tells that client to re-push it forever.
  //
  // What changes is what gets STORED: `toStoredMethod` writes the explicit
  // code either way, so a row never records the ambiguity even when the wire
  // carried it.
  if (raw === null) {
    return { kind: 'measured' };
  }
  if (MEASURED_METHOD_CODE.resolved && raw === MEASURED_METHOD_CODE.code) {
    return { kind: 'measured' };
  }
  if (ESTIMATION_METHOD_CODE.resolved && raw === ESTIMATION_METHOD_CODE.code) {
    return { kind: 'estimated', methodCode: ESTIMATION_METHOD_CODE.code };
  }
  return { kind: 'unrecognized' };
}

/**
 * What `packages/core`'s Tier 1 rules need: the selection, or `null` when
 * none was made. `unrecognized` never reaches here — it is refused at the
 * payload layer before validation runs.
 */
export function toMeasuredOrEstimated(
  interpretation: MethodWireInterpretation,
): MeasuredOrEstimated | null {
  switch (interpretation.kind) {
    case 'measured':
      return 'measured';
    case 'estimated':
      return 'estimated';
    case 'not-selected':
    case 'unrecognized':
      return null;
  }
}

/**
 * What the `observations.method` column stores.
 *
 * An explicit SNOMED qualifier for both answers (ADR-0018, amended):
 * `258104002` |Measured| and `414135002` |Estimated|. NULL is reserved for
 * an observation the toggle does not apply to at all — weight, resting heart
 * rate — and is never written for a volumetric entry.
 *
 * Normalising here rather than at the wire boundary is what lets the server
 * keep accepting `null` from an older client (§8) without that ambiguity
 * reaching a stored row. The wire may be imprecise; the database is not.
 */
export function toStoredMethod(interpretation: MethodWireInterpretation): string | null {
  switch (interpretation.kind) {
    case 'estimated':
      return interpretation.methodCode;
    case 'measured':
      if (!MEASURED_METHOD_CODE.resolved) {
        // Unreachable while the constant is resolved, and a compile error to
        // read `.code` without this branch — the same guard the estimated
        // side has carried since D4.
        throw new Error(
          'Cannot store a Measured entry: MEASURED_METHOD_CODE is unresolved in @ostomy/core/validation.',
        );
      }
      return MEASURED_METHOD_CODE.code;
    case 'not-selected':
    case 'unrecognized':
      return null;
  }
}
