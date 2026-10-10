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

import { formatVolumeQuantity } from '@ostomy/core/i18n';
import {
  convertVolumeForDisplay,
  unitsForMeasurementSystem,
  type MeasurementSystemUnits,
} from '@ostomy/core/units';
import { useTranslation } from 'react-i18next';

import type { ResolvedRange } from '../ranges/useRanges.js';

export interface TargetRangesProps {
  readonly ranges: readonly ResolvedRange[];
  readonly targetSystem: MeasurementSystemUnits;
}

/**
 * Catalog keys for the range types this release names.
 *
 * Explicitly in the `common` namespace: web's `defaultNS` is `web`, which holds
 * shell copy only, and every string here has clinical meaning — a range type is
 * a clinical measure and a basis statement says what is typical for a group of
 * people. ADR-0006 keeps that in a shared namespace so one reviewer reads it
 * all together. Without the prefix these render as raw keys.
 */
const RANGE_TYPE_KEYS: Readonly<Record<string, string>> = {
  daily_output_ml: 'common:rangeType.daily_output_ml',
  urine_output_adequacy_ml: 'common:rangeType.urine_output_adequacy_ml',
  net_fluid_balance_ml: 'common:rangeType.net_fluid_balance_ml',
};

/** Roughly, for a basis sentence that says "about". A span of days does not deserve precision. */
/** Ranges are stored in canonical mL (ADR-0004); nothing about a default range is patient-asserted. */
const CANONICAL_UNITS = unitsForMeasurementSystem('metric');

const DAYS_PER_MONTH = 30;
const SETTLED_AFTER_MONTHS = 6;

/**
 * The patient's target ranges, with what each one is based on (P4.S2 slice 4,
 * SRS §3.9, AC 14.1 AC1 and AC4).
 *
 * ## Shown, not edited — and that is this sprint's shape rather than an omission
 *
 * AC 1 describes "a target-range field… pre-filled with the suggested value".
 * There is no field here because there is nothing to save to: `EffectiveRange`
 * is a synced entity and its writes queue through the sync path at P4.S3, which
 * is where §3.10's other preference edits live (#130). Building a REST write to
 * make this editable sooner would give one entity two write paths permanently.
 *
 * So what lands now is §3.10's review half — "current values, their source per
 * the Section 3.9 precedence order" — and the value and basis AC 1 asks to be
 * shown. The editing arrives with the write path.
 *
 * ## Why it says these are not in use
 *
 * Nothing compares an entry against these yet; anomaly highlighting is P5.S2.
 * A screen headed "your target ranges" implies otherwise unless it says so, and
 * the stronger reason is AC 2: a clinical default nobody confirmed is a
 * suggestion, and presenting it as a target is exactly what the confirmation
 * rule exists to prevent. `isActiveThreshold` carries that fact from the server
 * so this component does not re-derive it from provenance.
 *
 * ## Framing
 *
 * §3.9: the copy describes what is typical rather than prescribing, and must not
 * read as a treatment recommendation. The numbers behind it are implementer-
 * chosen and unratified by any clinician (#130), which makes that constraint
 * sharper rather than softer — every string here lives in the catalog where a
 * reviewer can read them together.
 */
export function TargetRanges({ ranges, targetSystem }: TargetRangesProps) {
  const { t } = useTranslation();

  return (
    <section aria-labelledby="target-ranges-heading">
      <h2 id="target-ranges-heading">{t('common:targetRanges.heading')}</h2>
      <p>{t('common:targetRanges.intro')}</p>

      {ranges.length === 0 ? (
        <p>{t('common:targetRanges.empty')}</p>
      ) : (
        <dl>
          {ranges.map((range) => (
            <div key={range.rangeType}>
              <dt>{t(RANGE_TYPE_KEYS[range.rangeType] ?? 'common:rangeType.unknownMeasure')}</dt>
              <dd>
                <p>{formatBand(range, targetSystem, t)}</p>
                <p>{sourceLabel(range, t)}</p>
                {range.basis === null ? null : <p>{basisSentence(range.basis, t)}</p>}
                {range.divergesFromPhysician ? (
                  <p>{t('common:targetRanges.divergesFromPhysician')}</p>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

type Translate = ReturnType<typeof useTranslation>['t'];

/**
 * Both bounds, one, or neither.
 *
 * A floor with no ceiling is the ordinary case for urine adequacy and net
 * balance — passing too little is the concern, not too much — so "at least X"
 * has to be a first-class rendering rather than a band with a blank half. The
 * values are converted and formatted through `@ostomy/core/units`, so the
 * patient's measurement system governs them (ADR-0004) and this never spells a
 * unit itself.
 */
function formatBand(range: ResolvedRange, units: MeasurementSystemUnits, t: Translate): string {
  // A range is authored in canonical mL, so the "entry system" is metric by
  // construction — there is no patient assertion here to preserve, unlike an
  // observation (ADR-0012). For an imperial reader that makes this a
  // cross-system conversion, which ADR-0005 rounds to a whole unit for display.
  const asText = (canonicalMl: number) =>
    formatVolumeQuantity(convertVolumeForDisplay(canonicalMl, CANONICAL_UNITS, units));

  const low = range.lowValue === null ? null : asText(range.lowValue);
  const high = range.highValue === null ? null : asText(range.highValue);

  if (low !== null && high !== null) return t('common:targetRanges.band', { low, high });
  if (low !== null) return t('common:targetRanges.atLeast', { low });
  if (high !== null) return t('common:targetRanges.atMost', { high });
  // #97's CHECK refuses a row with neither bound, so this is unreachable
  // through the database — kept because rendering an empty line would be worse
  // than naming the state.
  return t('common:targetRanges.empty');
}

/**
 * Where the value came from, in the patient's words.
 *
 * `isActiveThreshold` rather than a provenance comparison: the server decides
 * which provenance values count as confirmed, and a second answer here is how
 * the two come to disagree about whether something is a threshold.
 */
function sourceLabel(range: ResolvedRange, t: Translate): string {
  if (!range.isActiveThreshold) return t('common:targetRanges.notConfirmed');
  if (range.provenance === 'PHYSICIAN_SET') return t('common:targetRanges.sourcePhysician');
  if (range.provenance === 'PATIENT_SET') return t('common:targetRanges.sourcePatient');
  return t('common:targetRanges.sourceConfirmed');
}

/**
 * AC 1's basis, assembled from the window the server reported.
 *
 * From FIELDS rather than a sentence the API sends, which is why the API sends
 * fields: an English string built server-side would be untranslatable and
 * invisible to the review §3.9's framing constraint exists for.
 */
function basisSentence(basis: NonNullable<ResolvedRange['basis']>, t: Translate): string {
  // The value carries its own article ("an ileostomy"), because "a
  // {{ostomyType}}" produced "a ileostomy" — and because which article a noun
  // takes is a property of the noun in most languages, so a sentence that
  // assumes one can only ever be English.
  const ostomyType = t(
    basis.ostomyType === 'colostomy'
      ? 'common:ostomyType.colostomyLower'
      : 'common:ostomyType.ileostomyLower',
  );
  const months = Math.round(basis.daysPostOp / DAYS_PER_MONTH);

  if (months < 1) return t('common:targetRanges.basisEarly', { ostomyType });
  if (months >= SETTLED_AFTER_MONTHS) return t('common:targetRanges.basisSettled', { ostomyType });
  return t('common:targetRanges.basisMonths', { ostomyType, months });
}
