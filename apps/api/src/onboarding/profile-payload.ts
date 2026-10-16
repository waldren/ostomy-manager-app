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

import {
  OSTOMY_TYPE,
  SYNC_FIELD_PATH,
  SYNC_REASON_CODE,
  toEntityId,
  type OstomyType as WireOstomyType,
  type ProfileSyncPayload,
} from '@ostomy/core/sync';
import type { MeasurementSystem as WireMeasurementSystem } from '@ostomy/core/units';
import { z } from 'zod';

import { MeasurementSystem, OstomyType, type Profile } from '../generated/prisma/client';
import { MEASUREMENT_SYSTEMS } from '../observations/observation-wire';
import {
  payloadMalformed,
  type ObservationRejectionDetail,
} from '../observations/observation-rejection';

import { surgeryDateViolation, toSurgeryDate, toWireSurgeryDate } from './surgery-date';

/**
 * The `Profile` sync payload (P4.S3, `docs/sync-contract.md` §7.5), and the one
 * place the wire spelling of a profile meets its stored spelling.
 *
 * Both write paths go through this module: `OnboardingService` (the REST
 * create) and `SyncPushService` (the update). That is deliberate. Two paths
 * writing one entity is the shape CLAUDE.md's "both write paths persist every
 * field" rule exists for, and the cheapest way to keep them agreeing is for
 * them to share the mapping rather than each restating it. The comparison test
 * in `onboarding.integration.spec.ts` asserts the outcome.
 */

/**
 * Strict on KEYS, lenient on values, exactly as `mealRequestParseSchema` is.
 *
 * An unrecognised key fails zod and becomes `PAYLOAD_FIELD_UNRECOGNIZED`
 * naming `payload` (§6.2). A recognised key with a wrong value passes here
 * and is refused by `interpretProfilePayload` with `PAYLOAD_FIELD_INVALID`
 * naming THAT field, which is the more useful answer and the one §6.2 asks
 * for. A strict value schema here would collapse the two.
 */
export const profileRequestParseSchema = z.strictObject({
  id: z.uuid(),
  ostomyType: z.unknown().optional(),
  surgeryDate: z.unknown().optional(),
  measurementSystem: z.unknown().optional(),
});
export type ProfileRequestParsed = z.infer<typeof profileRequestParseSchema>;

/** What a profile write stores, in the database's own spelling. */
export interface ProfileWriteInput {
  readonly ostomyType: OstomyType;
  readonly surgeryDate: Date;
  readonly measurementSystem: MeasurementSystem;
}

const OSTOMY_TYPE_BY_WIRE: Readonly<Record<WireOstomyType, OstomyType>> = {
  colostomy: OstomyType.COLOSTOMY,
  ileostomy: OstomyType.ILEOSTOMY,
};

const WIRE_BY_OSTOMY_TYPE: Readonly<Record<OstomyType, WireOstomyType>> = {
  [OstomyType.COLOSTOMY]: 'colostomy',
  [OstomyType.ILEOSTOMY]: 'ileostomy',
};

const MEASUREMENT_SYSTEM_BY_WIRE: Readonly<Record<WireMeasurementSystem, MeasurementSystem>> = {
  metric: MeasurementSystem.METRIC,
  imperial: MeasurementSystem.IMPERIAL,
};

const WIRE_BY_MEASUREMENT_SYSTEM: Readonly<Record<MeasurementSystem, WireMeasurementSystem>> = {
  [MeasurementSystem.METRIC]: 'metric',
  [MeasurementSystem.IMPERIAL]: 'imperial',
};

export function toStoredOstomyType(value: WireOstomyType): OstomyType {
  return OSTOMY_TYPE_BY_WIRE[value];
}

export function toStoredProfileMeasurementSystem(value: WireMeasurementSystem): MeasurementSystem {
  return MEASUREMENT_SYSTEM_BY_WIRE[value];
}

function invalid(field: ObservationRejectionDetail['field']): never {
  throw payloadMalformed({ field, reasonCode: SYNC_REASON_CODE.PAYLOAD_FIELD_INVALID });
}

const isoDate = z.iso.date();

/**
 * The three fields, each refused by name.
 *
 * The surgery date's bounds are onboarding's, from the same pure function
 * (`surgeryDateViolation`), so an edit cannot set a date provisioning would
 * have refused. Both bounds collapse to `PAYLOAD_FIELD_INVALID` here, where
 * onboarding answers `in_the_future` or `implausibly_old`: a sync rejection
 * carries a §6.2 reason code, and the device checked the same rules exactly
 * before queueing, so reaching this refusal means a client bug or a wrong
 * device clock, not something the patient typed.
 */
