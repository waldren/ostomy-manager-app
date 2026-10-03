//
// Unit tests for the pure parts of `admin-config.mjs`.
//
// `node:test` rather than vitest, and that is not a style choice. `scripts/` is
// not a pnpm workspace, so the root `pnpm test` — `pnpm -r --if-present run
// test` — walks right past it. A `.spec.ts` here would have looked like
// coverage and run in neither CI nor `pnpm verify`, which is worse than no test
// at all: this repo has already shipped a self-skipping integration suite, a
// stale tsbuildinfo, and a spec file that did not parse while the runner
// reported 339 passing. So this uses Node's built-in runner and the root
// `test` script invokes it by name.
//
//   pnpm test:scripts
//
// Scope is the pure functions where a wrong answer is silent. Everything else
// in that script is I/O against a live stack, verified by running it rather
// than by mocking `fetch` — a mock of these surfaces would assert that the
// script agrees with my model of the API, which is exactly what was wrong twice
// while writing it (`valueSetKey` for `key`, and one envelope shape for two).
//
// `resolveDescription` and `tierWarnings` were extracted out of `setThreshold`
// specifically because review found a bug in each while they were trapped
// inside an I/O function and therefore untestable: `--label ''` persisted an
// empty description, and the OPERATIONAL warning told the reader to consult a
// label the script did not print.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  describeBounds,
  describeRange,
  describeFailure,
  describeSettableRange,
  readClaims,
  resolveDescription,
  tierWarnings,
} from './admin-config.mjs';

describe('describeFailure', () => {
  it('reads the config routes’ nested envelope', () => {
    assert.equal(
      describeFailure(404, { error: { code: 'THRESHOLD_NOT_FOUND' } }),
      'HTTP 404 THRESHOLD_NOT_FOUND',
    );
  });

  it('reads the admin guard’s flat envelope', () => {
    // The bug this test exists for. `AdminJwtAuthGuard` answers `{ code }` with
    // no `error` wrapper, and reading only the nested shape reported "no
    // recognised error body" for a 401 that had said exactly what was wrong.
    assert.equal(
      describeFailure(401, { code: 'ADMIN_AUTH_MISSING_SUBJECT_CLAIM' }),
      'HTTP 401 ADMIN_AUTH_MISSING_SUBJECT_CLAIM',
    );
  });

  it('names the fields and rules of a 400, and nothing else', () => {
    const rendered = describeFailure(400, {
      error: {
        code: 'INVALID_THRESHOLD_UPDATE',
        fields: [
          { field: 'value', rule: 'too_small' },
          { field: 'description', rule: 'too_big' },
        ],
      },
    });
    assert.equal(
      rendered,
      'HTTP 400 INVALID_THRESHOLD_UPDATE — value: too_small, description: too_big',
    );
  });

  it('renders a root-level issue as (body) rather than as an empty name', () => {
    assert.match(
      describeFailure(400, { error: { code: 'X', fields: [{ field: '', rule: 'invalid_type' }] } }),
      /\(body\): invalid_type/,
    );
  });

  it('says a 404 with no envelope probably means a stale stack', () => {
    // The commonest real cause, and one a reader will not guess: the deploy
    // never ran, so the route this script calls does not exist yet (#76).
    assert.match(describeFailure(404, undefined), /older than this script/);
  });

  /**
   * Reachable for real, and nothing pinned it: `admin-thresholds.controller.ts`
   * filters `unrecognized_keys` down to `IMMUTABLE_FIELDS`, so a body carrying
   * an unknown key that is not an immutable field — `{value, description,
   * bogus}` — yields `fields: []` and a 400 naming nothing. (That filter is an
   * API defect of its own, filed separately; this asserts the script renders
   * the result sanely rather than crashing or printing an empty dash list.)
   */
  it('renders a 400 whose field list came back empty', () => {
    assert.equal(
      describeFailure(400, { error: { code: 'INVALID_THRESHOLD_UPDATE', fields: [] } }),
      'HTTP 400 INVALID_THRESHOLD_UPDATE',
    );
  });

  describe('the issuer diagnostic', () => {
    it('explains an invalid-issuer 401 and names the iss the token carried', () => {
      const rendered = describeFailure(
        401,
        { code: 'ADMIN_AUTH_INVALID_ISSUER' },
        { tokenIssuer: 'http://localhost:8090/admin-issuer' },
      );
      assert.match(rendered, /ADMIN_AUTH_INVALID_ISSUER/);
      assert.match(rendered, /iss=http:\/\/localhost:8090\/admin-issuer/);
      assert.match(rendered, /DEV_HOST_ADDRESS/);
    });

    it('still explains it when no token issuer is known', () => {
      const rendered = describeFailure(401, { code: 'ADMIN_AUTH_INVALID_ISSUER' });
      assert.match(rendered, /exact string equality/);
      assert.doesNotMatch(rendered, /undefined/);
    });

    it('does not attach the issuer explanation to an unrelated code', () => {
      const rendered = describeFailure(401, { code: 'ADMIN_AUTH_MALFORMED_TOKEN' });
      assert.equal(rendered, 'HTTP 401 ADMIN_AUTH_MALFORMED_TOKEN');
    });
  });

  it('does not claim a non-404 came from somewhere it cannot know about', () => {
    const rendered = describeFailure(502, undefined);
    assert.match(rendered, /HTTP 502/);
    assert.doesNotMatch(rendered, /older than this script/);
  });
});

