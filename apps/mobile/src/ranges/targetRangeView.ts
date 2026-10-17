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

import type {
  CachedPatientRange,
  CachedRange,
  CachedRangeBasis,
  OverlayRangeWrite,
  RangeWrite,
} from '../db/repositories/rangesRepository';

/** Where the value shown came from, in the four answers the screen gives. */
export type RangeSource = 'physician' | 'patient' | 'confirmed' | 'suggestion';

export interface RangeBounds {
  readonly lowValue: number | null;
  readonly highValue: number | null;
}

/** One range type as the target ranges screen shows it. */
export interface TargetRangeView {
  readonly rangeType: string;
  readonly unit: string;
  /** The value to show, or `null` when this phone cannot know it until it connects. */
  readonly shown: RangeBounds | null;
  readonly source: RangeSource;
  readonly basis: CachedRangeBasis | null;
  /** The suggestion, offerable even while another value is in force. */
  readonly suggestion: RangeBounds | null;
  /** The patient's own value, whether or not it is in force. */
  readonly patientRange: (CachedPatientRange & { readonly rangeType: string }) | null;
  readonly proposal: (CachedPatientRange & { readonly rangeType: string }) | null;
  /** AC 4: the patient holds a value of their own and a physician's outranks it. */
  readonly divergesFromPhysician: boolean;
  /**
   * Something the patient changed here is still waiting to be sent. Not true of
   * a change already sent and only waiting for the next refresh: telling the
   * patient that one "will be sent" would be false.
   */
  readonly waitingToSend: boolean;
  readonly limits: CachedRange['limits'];
}

/**
 * The cached server answer with this phone's own changes laid over it.
 *
 * ## Why the device does any of this
 *
 * §9.5: the local write is the confirmation. A patient who sets a value offline
 * must see it at once, not after the next sync, so the screen cannot simply
 * show the cache. What this does NOT do is re-implement §3.9's precedence: the
 * cache carries the server's answer for everything but the patient's own rows,
 * and the only rule applied here is the one fixed fact about those, that a
 * physician's value outranks a patient's (AC 4).
 *
 * ## The changes, in the order they were made
 *
 * - **active**: the patient's value from now on. The server supersedes whatever
 *   patient value was in force (§7.6), so this replaces it here too, and an
 *   accepted proposal leaves the proposal list.
 * - **superseded**: a withdrawal. It removes the patient's value only if it
 *   names that value, because a withdrawal affects only the row it names.
 * - **dismissed**: a proposal declined.
 *
 * Each change is one queued operation carrying its own status (local migration
 * 10), so a value set and then withdrawn reads as exactly that: the value,
 * then nothing. That is also what the server does with the two operations.
 */
export function buildTargetRangeViews(
  cached: readonly CachedRange[],
  writes: readonly OverlayRangeWrite[],
): TargetRangeView[] {
  return cached.map((range) => {
    const own = writes.filter((write) => write.rangeType === range.rangeType);

    let patientRange = withType(range.patientRange, range.rangeType);
    let proposal = withType(range.proposal, range.rangeType);

    for (const write of own) {
      const row = fromWrite(write);
      if (write.status === 'active') {
        patientRange = row;
        if (proposal?.id === write.id) proposal = null;
      } else if (write.status === 'superseded') {
        if (patientRange?.id === write.id) patientRange = null;
      } else if (proposal?.id === write.id) {
        proposal = null;
      }
    }

    const physician: RangeBounds | null =
      range.provenance === 'physician_set'
        ? { lowValue: range.lowValue, highValue: range.highValue }
        : null;
    const suggestion = suggestionOf(range);

    const [shown, source]: [RangeBounds | null, RangeSource] =
      physician !== null
        ? [physician, 'physician']
        : patientRange !== null
          ? [
              { lowValue: patientRange.lowValue, highValue: patientRange.highValue },
              patientRange.provenance === 'patient_set' ? 'patient' : 'confirmed',
            ]
          : [suggestion, 'suggestion'];

    return {
      rangeType: range.rangeType,
      unit: range.unit,
      shown,
      source,
      basis: range.basis,
      suggestion,
      patientRange,
      proposal,
      divergesFromPhysician: physician !== null && patientRange !== null,
      waitingToSend: own.some((write) => write.pending),
      limits: range.limits,
    };
  });
}

/**
 * The clinical default for this patient today: from the basis, which carries it
 * whatever is in force, or from the top level when the default IS what is in
 * force (a server that predates the basis bounds).
 */
function suggestionOf(range: CachedRange): RangeBounds | null {
  if (range.basis !== null && (range.basis.lowValue !== null || range.basis.highValue !== null)) {
    return { lowValue: range.basis.lowValue, highValue: range.basis.highValue };
  }
  if (range.provenance === 'clinical_default') {
    return { lowValue: range.lowValue, highValue: range.highValue };
  }
  return null;
}

function withType(
  row: CachedPatientRange | null,
  rangeType: string,
): (CachedPatientRange & { readonly rangeType: string }) | null {
  return row === null ? null : { ...row, rangeType };
}

function fromWrite(write: RangeWrite): CachedPatientRange & { readonly rangeType: string } {
  const asNumber = (value: string | null) => (value === null ? null : Number(value));
  return {
    id: write.id,
    rangeType: write.rangeType,
    lowValue: asNumber(write.lowValue),
    highValue: asNumber(write.highValue),
    targetValue: asNumber(write.targetValue),
    unit: write.unit,
    provenance: write.provenance,
  };
}
