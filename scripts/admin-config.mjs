#!/usr/bin/env node
//
// Read and change admin-managed configuration — validation thresholds, value
// sets, clinical default ranges — without editing a migration.
//
// This closes the gap R7 names: `validation_thresholds` is seeded by a
// migration (CLAUDE.md, "Validation"), and until now changing one meant writing
// a new migration, which is a release. AC 13.2 AC2 wants a threshold change to
// govern from the next client fetch with no application release, and ADR-0008
// sequences the admin console at P8 — so in between, "configuration is seeded
// by migration and changed by a maintenance script". This is that script, and
// ADR-0008 also calls it throwaway work: it is deliberately small, and the
// console supersedes it rather than growing out of it.
//
// ## It goes through the API, never the database
//
// The tempting shape is `psql -c "UPDATE validation_thresholds SET value = ..."`.
// That is wrong here, and not for style reasons: every one of these writes is
// audited, with the actor, a before value and an after value, inside the same
// transaction as the write (`apps/api/src/admin/config/`). A direct UPDATE
// writes **no audit row at all** — so the log does not record a partial story,
// it records nothing, and the only trace left anywhere is the row's own
// `updated_at` moving. Nothing on a stored observation says which bound it was
// checked against, so which bound governed at a given moment is then
// reconstructable from nowhere. A `psql` session also runs as a role that can
// rewrite `audit_events`, which ADR-0011 exists to prevent.
//
// So this speaks HTTP to `/api/v1/admin/...` as an authenticated admin, which
// means the writes it makes are indistinguishable from the console's.
//
//   node scripts/admin-config.mjs list [thresholds|value-sets|default-ranges]
//   node scripts/admin-config.mjs set-threshold <key> <value> [--label <text>] [--clear-label] [--yes]
//
// Exit status, matching scripts/dev-stack-status.sh so this is usable in a hook:
//   0  what was asked for happened
//   1  the request was refused, or the input was wrong
//   2  the API or the development IdP could not be reached at all
//   3  this script failed in a way it does not account for
//
// 3 exists so a crash is distinguishable from a refusal. An unhandled error
// also exits 1 by default, which would make "node is missing" and "the API said
// no" the same signal to a hook branching on these.

import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