describe('describeSettableRange', () => {
  it('renders a decided range', () => {
    assert.equal(
      describeSettableRange({ minSettableValue: 60, maxSettableValue: 3600 }),
      'settable 60 to 3600',
    );
  });

  /**
   * The distinction worth keeping. `validation_thresholds` encodes "no clinical
   * bound decided for this key" as a range spanning the whole `DECIMAL(12,4)`
   * column (#93), which constrains nothing — so rendering it as
   * "settable 0.0001 to 99999999.9999" would present the absence of a decision
   * as a decision, to the one reader in a position to notice.
   */
  it('says plainly when no bound has been decided', () => {
    const rendered = describeSettableRange({
      minSettableValue: 0.0001,
      maxSettableValue: 99999999.9999,
    });
    assert.match(rendered, /no settable bound decided/);
    assert.doesNotMatch(rendered, /0\.0001/);
  });

  it('treats a range open at only one end as decided', () => {
    // Half-open is still a real constraint and must not read as undecided.
    assert.match(
      describeSettableRange({ minSettableValue: 60, maxSettableValue: 99999999.9999 }),
      /settable 60/,
    );
    assert.match(
      describeSettableRange({ minSettableValue: 0.0001, maxSettableValue: 3600 }),
      /to 3600/,
    );
  });
});

describe('describeRange', () => {
  const RANGE = {
    ostomyType: 'ILEOSTOMY',
    rangeType: 'daily_output_ml',
    minDaysPostOp: 0,
    maxDaysPostOp: 30,
    lowValue: 500,
    highValue: 1200,
    unit: 'mL',
    windowDays: null,
  };

  it('reads as a window and its bounds', () => {
    assert.deepEqual(describeRange(RANGE), [
      '  ILEOSTOMY daily_output_ml  (day 0 to day 30)',
      '      500 to 1200 mL',
    ]);
  });

  /**
   * A null `minDaysPostOp` means "from surgery" — day 0 — and a null
   * `maxDaysPostOp` means unbounded. Printing either as `null` would read as
   * corrupt data to the one reader who could act on it, and printing "day null"
   * for the lower end would hide that the row starts at surgery.
   */
  it('prints neither end as null', () => {
    const rendered = describeRange({
      ...RANGE,
      minDaysPostOp: null,
      maxDaysPostOp: null,
    }).join('\n');

    assert.match(rendered, /day 0 to onward/);
    assert.doesNotMatch(rendered, /null/);
  });

  it('names the rolling window, which is part of the row identity', () => {
    // Two rules for one range type are told apart by `windowDays` (#97's
    // exclusion constraint coalesces it), so a listing that omitted it would
    // show what looks like a duplicated row.
    assert.match(describeRange({ ...RANGE, windowDays: 7 }).join('\n'), /7-day window/);
  });
});

