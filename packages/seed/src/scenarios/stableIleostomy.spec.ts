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

import { ESTIMATION_METHOD_CODE } from '@ostomy/core/validation';
import type { VolumetricValidationThresholds } from '@ostomy/core/validation';
import { toLocalDate } from '@ostomy/core/units';
import { describe, expect, it } from 'vitest';

import { findTier1Problems, findTier2Warnings, generateScenario } from '../index.js';

const NOW = new Date('2026-09-17T12:00:00.000Z');
const OIDC_SUBJECT = 'gate-b-patient-1';

/**
 * The values the seeding migration establishes as defaults. Written out here
 * rather than imported, deliberately: this is what the SEEDER must be valid
 * against, and pinning it makes a change to either side visible as a failing
 * test rather than as a dev database that quietly warns on every row.
 */
const THRESHOLDS: VolumetricValidationThresholds = {
  softWarningMaxMl: 2000,
  maxClockSkewMs: 300_000,
};

const ESTIMATION_CODE = ESTIMATION_METHOD_CODE.resolved ? ESTIMATION_METHOD_CODE.code : null;

function generate(overrides: { seed?: number; now?: Date } = {}) {
  return generateScenario('stable-ileostomy', {
    oidcSubject: OIDC_SUBJECT,
    now: overrides.now ?? NOW,
    estimationMethodCode: ESTIMATION_CODE,
    ...(overrides.seed === undefined ? {} : { seed: overrides.seed }),
  });
}

