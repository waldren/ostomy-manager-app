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

import type { EstimationMethodCode } from '../validation/index.js';

import type { ObservationMethodWireValue } from './payload.js';

/**
 * A tripwire on D4, not a proof of anything.
 *
 * `ObservationMethodWireValue` is written in terms of
 * `EstimationMethodCode` so the wire type and the terminology decision are
 * textually coupled. That coupling is currently vacuous:
 * `EstimationMethodCode`'s resolved arm carries `code: string`, so the
 * wire type collapses to exactly `string | null` and constrains nothing.
 *
 * This file asserts the collapse. When D4 resolves and the resolved arm
 * narrows to a literal SNOMED code, this assertion fails — which is the
 * point at which someone has to decide, deliberately, whether the wire
 * type narrows with it or stays open to receive and reject a wrong code
 * from an old client (§7.2 currently requires the latter).
 *
 * Failing here is the expected outcome of D4 landing. It is not a
 * regression; it is the question arriving on schedule.
 */

type Equals<TLeft, TRight> =
  (<TProbe>() => TProbe extends TLeft ? 1 : 2) extends <TProbe>() => TProbe extends TRight ? 1 : 2
    ? true
    : false;

type Expect<TAssertion extends true> = TAssertion;

type _MethodWireValueIsStillUnnarrowed = Expect<Equals<ObservationMethodWireValue, string | null>>;

/** The other half: D4 is genuinely still unresolved in the source of truth. */
type _EstimationCodeResolvedArmIsStillOpen = Expect<
  Equals<Extract<EstimationMethodCode, { resolved: true }>['code'], string>
>;

export type { _EstimationCodeResolvedArmIsStillOpen, _MethodWireValueIsStillUnnarrowed };
