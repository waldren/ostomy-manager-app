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

import { SURGERY_DATE_RULE_CODE, type SurgeryDateRuleCode } from '@ostomy/core/validation';
import type { MeasurementSystem } from '@ostomy/core/units';

import type { OstomyType } from '../db/repositories/profileRepository';

/**
 * Rule codes and enum values to catalog keys, as exhaustive `Record`s.
 *
 * The exhaustiveness is the reason these are `Record`s and not lookups with a
 * fallback. Each one is keyed by a union that comes from the API — `OstomyType`
 * and the surgery-date rules are both derived from the server's own definitions —
 * so a value the server starts sending that this build has no copy for fails to
 * compile here rather than rendering as a raw key, or as "Another option", in
 * front of a patient.
 *
 * That is deliberately stricter than the value-set caches, where a member an admin
 * adds after a release ships legitimately has no copy and degrades to a generic
 * label (CLAUDE.md: "a reachable state, not a defensive one"). These three are not
 * admin-managed: changing them is a migration and a deploy, so there is no window
 * in which a fielded build can meet a value it was not built with.
 *
 * `ChoiceGroup` renders the choices from `Object.keys` of these records, so "which
 * options does the patient see" and "which options have copy" are the same fact.
 * An array of values alongside them would let the two drift silently.
 */

export const OSTOMY_TYPE_LABEL_KEYS: Readonly<Record<OstomyType, string>> = {
  colostomy: 'common:ostomyType.colostomy',
  ileostomy: 'common:ostomyType.ileostomy',
};

export const MEASUREMENT_SYSTEM_LABEL_KEYS: Readonly<Record<MeasurementSystem, string>> = {
  metric: 'common:measurementSystem.metric',
  imperial: 'common:measurementSystem.imperial',
};

/**
 * One message per rule, and each says what to change rather than what was wrong.
 *
 * `IMPLAUSIBLY_OLD` can only ever arrive from the server — the client does not know
 * the fifty-year bound — so its copy has to stand on its own, with no earlier
 * hint for the patient to connect it to.
 */
export const SURGERY_DATE_RULE_COPY_KEYS: Readonly<Record<SurgeryDateRuleCode, string>> = {
  [SURGERY_DATE_RULE_CODE.NOT_A_DATE]: 'common:onboarding.surgeryDateNotADate',
  [SURGERY_DATE_RULE_CODE.IN_THE_FUTURE]: 'common:onboarding.surgeryDateInTheFuture',
  [SURGERY_DATE_RULE_CODE.IMPLAUSIBLY_OLD]: 'common:onboarding.surgeryDateImplausiblyOld',
};

/** The options in the order the screen offers them, derived from the copy itself so the two cannot disagree. */
export const OSTOMY_TYPE_OPTIONS = Object.keys(OSTOMY_TYPE_LABEL_KEYS) as readonly OstomyType[];
export const MEASUREMENT_SYSTEM_OPTIONS = Object.keys(
  MEASUREMENT_SYSTEM_LABEL_KEYS,
) as readonly MeasurementSystem[];
