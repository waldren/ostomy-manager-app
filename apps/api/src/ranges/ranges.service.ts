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

import { Inject, Injectable } from '@nestjs/common';
import { toLocalDate } from '@ostomy/core/units';

import { toWireSurgeryDate } from '../onboarding/surgery-date';
import { PrismaService } from '../prisma/prisma.service';

import {
  daysSinceSurgery,
  divergesFromPhysicianValue,
  isSuggestableRangeType,
  pickWindowForDay,
  resolveEffectiveRange,
  type RangeProvenanceName,
} from './range-selection';

/** One range type's answer for one patient: what is in force, and what we would suggest. */
export interface ResolvedRange {
  readonly rangeType: string;
  readonly unit: string;
  readonly lowValue: number | null;
  readonly highValue: number | null;
  /**
   * Where the value in force came from. `CLINICAL_DEFAULT` here means **no
   * patient row exists** — the default is being shown as a suggestion, and
   * AC 2 is why that distinction has to survive to the caller: an unconfirmed
   * suggestion is not an anomaly threshold.
   */
  readonly provenance: RangeProvenanceName;
  /**
   * Whether this range is usable as an anomaly threshold (AC 2).
   *
   * False for a clinical default nobody has confirmed. Computed here rather
   * than left to each caller to derive from `provenance`, because "which
   * provenance values count as confirmed" is exactly the kind of rule that
   * drifts when four call sites each answer it.
   */
  readonly isActiveThreshold: boolean;
  /** AC 4: a patient value exists alongside a physician-set one. Reported, never acted on. */
  readonly divergesFromPhysician: boolean;
  /** The post-operative window the suggestion came from, for the basis a surface states (AC 1). */
  readonly basis: RangeBasis | null;
}

/** What a surface needs to say "typical for an ileostomy about 3 months after surgery" in its own words. */
export interface RangeBasis {
  readonly ostomyType: string;
  readonly daysPostOp: number;
  readonly minDaysPostOp: number;
  readonly maxDaysPostOp: number | null;
}

/**
 * Which ranges are in force for a patient, and which clinical defaults would
 * seed a suggestion today (P4.S2 slice 2, SRS §3.9).
 *
 * ## Why the server resolves this rather than each client
 *
 * The precedence order is four values deep and the confirmation rule is
 * load-bearing — "no value becomes an active threshold without a human
 * confirming it". Two clients each implementing that is two chances to get AC 2
 * wrong, and the failure would be silent: a threshold that looks right and
 * flags nothing.
 *
 * Nothing consumes this yet. Anomaly highlighting is P5.S2, and the API surface
 * is slice 3 — so this slice's tests are what exercise it, deliberately: the
 * selection rules are the part worth getting right before anything is built on
 * them.
 */
@Injectable()
export class RangesService {
  // Explicit `@Inject()`, not implicit type-based injection — see `AuditService`'s
  // own constructor comment for why the latter resolves to `undefined` under this
  // workspace's Vitest (esbuild) transform.
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Every range type this patient has an answer for.
   *
   * Driven by the clinical defaults rather than by a hardcoded list of range
   * types, so the weight and heart-rate types arriving at P6/P7 need no change
   * here — they simply have no default rows yet and therefore produce nothing.
   */
  async resolveForPatient(oidcSubject: string, now: Date): Promise<readonly ResolvedRange[]> {
    const patient = await this.prisma.patient.findUnique({
      where: { oidcSubject },
      select: {
        id: true,
        profile: { select: { ostomyType: true, surgeryDate: true, deletedAt: true } },
      },
    });

    if (!patient?.profile || patient.profile.deletedAt !== null) return [];

    const { ostomyType, surgeryDate } = patient.profile;
    // UTC today, with the imprecision `daysSinceSurgery` documents.
    const daysPostOp = daysSinceSurgery(toWireSurgeryDate(surgeryDate), toLocalDate(now, 'UTC'));

    const [defaults, patientRanges] = await Promise.all([
      this.prisma.clinicalDefaultRange.findMany({
        where: { ostomyType, deletedAt: null },
        orderBy: { minDaysPostOp: 'asc' },
      }),
      this.prisma.effectiveRange.findMany({
        where: { patientId: patient.id, deletedAt: null },
      }),
    ]);

    const suggestable = defaults.filter((row) => isSuggestableRangeType(row.rangeType));
    const rangeTypes = [...new Set(suggestable.map((row) => row.rangeType))].sort();

    return rangeTypes.flatMap((rangeType) => {
      const resolved = this.resolveOne({
        rangeType,
        ostomyType,
        daysPostOp,
        windows: suggestable.filter((row) => row.rangeType === rangeType),
        candidates: patientRanges.filter((row) => row.rangeType === rangeType),
      });
      return resolved === undefined ? [] : [resolved];
    });
  }

  private resolveOne(input: {
    rangeType: string;
    ostomyType: string;
    daysPostOp: number;
    windows: readonly {
      minDaysPostOp: number | null;
      maxDaysPostOp: number | null;
      rangeType: string;
      unit: string;
      lowValue: unknown;
      highValue: unknown;
    }[];
    candidates: readonly {
      provenance: string;
      status: string;
      clientUpdatedAt: Date;
      unit: string;
      lowValue: unknown;
      highValue: unknown;
    }[];
  }): ResolvedRange | undefined {
    const typed = input.candidates.map((candidate) => ({
      ...candidate,
      provenance: candidate.provenance as RangeProvenanceName,
    }));
    const inForce = resolveEffectiveRange(typed);
    const window = pickWindowForDay(input.windows, input.daysPostOp);

    // A patient range in force wins outright; the default is what we would
    // suggest in its absence. No patient row and no window means no answer at
    // all, which the caller must render as "we have no suggestion" rather than
    // as a blank or a zero.
    const source = inForce ?? window;
    if (source === undefined) return undefined;

    const provenance: RangeProvenanceName =
      inForce === undefined ? 'CLINICAL_DEFAULT' : inForce.provenance;

    return {
      rangeType: input.rangeType,
      unit: source.unit,
      lowValue: toNumberOrNull(source.lowValue),
      highValue: toNumberOrNull(source.highValue),
      provenance,
      // AC 2: a clinical default nobody has confirmed is a suggestion, not a
      // threshold. Every other provenance reached ACTIVE through a human.
      isActiveThreshold: provenance !== 'CLINICAL_DEFAULT',
      divergesFromPhysician: divergesFromPhysicianValue(typed),
      basis:
        window === undefined
          ? null
          : {
              ostomyType: input.ostomyType,
              daysPostOp: input.daysPostOp,
              minDaysPostOp: window.minDaysPostOp ?? 0,
              maxDaysPostOp: window.maxDaysPostOp,
            },
    };
  }
}

/** Prisma `Decimal | null` to a plain number, without turning absent into zero. */
function toNumberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}