describe('stable-ileostomy', () => {
  /**
   * The property the whole package exists for (ADR-0009): a bug found against
   * seeded data must reproduce by name and seed, because a database dump from
   * the shared dev host is the artifact that must never circulate.
   */
  describe('determinism', () => {
    it('produces byte-identical output for the same seed and the same "now"', () => {
      expect(JSON.stringify(generate())).toEqual(JSON.stringify(generate()));
    });

    it('produces the same entity ids, not merely the same values', () => {
      const first = generate();
      const second = generate();

      expect(first.patient.id).toBe(second.patient.id);
      expect(first.observations.map((o) => o.id)).toEqual(second.observations.map((o) => o.id));
    });

    it('produces a different dataset for a different seed', () => {
      expect(generate({ seed: 1 }).observations[0]?.id).not.toBe(
        generate({ seed: 2 }).observations[0]?.id,
      );
    });
  });

  /**
   * `docs/deployment-development.md`: timestamps are offsets from run time,
   * "so the dataset never ages into irrelevance and dashboards always have
   * recent data".
   */
  describe('relative to now', () => {
    it('places its most recent entry within the last day of the supplied "now"', () => {
      const dataset = generate();
      const latest = Math.max(...dataset.observations.map((o) => o.effectiveDatetime.getTime()));

      expect(NOW.getTime() - latest).toBeLessThan(48 * 60 * 60 * 1000);
    });

    it('moves the whole dataset when "now" moves', () => {
      const aYearOn = generate({ now: new Date('2027-09-17T12:00:00.000Z') });
      const latest = Math.max(...aYearOn.observations.map((o) => o.effectiveDatetime.getTime()));

      expect(new Date(latest).getUTCFullYear()).toBe(2027);
    });

    it('covers roughly 90 days of history', () => {
      const dataset = generate();
      const times = dataset.observations.map((o) => o.effectiveDatetime.getTime());
      const spanDays = (Math.max(...times) - Math.min(...times)) / (24 * 60 * 60 * 1000);

      expect(spanDays).toBeGreaterThan(85);
      expect(spanDays).toBeLessThan(95);
    });
  });

  /**
   * ADR-0009's central requirement. A Tier 1 failure here would mean the dev
   * database contains rows the application itself would reject — "and every
   * developer then debugs against data that could not exist".
   */
  describe('valid by construction', () => {
    it('generates no row the application would reject under Tier 1', () => {
      expect(findTier1Problems(generate(), THRESHOLDS, NOW)).toEqual([]);
    });

    it('stays valid across many seeds, not just the default one', () => {
      for (let seed = 1; seed <= 25; seed += 1) {
        expect(findTier1Problems(generate({ seed }), THRESHOLDS, NOW)).toEqual([]);
      }
    });

    it('never places an entry at or after "now"', () => {
      for (const observation of generate().observations) {
        expect(observation.effectiveDatetime.getTime()).toBeLessThan(NOW.getTime());
      }
    });

    it('never places an entry before the surgery date', () => {
      const dataset = generate();
      for (const observation of dataset.observations) {
        expect(observation.effectiveDatetime.getTime()).toBeGreaterThanOrEqual(
          dataset.profile.surgeryDate.getTime(),
        );
      }
    });

    /** DECIMAL(12,4): more fractional digits is VALUE_EXCEEDS_MAX_PRECISION. */
    it('generates volumes the canonical column can hold exactly', () => {
      for (const observation of generate().observations) {
        const fractional = observation.valueQuantityValue.split('.')[1]?.length ?? 0;
        expect(fractional).toBeLessThanOrEqual(4);
        expect(Number(observation.valueQuantityValue)).toBeGreaterThan(0);
      }
    });
  });

  /**
   * The baseline case must be unremarkable. A dataset that warns on ordinary
   * days would make Tier 2 unreadable in `validation-edge-cases` (P3.S5),
   * which is the scenario built to exercise warnings.
   */
  describe('the baseline is boring on purpose', () => {
    it('trips no Tier 2 soft warning at the configured threshold', () => {
      expect(findTier2Warnings(generate(), THRESHOLDS, NOW)).toEqual([]);
    });

    it('trips no Tier 2 warning across many seeds', () => {
      for (let seed = 1; seed <= 25; seed += 1) {
        expect(findTier2Warnings(generate({ seed }), THRESHOLDS, NOW)).toEqual([]);
      }
    });

    it('produces daily totals in a plausible well-controlled range', () => {
      const dataset = generate();
      const byDay = new Map<string, number>();
      for (const observation of dataset.observations) {
        byDay.set(
          observation.localDate,
          (byDay.get(observation.localDate) ?? 0) + Number(observation.valueQuantityValue),
        );
      }
      // Excludes the first and last local dates: a day's entries can straddle
      // the local-date boundary, so the extremes are partial by construction
      // rather than by any fault in the generator.
      const totals = [...byDay.values()].sort((a, b) => a - b).slice(1, -1);

      expect(Math.min(...totals)).toBeGreaterThan(300);
      expect(Math.max(...totals)).toBeLessThan(2000);
    });
  });

  /**
   * AC 2.2 AC2 requires history to distinguish Measured from Estimated.
   * `method` is the only stored representation of that choice (ADR-0018), so
   * a dataset that is all one or the other cannot demonstrate the badge.
   */
  describe('the Measured/Estimated mix', () => {
    it('includes both measured and estimated entries', () => {
      const dataset = generate();
      const measured = dataset.observations.filter((o) => o.method === null);
      const estimated = dataset.observations.filter((o) => o.method !== null);

      expect(measured.length).toBeGreaterThan(0);
      if (ESTIMATION_CODE === null) {
        // D4 unresolved: estimated entries are unrepresentable, and the
        // generator must produce none rather than writing `method: null`
        // and making them indistinguishable from measured ones.
        expect(estimated).toHaveLength(0);
      } else {
        expect(estimated.length).toBeGreaterThan(0);
      }
    });

    it('uses the resolved SNOMED code and never an invented one', () => {
      if (ESTIMATION_CODE === null) return;
      for (const observation of generate().observations) {
        if (observation.method !== null) {
          expect(observation.method).toBe(ESTIMATION_CODE);
        }
      }
    });
  });

  /**
   * ADR-0016: `localDate` is derived on the server and on the phone from one
   * shared helper. A seeder that computed it differently would put rows in the
   * dev database whose stored day disagrees with their own instant — the exact
   * silent failure that helper exists to prevent.
   */
  describe('the patient-local day', () => {
    it('derives localDate from the same shared helper the server uses', () => {
      for (const observation of generate().observations) {
        expect(observation.localDate).toBe(
          toLocalDate(observation.effectiveDatetime, observation.enteredTimezone),
        );
      }
    });

    it('records an IANA zone name, never a UTC offset', () => {
      for (const observation of generate().observations) {
        expect(observation.enteredTimezone).toMatch(/^[A-Za-z]+\/[A-Za-z_]+$/);
      }
    });
  });

  describe('the patient is reachable', () => {
    /**
     * The failure the Gate B rehearsal actually hit: a database with
     * observations but no patient row matching the token subject answers
     * every authenticated request with PATIENT_NOT_PROVISIONED.
     */
    it('binds the dataset to the supplied OIDC subject', () => {
      expect(generate().patient.oidcSubject).toBe(OIDC_SUBJECT);
    });

    it('attaches every observation to the seeded patient', () => {
      const dataset = generate();
      for (const observation of dataset.observations) {
        expect(observation.patientId).toBe(dataset.patient.id);
      }
    });
  });

  /**
   * ADR-0009's compliance review: no names, no dates of birth, nothing
   * resembling a real record. Asserted structurally rather than trusted,
   * because the cheapest way for PHI-shaped fields to appear is for someone
   * to add them to make a demo look better.
   */
  it('carries no name, date of birth or contact field anywhere in the dataset', () => {
    const serialized = JSON.stringify(generate()).toLowerCase();

    for (const forbidden of ['name', 'birth', 'dob', 'email', 'phone', 'address', 'mrn', 'ssn']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