describe('describeBounds', () => {
  it('renders a two-sided range', () => {
    assert.equal(describeBounds({ lowValue: 500, highValue: 1200, unit: 'mL' }), '500 to 1200 mL');
  });

  /**
   * The two cases that matter, because the create refuses only the row where
   * BOTH bounds are null — so a one-sided range is legitimate data, and
   * `urine_output_ml` has no clinically meaningful ceiling. Rendering
   * "null to 1200 mL" would read as corrupt data rather than as a floor.
   */
  it('renders a floor-only range without printing null', () => {
    const rendered = describeBounds({ lowValue: 1200, highValue: null, unit: 'mL' });
    assert.equal(rendered, '1200 mL and above');
    assert.doesNotMatch(rendered, /null/);
  });

  it('renders a ceiling-only range without printing null', () => {
    const rendered = describeBounds({ lowValue: null, highValue: 1200, unit: 'mL' });
    assert.equal(rendered, 'up to 1200 mL');
    assert.doesNotMatch(rendered, /null/);
  });

  /**
   * Both ends, because only the floor was covered and a mutation sweep found
   * that: changing the ceiling's `=== null` to a falsy check left the suite
   * green while a ceiling of `0` silently became "and above" — a range reported
   * as open at the top when it is closed at zero.
   *
   * `net_fluid_balance_ml` is where both are reachable: `-800 to 0` is an
   * ordinary deficit range, and it has a zero at one end either way round.
   */
  it('keeps a zero floor, which is a bound and not an absent one', () => {
    assert.equal(describeBounds({ lowValue: 0, highValue: 500, unit: 'mL' }), '0 to 500 mL');
  });

  it('keeps a zero ceiling', () => {
    assert.equal(describeBounds({ lowValue: -800, highValue: 0, unit: 'mL' }), '-800 to 0 mL');
  });

  /**
   * The create refuses a row with neither bound, and this still has to render
   * one: `admin-default-range-wire.ts` is explicit that the table has no unique
   * and no CHECK constraints, so a migration, a seeder or a psql session can
   * produce a state the API refuses — and this listing is the tool you would
   * use to find it. It printed `up to null mL`, which is the defect this
   * function exists to prevent, applied to the one row where it matters most.
   */
  it('names a row with no bounds instead of printing null', () => {
    const rendered = describeBounds({ lowValue: null, highValue: null, unit: 'mL' });
    assert.doesNotMatch(rendered, /null/);
    assert.match(rendered, /no bounds/);
    assert.match(rendered, /invalid/);
  });

  it('keeps a negative bound, unlike an entered volume', () => {
    // Tier 1's positive-value rule is about entered volumes. A default RANGE
    // legitimately has a negative floor.
    assert.equal(
      describeBounds({ lowValue: -800, highValue: -100, unit: 'mL' }),
      '-800 to -100 mL',
    );
  });
});

describe('resolveDescription', () => {
  const current = { description: 'the existing label' };

  it('carries the existing label forward when none is given', () => {
    // The reason the write path reads before writing at all: the PUT body is
    // `.strict()` with `description` required, so "unchanged" has to be sent.
    assert.equal(resolveDescription({}, current), 'the existing label');
  });

  it('replaces the label when one is given', () => {
    assert.equal(resolveDescription({ label: 'a new label' }, current), 'a new label');
  });

  it('clears the label to null on --clear-label', () => {
    assert.equal(resolveDescription({ 'clear-label': true }, current), null);
  });

  /**
   * The blocking bug review found. `options.label ?? current.description` let
   * `--label ''` through, and the wire schema has no `.min(1)`, so an empty
   * string persisted — re-opening the second "no label" state
   * `admin-threshold-wire.ts` says was deliberately withdrawn, where `''` and
   * `null` render identically while their audit snapshots differ.
   */
  it('refuses an empty label rather than persisting one', () => {
    assert.throws(() => resolveDescription({ label: '' }, current), /--clear-label/);
  });

  it('carries forward a label that is already null', () => {
    assert.equal(resolveDescription({}, { description: null }), null);
  });
});