const API_URL = (process.env.ADMIN_API_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * One value out of the repo's `.env`, read the way Compose reads it.
 *
 * Only `DEV_HOST_ADDRESS` is wanted, and only to derive the development
 * issuer. A real environment variable wins, so this never overrides an
 * explicit export.
 */
function fromDotEnv(name) {
  let text;
  try {
    text = readFileSync(join(REPO_ROOT, '.env'), 'utf8');
  } catch {
    return undefined;
  }
  // Deliberately not a general `.env` parser: no quotes, no interpolation, no
  // `export`. The one key this reads is a hostname.
  const line = text
    .split('\n')
    .map((candidate) => candidate.trimEnd())
    .find((candidate) => candidate.startsWith(`${name}=`));
  return line === undefined ? undefined : line.slice(name.length + 1).trim() || undefined;
}

/**
 * The admin issuer, and **there is deliberately no `localhost` fallback.**
 *
 * Both reviews of this PR put this first, and they were right. The first
 * version defaulted to `http://localhost:8090/admin-issuer`, which is the one
 * default `.env.example` spends twenty lines refusing to provide: the mock IdP
 * bakes the request's Host header into the token's `iss`, `apps/api` compares
 * `iss` by exact string equality, and `infra/docker-compose.yml` configures the
 * API as `http://${DEV_HOST_ADDRESS}:8090/admin-issuer`. So against a correctly
 * configured stack — where `DEV_HOST_ADDRESS` is a LAN address, which
 * `deploy-dev.yml` *requires* — this script minted a token reading `localhost`
 * and every request came back `401 ADMIN_AUTH_INVALID_ISSUER`.
 *
 * It only worked while developing because this machine's `.env` deliberately
 * sets `localhost` for a loopback-only rehearsal. That is the narrowest
 * possible case, and defaulting to it generalised a local accident.
 *
 * So: an explicit `ADMIN_OIDC_ISSUER` wins, otherwise it is derived from
 * `DEV_HOST_ADDRESS` exactly as Compose does, and otherwise it is **unknown**
 * and minting refuses rather than guessing. `undefined` is a legitimate state:
 * a caller supplying `ADMIN_TOKEN` needs no issuer at all.
 */
function resolveIssuer() {
  const explicit = process.env.ADMIN_OIDC_ISSUER;
  if (explicit !== undefined && explicit !== '') return explicit.replace(/\/+$/, '');
  const host = process.env.DEV_HOST_ADDRESS ?? fromDotEnv('DEV_HOST_ADDRESS');
  return host === undefined ? undefined : `http://${host}:8090/admin-issuer`;
}

const ISSUER = resolveIssuer();

// Becomes the token's `sub`, which becomes the audit row's actor id. It is
// therefore the answer to "who changed this bound", permanently, so it is named
// rather than defaulted silently — see `announceIdentity`.
const DEV_USERNAME = process.env.ADMIN_DEV_USERNAME ?? 'maintenance-admin';

/**
 * Which claim the API reads as the subject, because it is configuration.
 *
 * `ADMIN_OIDC_SUBJECT_CLAIM` defaults to `sub` (`env.schema.ts`) and
 * `AdminJwtAuthGuard` reads whatever it is set to. Hardcoding `sub` here meant
 * that against a stack configured otherwise this script would refuse a
 * perfectly good token with a confident, false explanation — and
 * `announceIdentity` would name the wrong actor for the audit row, which is the
 * one thing that gate exists to prevent.
 */
const SUBJECT_CLAIM = process.env.ADMIN_OIDC_SUBJECT_CLAIM ?? 'sub';

// Plain text rather than the ANSI colours the shell scripts here use: this
// output is as likely to be read from a redirected file or a CI log as from a
// terminal, and the labels are already distinct without colour.
const ok = (message) => console.log(`  ok      ${message}`);
const bad = (message) => console.error(`  FAIL    ${message}`);
const warn = (message) => console.warn(`  WARN    ${message}`);
const step = (message) => console.log(`==> ${message}`);

/**
 * The `iss` of the token in use, for the 401 diagnostic in `describeFailure`.
 * Module-level because every request shares one token.
 */
let observedIssuer;

class Refused extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

// --- talking to the API -------------------------------------------------------

/**
 * An admin failure response, rendered.
 *
 * The codes are a closed vocabulary by design: the 400s name the field and a
 * rule code and never the offending value, because these surfaces must not echo
 * input back (CLAUDE.md, "Validation"). So this prints the code and the field
 * list and does not look for a human-readable message — there is none, and a
 * script inventing prose for a code it does not recognise would be guessing at
 * what the server meant.
 *
 * **There are two envelope shapes, and assuming one was a bug here.** The
 * config routes answer `{ error: { code, fields? } }`; `AdminJwtAuthGuard`
 * answers a FLAT `{ code }` — a real 401 is `{"code":"ADMIN_AUTH_MALFORMED_TOKEN"}`.
 * Reading only the nested shape made every auth failure print "no error
 * envelope, this did not come from an admin route", which is both wrong and
 * actively misleading: it came from the admin guard, it said exactly why, and
 * the reader was sent looking for a proxy problem instead. Found by pointing a
 * patient-issuer token at it.
 */
export function describeFailure(status, body, context = {}) {
  const code = body?.error?.code ?? body?.code;
  if (!code) {
    // Either a route that is not there (so the stack is older than this script)
    // or something upstream of the API. Both are worth saying plainly.
    const guess =
      status === 404
        ? 'the route is absent, so the stack is probably older than this script — run scripts/dev-stack-status.sh'
        : 'this came from neither an admin route nor the admin guard';
    return `HTTP ${status} with no recognised error body — ${guess}`;
  }
  /**
   * The Host-header trap, reported where it can actually fire.
   *
   * This explanation used to live on the minting path, where it was vacuous:
   * the token is fetched from `${ISSUER}/token`, so the token's `iss` equals
   * this script's `ISSUER` *by construction* and a comparison between them
   * establishes nothing. Both reviews said so. The only authority on the
   * expected issuer is the API's own `ADMIN_OIDC_ISSUER`, which this script
   * cannot read — but the API will say when they disagree, and this is that
   * moment.
   */
  if (code === 'ADMIN_AUTH_INVALID_ISSUER') {
    const carried =
      context.tokenIssuer === undefined ? '' : ` The token carried iss=${context.tokenIssuer}.`;
    return (
      `HTTP ${status} ${code} —${carried} The API compares \`iss\` by exact string equality ` +
      'against its own ADMIN_OIDC_ISSUER, which is derived from DEV_HOST_ADDRESS in ' +
      'infra/docker-compose.yml. Set ADMIN_OIDC_ISSUER here to the value the API was given.'
    );
  }

  const fields = body?.error?.fields;
  if (!Array.isArray(fields) || fields.length === 0) return `HTTP ${status} ${code}`;
  const named = fields.map((field) => `${field.field || '(body)'}: ${field.rule}`).join(', ');
  return `HTTP ${status} ${code} — ${named}`;
}

async function request(method, path, token, body) {
  const url = `${API_URL}/api/v1${path}`;
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (cause) {
    throw new Refused(`could not reach ${url} — ${cause.message}`, 2);
  }

  const text = await response.text();
  let parsed;
  try {
    parsed = text === '' ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }

  if (!response.ok) {
    throw new Refused(describeFailure(response.status, parsed, { tokenIssuer: observedIssuer }), 1);
  }
  return parsed;
}

// --- authentication -----------------------------------------------------------

/**
 * A token's claims, read without verifying the signature.
 *
 * Deliberate, and worth being explicit about so nobody mistakes it for a check:
 * the API verifies the signature, the issuer and the audience, and this script
 * is not a second authority on any of that. This exists only to turn two
 * failures that otherwise arrive as a bare `401` into a sentence saying what is
 * wrong, because a bare 401 from an admin route reads as a broken guard and
 * sends the reader into the wrong code.
 */
export function readClaims(token) {
  const segments = token.split('.');
  if (segments.length !== 3) {
    throw new Refused('that token is not a JWT (expected three dot-separated segments)');
  }
  let claims;
  try {
    claims = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
  } catch {
    throw new Refused('that token has a payload that is not JSON');
  }
  // `JSON.parse` happily returns `null`, a number or a string, each of which
  // then threw a raw TypeError one line later in `assertUsable` — a crash
  // where a refusal was intended.
  if (claims === null || typeof claims !== 'object' || Array.isArray(claims)) {
    throw new Refused('that token has a payload that is not a JSON object');
  }
  return claims;
}

/**
 * The two ways a plausible-looking admin token is rejected, caught before the
 * request rather than after it.
 *
 * Both were found by running this against the real stack, and neither is
 * guessable from the code:
 *
 * 1. **No `sub`.** `grant_type=client_credentials` against the mock IdP mints a
 *    perfectly valid token whose `sub` is absent. `AdminJwtAuthGuard` refuses it
 *    with `MISSING_SUBJECT_CLAIM`, and it has to: `sub` is what lands in the
 *    audit row as the actor, so a token without one cannot make an attributable
 *    write. That is the whole point of the claim, and a script that fell back to
 *    some placeholder actor would be putting a false author on an immutable row.
 *
 * 2. **An `iss` that does not match.** The mock IdP derives its advertised
 *    issuer from the request's Host header, and the API compares `iss` to its
 *    configured `ADMIN_OIDC_ISSUER` by exact string equality. Reaching the IdP
 *    by any other name — a LAN address, `127.0.0.1` instead of `localhost` —
 *    yields a token that looks fine and is refused on every request. That is the
 *    same trap `scripts/android-emulator.sh` documents for the patient issuer,
 *    where it cost a session.
 */
function assertUsable(claims) {
  observedIssuer = typeof claims.iss === 'string' ? claims.iss : undefined;

  /**
   * Only meaningful for a token supplied through `ADMIN_TOKEN`.
   *
   * On the minting path this comparison is a tautology — see
   * `describeFailure`'s note — so it is kept for the externally-supplied case
   * and the real diagnostic lives on the API's own 401.
   */
  if (ISSUER !== undefined && observedIssuer !== ISSUER) {
    warn(
      `this token says iss=${String(claims.iss)} but the issuer resolved here is ${ISSUER}. ` +
        'The API is the authority on which it expects; if every request comes back 401, this ' +
        'difference is why.',
    );
  }

  const subject = claims[SUBJECT_CLAIM];
  if (typeof subject !== 'string' || subject === '') {
    throw new Refused(
      `this token carries no \`${SUBJECT_CLAIM}\` claim, so the API will refuse it with ` +
        'MISSING_SUBJECT_CLAIM. A client-credentials grant produces exactly this: there is no ' +
        'user, so there is no subject, and an admin write has to be attributable to one. Use a ' +
        'grant that has a subject. (The claim name is configuration — ' +
        'ADMIN_OIDC_SUBJECT_CLAIM.)',
    );
  }
  return subject;
}

/**
 * Whether the stack this is pointed at is a development one, asked of the stack.
 *
 * `/api/v1/health` reports `buildCommit` only when `nodeEnv === 'development'`
 * (`apps/api/src/health/health.controller.ts`), so a non-null value is the
 * server's own statement about which environment it is — not an inference from
 * the URL, which would make `localhost` a security boundary it is not.
 *
 * **This is a guard against a mistyped command, not a security boundary**, in
 * exactly the sense CLAUDE.md uses of `ALLOW_SYNTHETIC_SEED`. Two reasons, both
 * worth knowing before anyone leans on it. `nodeEnv` is
 * `.default('development')` in `env.schema.ts`, so "reports a commit" means
 * "NODE_ENV is development **or unset**" — the shipped image sets it, a bare
 * `node dist/main.js` does not. And it answers false for a genuine dev stack
 * brought up without `BUILD_COMMIT` exported, which is a state
 * `docs/deployment-development.md` exists because it happens. It fails closed
 * either way, which is the right direction; it is not a control.
 */
async function isDevelopmentStack() {
  const health = await request('GET', '/health', undefined);
  return typeof health?.buildCommit === 'string' && health.buildCommit !== '';
}

/**
 * Minted from the development mock IdP with a password grant.
 *
 * The token URL is derived from `ISSUER` and not from `API_URL`, which is what
 * makes the `iss` check above pass by construction: the Host header this request
 * sends is the host the IdP will bake into the token.
 */
async function mintDevToken() {
  if (ISSUER === undefined) {
    throw new Refused(
      'no admin issuer is known, so this script will not guess one. Set ADMIN_OIDC_ISSUER, or ' +
        'DEV_HOST_ADDRESS (in .env, as Compose reads it) to the address this host is reached ' +
        'by. There is deliberately no localhost default — see .env.example on why.',
    );
  }
  const url = `${ISSUER}/token`;
  const body = new URLSearchParams({
    // Not `client_credentials`. See `assertUsable`.
    grant_type: 'password',
    username: DEV_USERNAME,
    // The mock IdP does not check it, which is the whole reason this is safe to
    // commit: it is not a credential, it unlocks nothing, and no real IdP is
    // reachable by this path. That argument stands on its own — an earlier
    // version of this comment also leaned on the development-stack gate above,
    // which is a guard against a mistyped command rather than a boundary and so
    // carries no weight here.
    password: 'unchecked-by-the-mock-idp',
    client_id: 'maintenance',
    scope: 'openid',
  });

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch (cause) {
    throw new Refused(`could not reach the development IdP at ${url} — ${cause.message}`, 2);
  }
  if (!response.ok) {
    throw new Refused(`the development IdP refused the grant: HTTP ${response.status}`);
  }
  const token = (await response.json())?.access_token;
  if (typeof token !== 'string') throw new Refused('the development IdP returned no access_token');
  return token;
}

async function acquireToken() {
  // Trimmed, and a pasted `Bearer ` prefix removed: that form passes
  // `readClaims` (still three decodable segments) and then fails at the guard
  // as MALFORMED_TOKEN, which sends the reader somewhere else entirely.
  const supplied = (process.env.ADMIN_TOKEN ?? '').trim().replace(/^Bearer\s+/i, '');
  if (supplied !== '') return supplied;

  if (!(await isDevelopmentStack())) {
    throw new Refused(
      `${API_URL} did not report a build commit, so this script will not mint a token for it. ` +
        'Either it is not a development stack — set ADMIN_TOKEN to a real admin bearer token — ' +
        'or it is one that was built without BUILD_COMMIT set, which ' +
        'docs/deployment-development.md covers under "Deploying by hand".',
    );
  }
  return mintDevToken();
}

/**
 * What is about to be written, and to where, printed before it writes.
 *
 * Two things that are easy to get wrong and expensive to discover afterwards.
 *
 * The identity is recorded on an audit row **no request handler can modify or
 * delete** — the careful phrasing ADR-0011's status line requires, since
 * ADR-0017 narrowed the guarantee to that and explicitly forbids calling the
 * log strictly immutable. It is the answer to "who changed this bound", so
 * printing it is how a human notices a wrong actor while it is still cheap.
 *
 * The target is named because nothing else names it: `ADMIN_TOKEN` short-
 * circuits the development gate entirely and `ADMIN_API_URL` selects the stack
 * silently, so an operator with either left over from an earlier command would
 * otherwise see a diff, an actor and `apply?` with no indication of which API
 * is about to change.
 *
 * In development the actor is an unverified self-assertion: the mock IdP does
 * not check the password, so `ADMIN_DEV_USERNAME` is whatever the operator
 * says. Never cite a development audit row as evidence of who did something.
 */
function announceIdentity(subject) {
  ok(`writing to ${API_URL} as \`${subject}\`, which is what the audit row will record`);
}

// --- reads --------------------------------------------------------------------

/**
 * A default range's bounds, which may be one-sided.
 *
 * `lowValue` and `highValue` are each nullable and the create refuses only the
 * case where BOTH are null, so a floor-only or ceiling-only range is a
 * legitimate row — `urine_output_ml` has no clinically meaningful upper bound.
 * Printing `null to 1200 mL` would read as a defect in the data rather than as
 * what it is.
 */
export function describeBounds(range) {
  const unit = range.unit;
  /**
   * Both-null is refused by the create, and this listing still has to render
   * it, because the wire module is explicit that the table has no unique and
   * no CHECK constraints — "a migration, a seeder or a psql session can still
   * create a state the API refuses". This listing is the tool someone would
   * reach for to find such a row, so printing `up to null mL` for it was the
   * exact defect this function exists to prevent.
   */
  if (range.lowValue === null && range.highValue === null) {
    return `no bounds — invalid row, refused by the create (${unit})`;
  }
  if (range.lowValue === null) return `up to ${String(range.highValue)} ${unit}`;
  if (range.highValue === null) return `${String(range.lowValue)} ${unit} and above`;
  return `${String(range.lowValue)} to ${String(range.highValue)} ${unit}`;
}

const SURFACES = {
  thresholds: {
    path: '/admin/thresholds',
    render: (body) => {
      for (const row of body.thresholds) {
        const unit = row.unit === null ? '' : ` ${row.unit}`;
        const fixed = row.patientAdjustable ? '' : '  [not patient-adjustable]';
        console.log(`  ${row.thresholdKey}`);
        console.log(`      ${String(row.value)}${unit}   ${row.tier}${fixed}`);
      }
      return body.thresholds.length;
    },
  },
  'value-sets': {
    path: '/admin/value-sets',
    render: (body) => {
      for (const set of body.valueSets) {
        console.log(`  ${set.key}`);
        for (const member of set.members) {
          // Retirement is expressed to a CLIENT by absence from the
          // patient-facing `GET /api/v1/value-sets`, never by a flag — but this
          // admin surface reports retired members, because an admin needs to see
          // what was withdrawn and a retired code must still resolve when
          // rendering history. Marked, so the two views are not confused with
          // each other.
          const retired = member.status === 'RETIRED' ? `  RETIRED ${member.retiredAt}` : '';
          // `numericValue` is the clinical meaning of a code — what "mug_350"
          // actually counts as — so it belongs in a listing an admin reads
          // before changing one.
          const quantity =
            member.numericValue === null
              ? ''
              : `  = ${String(member.numericValue)} ${String(member.numericUnit)}`;
          console.log(`      ${member.code}${quantity}${retired}`);
        }
      }
      return body.valueSets.length;
    },
  },
  'default-ranges': {
    path: '/admin/default-ranges',
    render: (body) => {
      for (const range of body.defaultRanges) {
        // A null `minDaysPostOp` means "from surgery" — day 0, not "unknown".
        const from = range.minDaysPostOp ?? 0;
        const to = range.maxDaysPostOp === null ? 'onward' : `day ${String(range.maxDaysPostOp)}`;
        const window = range.windowDays === null ? '' : `, ${String(range.windowDays)}-day window`;
        console.log(
          `  ${range.ostomyType} ${range.rangeType}  (day ${String(from)} to ${to}${window})`,
        );
        console.log(`      ${describeBounds(range)}`);
      }
      return body.defaultRanges.length;
    },
  },
};

async function list(which, token) {
  const names = which === undefined ? Object.keys(SURFACES) : [which];
  for (const name of names) {
    const surface = SURFACES[name];
    if (surface === undefined) {
      throw new Refused(`unknown surface \`${name}\`. One of: ${Object.keys(SURFACES).join(', ')}`);
    }
    step(name);
    const count = surface.render(await request('GET', surface.path, token));
    if (count === 0) ok('none');
  }
}

// --- the write ----------------------------------------------------------------

/**
 * The description to send, which is never "leave it alone" — the PUT body is
 * `.strict()` with `description` required, so there is always a value to pick.
 *
 * `--label ''` is refused rather than sent. `options.label ?? current` passed
 * the empty string straight through, and `admin-threshold-wire.ts` has no
 * `.min(1)`, so it persisted — re-opening the second "no label" state that
 * module's comment says was deliberately withdrawn, where `''` and `null`
 * render identically while their audit snapshots differ. Caught by review, and
 * it is exactly the kind of thing that was invisible while this logic lived
 * inside the I/O function, which is why it is out here and tested.
 */
export function resolveDescription(options, current) {
  if (options['clear-label'] === true) return null;
  if (options.label === undefined) return current.description;
  if (options.label === '') {
    throw new Refused('--label cannot be empty. Use --clear-label to remove the label.');
  }
  return options.label;
}

/**
 * What this script can honestly warn about, and what it cannot.
 *
 * It cannot tell whether a value is clinically sensible for its key — a 20 mL
 * stoma-output warning passes every rule the API enforces. That is tracked as a
 * per-key settable range held as configuration (#93), because choosing those
 * numbers is a clinical decision rather than a refactor. What it can do is name
 * the cases where a wrong number does something worse than warn.
 */
export function tierWarnings(current) {
  const messages = [];
  if (current.tier === 'TIER_1_HARD_BLOCK') {
    messages.push(
      'Tier 1 hard block: too tight a bound refuses entries outright, with no override.',
    );
  }
  if (current.tier === 'SAFETY_THRESHOLD') {
    messages.push(
      'safety threshold: it drives a clinical safety response, not a data-quality warning.',
    );
  }
  if (current.tier === 'OPERATIONAL') {
    messages.push(
      'operational, not clinical: the label above says what it governs, and the safe direction ' +
        'is not always the smaller number.',
    );
  }
  if (current.thresholdKey === 'sync_clock_skew_allowance_seconds') {
    // Named rather than left to the generic warning, because this is the one
    // seeded OPERATIONAL row and the expensive direction is counter-intuitive:
    // "allowance" reads as slack to tighten, and tightening it Tier-1 blocks
    // every queued entry from every patient whose phone clock runs slightly
    // fast — each landing in a correction inbox describing a problem the
    // patient cannot fix. ADR-0019 calls this "the expensive direction".
    messages.push(
      'LOWERING this value is the expensive direction (ADR-0019): it hard-blocks queued entries ' +
        'from every patient whose device clock runs fast, with no override.',
    );
  }
  if (!current.patientAdjustable) {
    messages.push(
      'not patient-adjustable, so this governs every patient with no way for one to widen it.',
    );
  }
  return messages;
}

async function confirm(question, assumeYes) {
  if (assumeYes) return true;
  if (!process.stdin.isTTY) {
    throw new Refused(
      'this changes configuration that governs clinical validation and there is no terminal to ' +
        'confirm on. Pass --yes if that is intended.',
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    // `yes` too, not only `y` — typing the whole word and having it read as a
    // cancel is a bad surprise on a prompt whose default is no.
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

async function setThreshold(key, rawValue, options, token) {
  const value = Number(rawValue);
  if (!Number.isFinite(value)) throw new Refused(`\`${rawValue}\` is not a number`);
  if (options.label !== undefined && options['clear-label'] === true) {
    throw new Refused('--label and --clear-label contradict each other');
  }

  /**
   * The read is not only for display, and this is the part worth not
   * "optimising" away.
   *
   * `PUT /admin/thresholds/:key` takes a `.strict()` body in which BOTH `value`
   * and `description` are required — the body is the complete new state of the
   * mutable pair, deliberately, so that "absent" never has to mean "unchanged".
   * So a `set-threshold` that changes only the value must send the existing
   * description back, or it silently clears the admin-tool label. Carrying it
   * forward requires reading it first.
   *
   * **This read-then-write is last-write-wins, and the script cannot make it
   * otherwise.** `updateThreshold` accepts an `expectedUpdatedAt`, but the
   * controller never passes one and the body is `.strict()` over
   * `{value, description}`, so the HTTP surface exposes no concurrency token at
   * all. A change committed between this GET and the PUT below is therefore
   * overwritten, and the carried-forward `description` would revert a label
   * another operator had just set.
   *
   * What keeps the AUDIT CHAIN sound is on the server, not here: the service's
   * conditional `where: { id, updatedAt }` is evaluated against the row as read
   * inside its own transaction, so two concurrent writers cannot both record
   * the same before-value — the loser gets
   * `409 THRESHOLD_MODIFIED_CONCURRENTLY`, which `describeFailure` renders. The
   * consequence for this script is narrower and worth stating plainly: the
   * before-value it PRINTS is its own read, not necessarily the one the audit
   * row recorded. With one operator, which is the whole of ADR-0008's
   * in-between period, neither can happen.
   */
  const current = (await request('GET', '/admin/thresholds', token)).thresholds.find(
    (row) => row.thresholdKey === key,
  );
  if (current === undefined) {
    throw new Refused(
      `no threshold \`${key}\`. There is no upsert on this surface: a key the table does not ` +
        'hold is configuration no clinical rule reads. Run `list thresholds` to see the keys.',
    );
  }

  const description = resolveDescription(options, current);

  step(key);
  console.log(`      value   ${String(current.value)}  ->  ${String(value)}`);
  // The label is printed ALWAYS, not only when it changes. The operational
  // warning below tells the reader to consult it, and in the ordinary
  // value-only call it was never shown — a warning pointing at text the
  // operator cannot see.
  if (description === current.description) {
    console.log(`      label   ${String(current.description)}`);
  } else {
    const after = description === null ? '(cleared)' : String(description);
    console.log(`      label   ${String(current.description)}  ->  ${after}`);
  }
  console.log(`      tier    ${current.tier}  (immutable)`);

  for (const message of tierWarnings(current)) warn(message);

  if (!(await confirm(`apply to ${API_URL}?`, options.yes === true))) {
    throw new Refused('cancelled, nothing was written');
  }

  const written = await request('PUT', `/admin/thresholds/${encodeURIComponent(key)}`, token, {
    value,
    description,
  });

  /**
   * The response is the persisted row, so this compares what governs against
   * what was asked for rather than treating a 200 as proof. The canonical column
   * is `DECIMAL(12,4)`; a value that does not fit is refused rather than rounded,
   * and this is the check that would notice if that stopped being true.
   */
  if (written.value !== value) {
    bad(
      `the API stored ${String(written.value)}, not ${String(value)} — it was altered on write. ` +
        'The write LANDED and is audited; it is the value that is not what was asked for.',
    );
    throw new Refused('the stored value does not match what was sent');
  }
  // "was X at the time of the read", not "from X": `current.value` came from
  // this script's own GET, not from the audit row. See the note on the read
  // above for why those can differ.
  ok(`${key} is now ${String(written.value)} (it read ${String(current.value)} before the write)`);
  // Not an `ok` line of the same kind as the one above, which is verified
  // against the response. This one is a property of the endpoint, asserted
  // here and proven by `admin-thresholds.integration.spec.ts` — a suite that
  // skips itself without Docker. The house style distinguishes these.
  console.log('  (audited by the endpoint: before and after, attributed to this actor)');
  console.log('');
  console.log('  It governs from each client next fetching `GET /api/v1/thresholds`.');
  console.log('  `apps/mobile` caches that response so it can validate offline, so a');
  console.log('  device keeps the old bound until it next fetches.');
}

// --- entry point --------------------------------------------------------------

const USAGE = `Usage:
  node scripts/admin-config.mjs list [thresholds|value-sets|default-ranges]
  node scripts/admin-config.mjs set-threshold <key> <value> [--label <text>] [--clear-label] [--yes]

\`list\` reads all three surfaces. \`set-threshold\` is the only write: value sets and
clinical default ranges are read-only here, so the heart-rate red flag — which lives in
clinical_default_ranges — is still migration-only.

Environment:
  ADMIN_API_URL       the API, default http://localhost:3000
  ADMIN_TOKEN         an admin bearer token. Required against any stack that does not
                      report a build commit. A leading "Bearer " is stripped.
  ADMIN_OIDC_ISSUER   the admin issuer. Falls back to http://$DEV_HOST_ADDRESS:8090/admin-issuer,
                      read from the environment or from .env as Compose reads it.
                      There is deliberately NO localhost default: the mock IdP bakes the
                      request Host into the token's iss and the API compares it exactly,
                      so guessing produces tokens that are refused on every request.
                      Minting refuses rather than guess.
  ADMIN_OIDC_SUBJECT_CLAIM  which claim is the subject, default sub. Must match the API.
  ADMIN_DEV_USERNAME  the development subject, default maintenance-admin. It becomes the
                      audit row's actor id.`;

/**
 * The command line, refused rather than thrown on.
 *
 * `parseArgs` throws `ERR_PARSE_ARGS_UNKNOWN_OPTION` for `--dry-run` and
 * `ERR_PARSE_ARGS_INVALID_OPTION_VALUE` for a bare trailing `--label`, and
 * `set-threshold key -5` is read as short options. Each produced a raw Node
 * stack trace and exit 1 — the same status as a refusal, from a script whose
 * header advertises its exit codes as the thing a hook branches on.
 */
function readCommandLine() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        label: { type: 'string' },
        'clear-label': { type: 'boolean' },
        yes: { type: 'boolean' },
        help: { type: 'boolean' },
      },
    });
  } catch (error) {
    throw new Refused(
      `${error.message}\n\nA negative value needs \`--\` first: ` +
        `set-threshold <key> -- -5\n\n${USAGE}`,
    );
  }
}