export function interpretProfilePayload(
  parsed: ProfileRequestParsed,
  now: Date,
): ProfileWriteInput {
  const ostomyType = parsed.ostomyType;
  if (typeof ostomyType !== 'string' || !(OSTOMY_TYPE as readonly string[]).includes(ostomyType)) {
    invalid(SYNC_FIELD_PATH.OSTOMY_TYPE);
  }

  const measurementSystem = parsed.measurementSystem;
  if (
    typeof measurementSystem !== 'string' ||
    !(MEASUREMENT_SYSTEMS as readonly string[]).includes(measurementSystem)
  ) {
    invalid(SYNC_FIELD_PATH.MEASUREMENT_SYSTEM);
  }

  const rawSurgeryDate = parsed.surgeryDate;
  if (typeof rawSurgeryDate !== 'string' || !isoDate.safeParse(rawSurgeryDate).success) {
    invalid(SYNC_FIELD_PATH.SURGERY_DATE);
  }
  const surgeryDate = toSurgeryDate(rawSurgeryDate);
  if (surgeryDateViolation(surgeryDate, now) !== null) {
    invalid(SYNC_FIELD_PATH.SURGERY_DATE);
  }

  return {
    ostomyType: toStoredOstomyType(ostomyType as WireOstomyType),
    surgeryDate,
    measurementSystem: toStoredProfileMeasurementSystem(measurementSystem as WireMeasurementSystem),
  };
}

type ProfileFields = Pick<Profile, 'ostomyType' | 'surgeryDate' | 'measurementSystem'>;

/** The three facts in their wire spelling — what `GET /api/v1/profile` answers with, minus the id. */
export function toProfileFields(row: ProfileFields): Omit<ProfileSyncPayload, 'id'> {
  return {
    ostomyType: WIRE_BY_OSTOMY_TYPE[row.ostomyType],
    // `@db.Date` comes back as a Date at UTC midnight; the wire carries the
    // calendar date it has always been, not an instant.
    surgeryDate: toWireSurgeryDate(row.surgeryDate),
    measurementSystem: WIRE_BY_MEASUREMENT_SYSTEM[row.measurementSystem],
  };
}

/** The delta payload (§7.5). Field by field, never a spread of the row (§6.3, `delta.ts`). */
export function toProfileResource(row: ProfileFields & Pick<Profile, 'id'>): ProfileSyncPayload {
  return { id: toEntityId(row.id), ...toProfileFields(row) };
}

/**
 * The audit snapshot both write paths record, so a profile's audit history
 * reads the same whichever endpoint wrote each version.
 */
export function toProfileAuditSnapshot(
  row: ProfileFields & Pick<Profile, 'id' | 'clientUpdatedAt'>,
): Record<string, unknown> {
  return {
    id: row.id,
    ...toProfileFields(row),
    clientUpdatedAt: row.clientUpdatedAt.toISOString(),
  };
}

/**
 * The INCOMING profile that lost a conflict (§4.1), as the client sent it.
 * Field by field rather than a spread of `operation.payload`, which is
 * client-supplied and unvalidated at this point.
 */
export function incomingProfileSnapshot(
  entityId: string,
  payload: Record<string, unknown> | undefined,
  clientTimestamp: Date,
): Record<string, unknown> {
  const fields = payload ?? {};
  return {
    id: entityId,
    ostomyType: fields.ostomyType ?? null,
    surgeryDate: fields.surgeryDate ?? null,
    measurementSystem: fields.measurementSystem ?? null,
    clientUpdatedAt: clientTimestamp.toISOString(),
  };
}

/**
 * What provisioning records as a profile's `clientUpdatedAt`: the epoch, so
 * that ANY edit wins against it.
 *
 * Provisioning asserts no client time, because it is the first version and
 * there is nothing to conflict with. It used to record the server's `now()`,
 * and that was a real loss path once edits arrived: a phone whose clock runs
 * two minutes slow onboards, changes its measurement system a minute later,
 * and the edit's `clientTimestamp` is EARLIER than the server-stamped
 * provisioning version. Last-write-wins then answers `superseded`, the edit is
 * moved to the audit log, and the patient's own phone silently reverts on its
 * next delta pull. The epoch says what is actually true: this version was not
 * written at any client time, so every client-timed edit is later than it.
 */
export const PROVISIONED_PROFILE_CLIENT_UPDATED_AT = new Date(0);
