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

import { describe, expect, it } from 'vitest';

import { en } from '../i18n/index.js';
import { TIER1_RULE_CODE, TIER2_RULE_CODE } from '../validation/index.js';

import { SYNC_FIELD_PATH, isSyncFieldPath } from './fieldPaths.js';
import { SYNC_ENTITY_TYPE, type SyncEntityType } from './payload.js';
import {
  SYNC_REASON_CODE,
  SYNC_SPECIFIC_REASON_CODE,
  hasPatientFacingCopy,
  isSyncReasonCode,
  type SyncReasonCode,
} from './reasonCodes.js';
import { SYNC_OPERATION_TYPE, SYNC_RESULT_STATUS } from './push.js';

describe('§6.2 — the rejection reason-code set', () => {
  it('contains every TIER1_RULE_CODE value verbatim, not remapped', () => {
    for (const code of Object.values(TIER1_RULE_CODE)) {
      expect(Object.values(SYNC_REASON_CODE)).toContain(code);
    }
  });

  it('reuses TIER1_RULE_CODE rather than restating it — the codes are identical objects value-for-value', () => {
    // The drift ADR-0006/ADR-0007 exist to prevent is a second copy that
    // differs by one character. If someone replaces the spread with a
    // hand-written list, this fails the moment the two lists disagree.
    for (const [key, value] of Object.entries(TIER1_RULE_CODE)) {
      expect(SYNC_REASON_CODE[key as keyof typeof SYNC_REASON_CODE]).toBe(value);
    }
  });

  it('contains the five sync-specific codes §6.2 names, and no others beyond Tier 1', () => {
    expect(Object.keys(SYNC_SPECIFIC_REASON_CODE).sort()).toEqual([
      'CLIENT_TIMESTAMP_OUT_OF_RANGE',
      'ENTITY_ID_CONFLICT',
      'ENTITY_NOT_FOUND',
      'PAYLOAD_FIELD_UNRECOGNIZED',
      'UNSUPPORTED_CODE',
    ]);

    expect(Object.keys(SYNC_REASON_CODE).sort()).toEqual(
      [...Object.keys(TIER1_RULE_CODE), ...Object.keys(SYNC_SPECIFIC_REASON_CODE)].sort(),
    );
  });

  it('contains no Tier 2 rule code — a soft warning is not a rejection and never becomes one', () => {
    for (const code of Object.values(TIER2_RULE_CODE)) {
      expect(Object.values(SYNC_REASON_CODE)).not.toContain(code);
    }
  });

  it('every code is its own key, so a code cannot be renamed on one side only', () => {
    for (const [key, value] of Object.entries(SYNC_REASON_CODE)) {
      expect(value).toBe(key);
    }
  });
});

describe('§8 — a client must tolerate an unrecognized reason code', () => {
  it('isSyncReasonCode accepts every known code', () => {
    for (const code of Object.values(SYNC_REASON_CODE)) {
      expect(isSyncReasonCode(code)).toBe(true);
    }
  });

  it.each([
    ['a code added by a later release', 'SOME_FUTURE_REASON_CODE'],
    ['a Tier 2 code, which never appears here', 'VALUE_ABOVE_TYPICAL_RANGE'],
    ['a non-string', null],
  ])('isSyncReasonCode rejects %s so the client falls back to the generic message', (_l, value) => {
    expect(isSyncReasonCode(value)).toBe(false);
  });
});

describe('§6.4 — which codes may be rendered to a patient', () => {
  it('every patient-facing code has an entry in the validationErrors catalog', () => {
    const renderable = Object.values(SYNC_REASON_CODE).filter((code) => hasPatientFacingCopy(code));

    expect(renderable.sort()).toEqual(Object.values(TIER1_RULE_CODE).sort());

    for (const code of renderable) {
      expect(en.validationErrors[code]).toBeTypeOf('string');
    }
  });

  it('the five sync-specific codes are NOT patient-facing and have no catalog entry', () => {
    for (const code of Object.values(SYNC_SPECIFIC_REASON_CODE)) {
      expect(hasPatientFacingCopy(code)).toBe(false);
      expect(Object.keys(en.validationErrors)).not.toContain(code);
    }
  });

  it('no reason code is itself prose — the server sends codes, the client renders copy', () => {
    for (const code of Object.values(SYNC_REASON_CODE)) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });
});

describe('§6.3 — the field path a rejection may name is a closed set', () => {
  it('every path is a wire field name from §3.1 or §7.2, with no interpolation possible', () => {
    for (const path of Object.values(SYNC_FIELD_PATH)) {
      expect(path).toMatch(/^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*)*$/);
    }
  });

  it('covers every field of the Observation payload §7.2 defines', () => {
    const paths: readonly string[] = Object.values(SYNC_FIELD_PATH);
    for (const field of [
      'resourceType',
      'id',
      'status',
      'code',
      'valueQuantity.value',
      'valueQuantity.unit',
      'effectiveDateTime',
      'method',
      'enteredMeasurementSystem',
    ]) {
      expect(paths).toContain(field);
    }
  });

  it('isSyncFieldPath rejects anything not in the set, including a path with a value spliced in', () => {
    expect(isSyncFieldPath('valueQuantity.value')).toBe(true);
    expect(isSyncFieldPath('valueQuantity.value (2500)')).toBe(false);
    expect(isSyncFieldPath('patientId')).toBe(false);
  });
});

describe('wire vocabularies', () => {
  it('§7.2 — the only entity type P2 exchanges is Observation, spelled as FHIR spells it', () => {
    const entityTypes: readonly SyncEntityType[] = Object.values(SYNC_ENTITY_TYPE);
    expect(entityTypes).toEqual(['Observation']);
  });

  it('§3.1 — operation types are create, update, delete', () => {
    expect(Object.values(SYNC_OPERATION_TYPE).sort()).toEqual(['create', 'delete', 'update']);
  });

  it('§3.5 — there are exactly three result statuses, including superseded', () => {
    expect(Object.values(SYNC_RESULT_STATUS).sort()).toEqual([
      'accepted',
      'rejected',
      'superseded',
    ]);
  });

  it('a SyncReasonCode value is assignable from the frozen object without a cast', () => {
    const code: SyncReasonCode = SYNC_REASON_CODE.ENTITY_NOT_FOUND;
    expect(code).toBe('ENTITY_NOT_FOUND');
  });
});