describe('tierWarnings', () => {
  const row = (over) => ({
    thresholdKey: 'k',
    tier: 'TIER_2_SOFT_WARNING',
    patientAdjustable: true,
    ...over,
  });

  it('says nothing for an ordinary patient-adjustable soft warning', () => {
    assert.deepEqual(tierWarnings(row()), []);
  });

  it('warns that a Tier 1 bound blocks outright', () => {
    assert.match(tierWarnings(row({ tier: 'TIER_1_HARD_BLOCK' }))[0], /no override/);
  });

  it('warns that a safety threshold is not a data-quality warning', () => {
    assert.match(tierWarnings(row({ tier: 'SAFETY_THRESHOLD' }))[0], /safety response/);
  });

  it('warns that a non-adjustable bound governs every patient', () => {
    assert.match(tierWarnings(row({ patientAdjustable: false }))[0], /every patient/);
  });

  /**
   * The clock-skew row gets its own sentence rather than the generic
   * OPERATIONAL one, because the expensive direction is counter-intuitive and
   * named in ADR-0019: "allowance" reads as slack to tighten, and tightening it
   * Tier-1 blocks every queued entry from every patient whose device clock runs
   * fast. It is also the only OPERATIONAL row seeded, so the generic warning
   * would be the only thing an operator ever saw here.
   */
  it('names the expensive direction for the clock-skew allowance', () => {
    const messages = tierWarnings(
      row({
        thresholdKey: 'sync_clock_skew_allowance_seconds',
        tier: 'OPERATIONAL',
        patientAdjustable: false,
      }),
    );
    assert.ok(
      messages.some((message) => /LOWERING/.test(message) && /ADR-0019/.test(message)),
      `expected the ADR-0019 warning, got ${JSON.stringify(messages)}`,
    );
    // And the two generic ones still apply, so the specific sentence adds to
    // the warnings rather than replacing them.
    assert.equal(messages.length, 3);
  });
});

describe('readClaims', () => {
  const encode = (claims) => Buffer.from(JSON.stringify(claims)).toString('base64url');

  it('reads the payload of a three-segment token', () => {
    const token = `header.${encode({ sub: 'maintenance-admin', iss: 'http://x/i' })}.signature`;
    assert.deepEqual(readClaims(token), { sub: 'maintenance-admin', iss: 'http://x/i' });
  });

  it('refuses something that is not a JWT', () => {
    assert.throws(() => readClaims('not-a-jwt'), /not a JWT/);
  });

  it('refuses a payload that is not JSON', () => {
    assert.throws(() => readClaims('header.bm90LWpzb24.signature'), /not JSON/);
  });

  /**
   * `JSON.parse` returns these happily, and `assertUsable` then threw a raw
   * TypeError reading `.iss` off them — a crash where a refusal was meant.
   */
  it('refuses a payload that is valid JSON but not an object', () => {
    for (const payload of ['null', '42', '"a string"', '[1,2]']) {
      const encoded = Buffer.from(payload).toString('base64url');
      assert.throws(() => readClaims(`h.${encoded}.s`), /not a JSON object/, payload);
    }
  });

  /**
   * A real token's payload: unpadded, and in the URL alphabet, so the encoded
   * text here genuinely contains a `-` and a `_`.
   *
   * **This does not pin the `base64url` flag, and a first version of this test
   * claimed it did.** Swapping the decode to plain `'base64'` leaves every
   * assertion here green, because Node's base64 decoder accepts `-` and `_` and
   * tolerates missing padding — checked, not assumed. The original also used
   * claim values containing `-` and `_` in the *payload text*, which does not
   * put either character in the base64 output at all, so it never exercised the
   * case it described. Two ways of proving nothing in one test.
   *
   * What it does pin is worth keeping: that a payload shaped like a real token's
   * decodes to the right claims, rather than one shaped like the short ASCII
   * literals every other test here uses.
   */
  it('decodes an unpadded payload in the URL alphabet', () => {
    const claims = { sub: 'maintenance-admin', note: 'a?b>c' };
    const encoded = encode(claims);
    assert.match(encoded, /[-_]/);
    assert.doesNotMatch(encoded, /=/);
    assert.deepEqual(readClaims(`h.${encoded}.s`), claims);
  });
});
