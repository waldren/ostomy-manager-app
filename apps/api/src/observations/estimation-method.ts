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
  /** An explicit |Measured| qualifier, or an implicit `null` on an entry that HAS a volume. */
  | { readonly kind: 'measured' }
  /**
   * `method: null` on an entry with NO volume: there is nothing for
   * Measured/Estimated to describe, so no selection was made or implied.
   *
   * This arm exists because wire `null` is ambiguous and the volume is what
   * disambiguates it. §7.2 requires `method` to be present on every payload,
   * so a client recording a colour without an amount (AC 12.1 AC2) has no way
   * to say "not applicable" except by sending `null`. Collapsing that into
   * `measured` — which is correct for a volumetric entry, and what this
   * module did — made **every colour-only entry from the mobile app** fail
   * `METHOD_NOT_APPLICABLE`, in a correction inbox that shows no toggle for
   * the rule that rejected it. §9.2's retry-unchanged loop, forever.
   *
   * Only `interpretObservationPayload` can produce this arm, because only it
   * knows whether a volume was supplied. An EXPLICIT qualifier on a
   * volume-less entry is still `measured`/`estimated` and is still rejected —
   * that rule is about a client asserting something untrue, not about a
   * client with no way to stay silent.
   */
  | { readonly kind: 'no-toggle' }
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
  // `null` is still accepted and still means measured **on an entry that has a
  // volume**, and it must stay that way for the life of v1. A client built
  // before ADR-0018's amendment sends it, and §8 requires the server to keep
  // understanding an older client — refusing `null` would reject a correct
  // entry from an app the patient has simply not updated, and §9 tells that
  // client to re-push it forever.
  //
  // On an entry with NO volume it means the opposite: no toggle applies. This
  // function cannot tell the two apart, so it reports the provisional reading
  // and `resolveMethodForEntry` settles it once the volume is known. See the
  // `no-toggle` arm.
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
 * Settles wire `null` against the volume, which is the only thing that
 * disambiguates it.
 *
 * Called once, by `interpretObservationPayload`, immediately after
 * `hasVolume` is known — so every consumer downstream reads an
 * already-resolved interpretation and neither `toMeasuredOrEstimated` nor
 * `toStoredMethod` has to take a second argument it might be passed wrongly.
 *
 * Only the implicit `measured` reading moves. An explicit qualifier is left
 * exactly as sent, so `METHOD_NOT_APPLICABLE` still fires on a client that
 * asserts a measurement technique for a number it did not supply.
 */
export function resolveMethodForEntry(
  interpretation: MethodWireInterpretation,
  hasVolume: boolean,
  wireValueWasNull: boolean,
): MethodWireInterpretation {
  if (hasVolume) return interpretation;
  if (interpretation.kind === 'measured' && wireValueWasNull) {
    return { kind: 'no-toggle' };
  }
  return interpretation;
}

/**
 * What `packages/core`'s Tier 1 rules need: the selection, or `null` when
 * none was made or none applies. `unrecognized` never reaches here — it is
 * refused at the payload layer before validation runs.
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
    case 'no-toggle':
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
    // SQL NULL. For `no-toggle` that is exactly what ADR-0018 (amended)
    // reserves it for — "this observation has no toggle" — and a volume-less
    // urine entry joins weight and resting heart rate in that set, which the
    // `observations_method_needs_a_value` CHECK requires.
    case 'not-selected':
    case 'no-toggle':
    case 'unrecognized':
      return null;
  }
}
