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
// Scope is the three functions where a wrong answer is silent. Everything else
// in that script is I/O against a live stack, verified by running it rather
// than by mocking `fetch` — a mock of these surfaces would assert that the
// script agrees with my model of the API, which is exactly what was wrong twice
// while writing it (`valueSetKey` for `key`, and one envelope shape for two).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { describeBounds, describeFailure, readClaims } from './admin-config.mjs';

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

  it('does not claim a non-404 came from somewhere it cannot know about', () => {
    const rendered = describeFailure(502, undefined);
    assert.match(rendered, /HTTP 502/);
    assert.doesNotMatch(rendered, /older than this script/);
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

  it('keeps a negative bound, unlike an entered volume', () => {
    // Tier 1's positive-value rule is about entered volumes. A default RANGE
    // legitimately has a negative floor.
    assert.equal(
      describeBounds({ lowValue: -800, highValue: -100, unit: 'mL' }),
      '-800 to -100 mL',
    );
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
