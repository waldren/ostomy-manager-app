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
 * The deterministic random source every scenario draws from.
 *
 * `docs/deployment-development.md` requires a **fixed RNG seed**, "so a bug
 * found against seeded data reproduces exactly". ADR-0009 gives the reason
 * that matters here: a database dump from the shared dev host is precisely
 * the artifact that must never circulate, so "reproducible by name and seed"
 * is the only sanctioned way to hand someone the dataset a bug was found in.
 *
 * `Math.random()` is therefore unusable, and not merely discouraged — it
 * would make every generated dataset unreproducible with nothing in the
 * output indicating that.
 *
 * ## Why a hand-written PRNG rather than a dependency
 *
 * This needs to be *stable across versions*, which is a stronger requirement
 * than "random enough". A seeded PRNG from a library can change its
 * algorithm in a minor release — the output is not usually part of a
 * package's public contract — and the same seed then produces a different
 * dataset, silently, breaking the one property this module exists for.
 * mulberry32 is nine lines and pinned by being written down.
 *
 * It is emphatically **not** cryptographic, and nothing here should ever be
 * used for a key, a token, a UUID that must be unguessable, or anything
 * else where predictability is a weakness. Predictability is the entire
 * point of this file.
 */

/** A seeded pseudo-random source. Every draw advances the stream. */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max], inclusive at both ends. */
  intBetween(min: number, max: number): number;
  /** Uniform in [min, max), rounded to `decimals` places. */
  floatBetween(min: number, max: number, decimals: number): number;
  /** Picks one member of a non-empty list. */
  pick<T>(items: readonly T[]): T;
}

/**
 * mulberry32 — a 32-bit state PRNG. Chosen for being short enough to audit
 * at a glance and having no dependency that could change under it.
 */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;

  function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  return {
    next,
    intBetween(min, max) {
      if (max < min) {
        throw new RangeError(
          `intBetween requires max >= min; received min=${String(min)}, max=${String(max)}.`,
        );
      }
      return min + Math.floor(next() * (max - min + 1));
    },
    floatBetween(min, max, decimals) {
      if (max < min) {
        throw new RangeError(
          `floatBetween requires max >= min; received min=${String(min)}, max=${String(max)}.`,
        );
      }
      const factor = 10 ** decimals;
      // Rounded here rather than at the point of storage, deliberately:
      // `observations.value_quantity_value` is DECIMAL(12,4), and a value
      // with more fractional digits than that is a Tier 1 rejection
      // (VALUE_EXCEEDS_MAX_PRECISION). Generated data must be valid by
      // construction, so the rounding belongs where the number is made.
      return Math.round((min + next() * (max - min)) * factor) / factor;
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) {
        throw new RangeError('pick requires a non-empty list.');
      }
      return items[Math.floor(next() * items.length)] as T;
    },
  };
}

/**
 * A deterministic UUID built from the RNG stream.
 *
 * **Not `crypto.randomUUID()`**, and that is the point: entity ids have to be
 * part of the reproducible dataset. Two runs at the same seed must produce
 * the same observation ids, or "reproducible by name and seed" is false for
 * every id-addressed thing — which includes the sync queue, the correction
 * inbox and any bug report that names a row.
 *
 * Formatted as a RFC 4122 version-4 UUID (version and variant nibbles set)
 * because the schema column is `@db.Uuid` and the sync contract requires
 * payload ids to be UUIDs — it must *parse* as one. It is not random, and
 * nothing may treat a seeded id as unguessable.
 */
export function deterministicUuid(rng: Rng): string {
  const hex = '0123456789abcdef';
  let out = '';
  for (let index = 0; index < 32; index += 1) {
    if (index === 12) {
      out += '4';
      continue;
    }
    if (index === 16) {
      // Variant bits: one of 8, 9, a, b.
      out += hex[8 + rng.intBetween(0, 3)];
      continue;
    }
    out += hex[rng.intBetween(0, 15)];
  }
  return [
    out.slice(0, 8),
    out.slice(8, 12),
    out.slice(12, 16),
    out.slice(16, 20),
    out.slice(20, 32),
  ].join('-');
}
