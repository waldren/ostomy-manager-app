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

import { en } from '@ostomy/core/i18n';
import { useEffect, useState } from 'react';

import { useDatabaseState } from '../db/DatabaseProvider';
import { readValueSet, type CachedValueSetMember } from '../db/repositories/valueSetsRepository';

/**
 * Reads one cached value set for a picker.
 *
 * ## Codes come from the database, labels come from the catalog
 *
 * The two halves are deliberately separate. Members are admin-managed and
 * **retired, never deleted** (CLAUDE.md), so the *set of options* has to be
 * read from the device cache rather than hardcoded — a retired member must
 * stop being offered while still resolving in stored history. The *label* for
 * a code is patient-facing copy and lives in the i18n catalog (ADR-0006), so
 * there is one localization pipeline rather than two.
 *
 * The consequence a screen has to handle: a member can exist with no label,
 * because an admin can add one after an app ships. That is a reachable state,
 * not a defensive one, and `entry.unknownOptionLabel` is what it renders as.
 * Showing the raw code at a patient would be worse than saying plainly that
 * it is new.
 *
 * ## An empty set is a real state, not a loading one
 *
 * The cache is unseeded on purpose (see the migration), so before the first
 * successful sync there is nothing to offer. `status` distinguishes that from
 * "still reading", because a screen must say so rather than render an empty
 * box a patient will tap at.
 */
export type ValueSetOptionsState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly members: readonly CachedValueSetMember[] }
  /** The device has never successfully fetched this set — no options exist to show. */
  | { readonly status: 'unavailable' };

export function useValueSetOptions(valueSetKey: string): ValueSetOptionsState {
  const database = useDatabaseState();
  const [state, setState] = useState<ValueSetOptionsState>({ status: 'loading' });

  useEffect(() => {
    if (database.status !== 'ready') return;
    let cancelled = false;

    readValueSet(database.executor, valueSetKey)
      .then((members) => {
        if (cancelled) return;
        setState(members.length === 0 ? { status: 'unavailable' } : { status: 'ready', members });
      })
      .catch(() => {
        // Leaves the picker unavailable rather than crashing the screen. An
        // entry without its optional categorisation is still a complete
        // entry — both pickers this hook serves are optional (AC 2.3 AC1,
        // AC 2.4 AC1) — so a failure here must never block a save.
        if (!cancelled) setState({ status: 'unavailable' });
      });

    return () => {
      cancelled = true;
    };
  }, [database, valueSetKey]);

  return state;
}

/**
 * The catalog key for a value-set member's label, or `undefined` when this
 * release has no copy for it.
 *
 * Checks the catalog itself rather than taking a list of known codes from the
 * caller: a screen should not have to carry a second copy of which members it
 * has words for, and a list passed in is one that drifts from the catalog
 * silently. `undefined` rather than a key that may not resolve is what keeps a
 * screen from rendering the literal string `undefined` or a raw code at a
 * patient — the same shape `rejectionCopy.ts` uses for a reason code with no
 * patient-facing copy.
 */
export function labelKeyFor(namespace: string, code: string): string | undefined {
  const key = `${namespace}.${code}`;
  return Object.prototype.hasOwnProperty.call(en.common, key) ? `common:${key}` : undefined;
}