async function main() {
  const { values: options, positionals } = readCommandLine();

  const [command, ...rest] = positionals;
  if (options.help === true || command === undefined) {
    console.log(USAGE);
    return;
  }

  /**
   * The command is validated BEFORE a credential is acquired.
   *
   * `acquireToken()` used to run first, so a typo'd subcommand probed
   * `/health` and minted a token before answering "unknown command". Doing
   * neither for input that cannot be acted on is both faster and the right
   * default for anything that handles credentials.
   */
  const arity = { list: [0, 1], 'set-threshold': [2, 2] }[command];
  if (arity === undefined) {
    throw new Refused(`unknown command \`${command}\`\n\n${USAGE}`);
  }
  if (rest.length < arity[0] || rest.length > arity[1]) {
    throw new Refused(
      command === 'list'
        ? 'list takes at most one surface name'
        : 'set-threshold takes a key and a value',
    );
  }

  const token = await acquireToken();
  const subject = assertUsable(readClaims(token));

  if (command === 'list') {
    await list(rest[0], token);
    return;
  }
  announceIdentity(subject);
  await setThreshold(rest[0], rest[1], options, token);
}

/**
 * Run as a program only when run as a program.
 *
 * `admin-config.test.mjs` imports the pure helpers above, and without this
 * guard the import would execute `main()` — mint a token, call the API, and
 * exit the test process. `import.meta.main` would read better and is
 * deliberately not used: it landed in Node 24.2 and `engines` here allows
 * `>=24.0.0`, where it is `undefined` and the script would silently do nothing
 * at all. This comparison works on every version.
 *
 * `argv[1]` is resolved through `realpathSync` because `import.meta.url` for
 * the ESM entry point already is. Reached through a symlink, a Windows
 * junction or a `subst` drive the two spellings differ, the guard does not
 * match, and the script exits 0 having done nothing — which is the same silent
 * no-op this comment criticises `import.meta.main` for.
 */
