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
// produces no audit row at all, so the log would record that a bound changed at
// some point with no record of what it used to be — and nothing on a stored
// observation says which bound it was checked against, so that history is not
// reconstructable from anywhere else. A `psql` session also runs as a role that
// can rewrite `audit_events`, which ADR-0011 exists to prevent.
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
//   2  the API could not be reached at all

import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const API_URL = (process.env.ADMIN_API_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

// The mock IdP in development. Used for two things that must agree: deriving the
// token endpoint, and checking the `iss` of what comes back.
const ISSUER = (process.env.ADMIN_OIDC_ISSUER ?? 'http://localhost:8090/admin-issuer').replace(
  /\/+$/,
  '',
);

// Becomes the token's `sub`, which becomes the audit row's actor id. It is
// therefore the answer to "who changed this bound", permanently, so it is named
// rather than defaulted silently — see `announceIdentity`.
const DEV_USERNAME = process.env.ADMIN_DEV_USERNAME ?? 'maintenance-admin';

// Plain text rather than the ANSI colours the shell scripts here use: this
// output is as likely to be read from a redirected file or a CI log as from a
// terminal, and the labels are already distinct without colour.
const ok = (message) => console.log(`  ok      ${message}`);
const bad = (message) => console.error(`  FAIL    ${message}`);
const warn = (message) => console.warn(`  WARN    ${message}`);
const step = (message) => console.log(`==> ${message}`);

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
export function describeFailure(status, body) {
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

  if (!response.ok) throw new Refused(describeFailure(response.status, parsed), 1);
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
  try {
    return JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
  } catch {
    throw new Refused('that token has a payload that is not JSON');
  }
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
  // The warning comes first deliberately. It was below the throw, where a token
  // that had both problems reported only one of them — and a user fixing the
  // grant would then hit the issuer mismatch as a fresh mystery.
  if (claims.iss !== ISSUER) {
    // Not fatal: ADMIN_OIDC_ISSUER here is this script's guess at what the API
    // was configured with, and the API is the authority. Refusing on it would
    // block a correct token over a wrong local default.
    warn(
      `this token says iss=${String(claims.iss)} but ADMIN_OIDC_ISSUER here is ${ISSUER}. ` +
        'If every request comes back 401, that difference is why — the API compares `iss` by ' +
        'exact string equality.',
    );
  }
  if (typeof claims.sub !== 'string' || claims.sub === '') {
    throw new Refused(
      'this token carries no `sub`, so the API will refuse it with MISSING_SUBJECT_CLAIM. ' +
        'A client-credentials grant produces exactly this: there is no user, so there is no ' +
        'subject, and an admin write has to be attributable to one. Use a grant that has a ' +
        'subject.',
    );
  }
  return claims.sub;
}

/**
 * Whether the stack this is pointed at is a development one, asked of the stack.
 *
 * `/api/v1/health` reports `buildCommit` only when `nodeEnv === 'development'`
 * (`apps/api/src/health/health.controller.ts`), so a non-null value is the
 * server's own statement about which environment it is — not an inference from
 * the URL, which would make `localhost` a security boundary it is not.
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
  const url = `${ISSUER}/token`;
  const body = new URLSearchParams({
    // Not `client_credentials`. See `assertUsable`.
    grant_type: 'password',
    username: DEV_USERNAME,
    // The mock IdP does not check it. Said out loud so a reader finding a
    // literal password in a script can see immediately that it is not a
    // credential — and because this path is refused against any stack that does
    // not report itself as development.
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
  const supplied = process.env.ADMIN_TOKEN;
  if (supplied !== undefined && supplied !== '') return supplied;

  if (!(await isDevelopmentStack())) {
    throw new Refused(
      `${API_URL} does not report itself as a development stack, so this script will not mint a ` +
        'token for it. Set ADMIN_TOKEN to a real admin bearer token.',
    );
  }
  return mintDevToken();
}

/**
 * Who this is about to write as, printed before it writes.
 *
 * The identity is not incidental: it is recorded on an append-only audit row
 * that cannot later be corrected, and it is the answer to "who changed this
 * bound". Printing it is how a human notices they are about to attribute a
 * change to the wrong actor while it is still cheap.
 */
function announceIdentity(subject) {
  ok(`writing as \`${subject}\`, which is what the audit row will record`);
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
    return (await rl.question(`${question} [y/N] `)).trim().toLowerCase() === 'y';
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

  const description =
    options['clear-label'] === true ? null : (options.label ?? current.description);

  step(key);
  console.log(`      value   ${String(current.value)}  ->  ${String(value)}`);
  if (description !== current.description) {
    console.log(`      label   ${String(current.description)}  ->  ${String(description)}`);
  }
  console.log(`      tier    ${current.tier}  (immutable)`);

  /**
   * The warnings this script can honestly give, and the one it cannot.
   *
   * It cannot tell whether a value is clinically sensible for its key — a 20 mL
   * stoma-output warning passes every rule the API enforces. That is tracked as
   * a per-key settable range held as configuration (#93), because choosing those
   * numbers is a clinical decision rather than a refactor. What it can do is name
   * the cases where a wrong number does something worse than warn.
   */
  if (current.tier === 'TIER_1_HARD_BLOCK') {
    warn('Tier 1 hard block: too tight a bound refuses entries outright, with no override.');
  }
  if (current.tier === 'SAFETY_THRESHOLD') {
    warn('safety threshold: it drives a clinical safety response, not a data-quality warning.');
  }
  if (current.tier === 'OPERATIONAL') {
    warn('operational, not clinical: read the description before assuming a safe direction.');
  }
  if (!current.patientAdjustable) {
    warn('not patient-adjustable, so this governs every patient with no way for one to widen it.');
  }

  if (!(await confirm('apply?', options.yes === true))) {
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
    bad(`the API stored ${String(written.value)}, not ${String(value)} — it was altered on write`);
    throw new Refused('the stored value does not match what was sent');
  }
  ok(`${key} is now ${String(written.value)}, from ${String(current.value)}`);
  ok('audited: before and after are on an append-only row, attributed to this actor');
  console.log('');
  console.log('  It governs from each client next fetching `GET /api/v1/thresholds`.');
  console.log('  `apps/mobile` caches that response so it can validate offline, so a');
  console.log('  device keeps the old bound until it next fetches.');
}

// --- entry point --------------------------------------------------------------

const USAGE = `Usage:
  node scripts/admin-config.mjs list [thresholds|value-sets|default-ranges]
  node scripts/admin-config.mjs set-threshold <key> <value> [--label <text>] [--clear-label] [--yes]

Environment:
  ADMIN_API_URL       the API, default http://localhost:3000
  ADMIN_TOKEN         an admin bearer token. Required against any stack that does not
                      report itself as development.
  ADMIN_OIDC_ISSUER   the issuer, default http://localhost:8090/admin-issuer. In
                      development the token is minted from it, and the token endpoint is
                      derived from this value so the \`iss\` the API checks matches.
  ADMIN_DEV_USERNAME  the development subject, default maintenance-admin. It becomes the
                      audit row's actor id.`;

async function main() {
  const { values: options, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      label: { type: 'string' },
      'clear-label': { type: 'boolean' },
      yes: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });

  const [command, ...rest] = positionals;
  if (options.help === true || command === undefined) {
    console.log(USAGE);
    return;
  }

  const token = await acquireToken();
  const subject = assertUsable(readClaims(token));

  switch (command) {
    case 'list':
      if (rest.length > 1) throw new Refused('list takes at most one surface name');
      await list(rest[0], token);
      return;
    case 'set-threshold':
      if (rest.length !== 2) throw new Refused('set-threshold takes a key and a value');
      announceIdentity(subject);
      await setThreshold(rest[0], rest[1], options, token);
      return;
    default:
      throw new Refused(`unknown command \`${command}\`\n\n${USAGE}`);
  }
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
 */
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await run();
}

async function run() {
  try {
    await main();
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    bad(error.message);
    /**
     * `process.exitCode` and a natural exit, never `process.exit()`.
     *
     * `process.exit()` here aborts on Windows — `Assertion failed:
     * !(handle->flags & UV_HANDLE_CLOSING), file src\winsync.c` — and the
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