function invokedDirectly() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return fileURLToPath(import.meta.url) === process.argv[1];
  }
}

if (invokedDirectly()) {
  await run();
}

async function run() {
  try {
    await main();
  } catch (error) {
    if (!(error instanceof Refused)) {
      /**
       * Exit 3, and the stack, for anything this script does not account for.
       *
       * Rethrowing gave an unhandled rejection, which Node exits 1 for — the
       * same code as a refusal. A hook branching on the documented statuses
       * then cannot tell "the API said no" from "this script is broken".
       */
      bad('this script failed in a way it does not account for:');
      console.error(error);
      process.exitCode = 3;
      return;
    }
    bad(error.message);
    /**
     * `process.exitCode` and a natural exit, never `process.exit()`.
     *
     * `process.exit()` here aborts on Windows — `Assertion failed:
     * !(handle->flags & UV_HANDLE_CLOSING), file src\win\\async.c` — and the
     * process then reports **127**, not the status that was asked for. Which
     * makes the abort worse than cosmetic: this script documents its exit codes
     * as the thing a hook should branch on, and a refusal that exits 127 is
     * indistinguishable from "node could not be found".
     *
     * It happens because tearing the process down mid-flight closes a libuv
     * handle that the keep-alive sockets `fetch` left behind are still closing.
     * Setting the code and letting the event loop drain leaves nothing to race.
     */
    process.exitCode = error.exitCode;
  }
}
