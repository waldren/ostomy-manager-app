# API / Backend

Backend service: authentication, data sync, FHIR-mapped storage, and RxNorm medication lookups.

NestJS, TypeScript, REST (`/api/v1/...`). Scaffolded at P1.S1: typed/validated configuration, the
patient (`JwtAuthGuard`) and admin (`AdminJwtAuthGuard`) OIDC guards, a liveness health check, OpenAPI
generation, and a structured Pino logger. P1.S3 added the FHIR-shaped Postgres schema and
`PrismaService`. P1.S5 added the audit interceptor and `ThresholdsService` — see "Structure" below.
P2.S1a added the first business-logic (PHI) endpoints — `POST` and `GET /api/v1/observations`, stoma
output only — along with the dedicated OpenAPI emitter and the generator that produces the typed
client in `packages/core/src/api-client`. Sync (`/api/v1/sync/push`, `/api/v1/sync/delta`) lands at
P2.S1b per `design-specs/planning/v1-implementation-plan.md`.

## Commands

Run from this directory, or via `pnpm --filter @ostomy/api <script>` from the repo root.

```bash
pnpm install            # from the repo root
cp .env.example .env    # then fill in real values for local development

pnpm --filter @ostomy/api typecheck
pnpm --filter @ostomy/api test              # unit + integration
pnpm --filter @ostomy/api test:unit         # no Docker required
pnpm --filter @ostomy/api test:integration  # Testcontainers — needs a running Docker daemon
pnpm --filter @ostomy/api build
pnpm --filter @ostomy/api start:dev   # runs src/main.ts directly via tsx
pnpm --filter @ostomy/api start       # runs the build output in dist/

pnpm --filter @ostomy/api openapi:generate     # writes openapi.json (no server, no database)
pnpm --filter @ostomy/api api-client:generate  # the above, then regenerates packages/core/src/api-client
```

**The integration suite skips itself, loudly, when Docker is unreachable** — it does not fail. That is
deliberate (a laptop without Docker can still run `pnpm verify`), but it means a green `pnpm verify` on
a machine with no Docker daemon has proven considerably less than it appears to: ownership
authorization, audit coverage and the no-PHI-in-logs checks all live in that suite. Read the skip
notice, not just the exit code.

`start:dev` and `start` load environment variables using Node's native `--env-file`, not `dotenv` — no
`dotenv` dependency exists in this workspace, and none should be added. `start:dev` uses
`--env-file=.env`, which fails loudly if `.env` doesn't exist (matching the `cp .env.example .env`
step above). `start` uses `--env-file-if-exists=.env` instead, so a container deploy that injects real
environment variables directly (no `.env` file present) isn't broken by that stricter behaviour. Either
way, `loadConfig` (`src/config/load-config.ts`) still fails fast with a clear, field-naming message if
a required variable is missing or malformed once the process starts.

In non-production (`NODE_ENV` unset or not `production`), Swagger UI is served at `/api-docs` and the
generated OpenAPI document is written to `openapi.json` in the working directory (`process.cwd()`) —
under `start:dev` that's this directory; under `start` (running `dist/main.js`) it's wherever the
process was launched from. That write is best-effort: it's wrapped so a read-only container filesystem
never stops the server from starting. Nothing depends on that boot-time write any more: P2.S1a moved
emission to `openapi:generate` (`src/openapi/emit-openapi.ts`), which boots the module graph without
listening on a port or reaching a database, and `api-client:generate` drives the typed-client generator
from that file. Both the served document and the generated one come from the same
`buildOpenApiDocument()` (`src/openapi/build-openapi-document.ts`), so Swagger UI and the client cannot
drift apart.

## Structure

```
src/
  main.ts                    — bootstrap: config validation, Nest app, global prefix, Swagger, listen,
                                 the boot-time privilege self-check (ADR-0011)
  app.module.ts               — dynamic module; takes the validated AppConfig as a value
  config/                     — env schema (zod), loader, DI token, fatal validation error
  logging/                    — Pino wiring: serializers (req/res/err), redaction lists, request id
  health/                     — GET /api/v1/health (liveness only)
  auth/                       — patient OIDC: JwtAuthGuard, its module, actor accessor, and a stub route
  admin/                      — admin OIDC: AdminJwtAuthGuard, its module, actor accessor, and a stub route
  prisma/                     — PrismaService (runtime-role connection), PrismaModule
  audit/                      — AuditContext, AuditService, AuditInterceptor (global), the @Audited()
                                 decorator, and audit-stub test scaffolding — see below
  thresholds/                 — ThresholdsService: validation_thresholds/value_sets as injected data
  observations/               — POST/GET /api/v1/observations (stoma output): wire mapping, validation
                                 pipes, rejection shaping, persistence — see below
  http/                       — ErrorSanitizerFilter (global, APP_FILTER): no framework-authored
                                 error message reaches a client or a log line — see below
  openapi/                    — document builder (shared by boot and the emitter), file writer, and the
                                 standalone `openapi:generate` entry point
  test-support/               — test-only fixtures (mocked JWKS, fake ExecutionContext)
  route-guard-coverage.spec.ts — architectural test: every route is guarded/public AND every mutating
                                 route is @Audited()
```

`auth/` and `admin/` are structurally separate on purpose: `AdminJwtAuthGuard` shares no code with
`JwtAuthGuard`, is bound to a different issuer/audience, and every controller under `admin/` applies
it at the controller level rather than relying on a global guard. See the comments at the top of each
guard file and `design-specs/decisions/0008-admin-config-api-before-console.md`.

Each side also has its own request-actor accessor (`auth/patient-actor.ts`, `admin/admin-actor.ts`) —
`getPatientActor(request)` / `getAdminActor(request)` — which is the one place application code should
read "who made this request". They throw rather than returning `undefined`, since a caller reaching
one with no actor attached means the route isn't behind its guard, which for a PHI-touching route
should fail loudly rather than let a null actor reach an audit row.

**"No global guard" is a convention scoped to guards, not to every enhancer.** There is deliberately no
`APP_GUARD` here — see `route-guard-coverage.spec.ts` for why, and how that test enforces the
convention structurally instead. This does **not** extend to `AuditInterceptor`: that one *is*
registered globally (`APP_INTERCEPTOR`, via `audit/audit-interceptor.module.ts`), because
per-controller opt-in is exactly how a sync-applied write ends up unaudited. Guards stay
per-controller; the audit interceptor does not.

## Observations (`observations/`)

The first PHI endpoints (P2.S1a), stoma output only:

| Route | Notes |
| ----- | ----- |
| `POST /api/v1/observations` | `@Audited()`; writes the row and its audit row in one transaction |
| `GET /api/v1/observations` | the patient's own rows, newest clinical moment first; date range + limit |
| `GET /api/v1/observations/:id` | 404 for another patient's row — never 403, which would confirm it exists |

Files, in the order a request touches them:

- `observation-body.pipe.ts` / `observation-query.pipe.ts` — parse and validate before a handler sees
  anything. The body pipe is where "the payload is untrusted input" is enforced, including on the sync
  path later. **Both refuse an unrecognized key rather than ignoring it** (§6.2
  `PAYLOAD_FIELD_UNRECOGNIZED`), reporting `field: "payload"` and never the key itself, which is
  client-supplied content. The query pipe silently dropped unknown parameters until P2.S1a's review: a
  typo'd `effectiveDateFrom` returned `200` with the full unfiltered list, so the patient saw entries
  outside the window they asked for with no way to tell. An inverted date range is refused for the
  same reason — it otherwise renders as "you have no entries.
- `observation-payload.ts` — the zod schemas. FHIR field names (`valueQuantity.value`,
  `effectiveDateTime`) are the accepted spelling and a non-FHIR spelling of the same data is **refused**
  rather than accepted alongside it, so the wire format cannot quietly fork.
- `observation-wire.ts` — mapping between the wire resource and the database row, in both directions.
- `estimation-method.ts` — the Measured/Estimated toggle. While `ESTIMATION_METHOD_CODE` is
  `{ resolved: false }` pending D4, any non-null `method` is refused rather than written with a guessed
  SNOMED code.
- `observations.service.ts` — ownership scoping, the `$transaction`, and the `packages/core` validation
  re-run. Thresholds come from `ThresholdsService`, never from a constant here.
- `observation-rejection.ts` — turns a Tier 1 failure into a correctable result. It never echoes the
  offending clinical value back (sync-contract §6.3), which is also what keeps rejections out of logs.
- `observation-persistence.error.ts` — the same wrapping `AuditService` does, for the same reason: a raw
  `PrismaClientValidationError`'s `.message` renders the offending `data`, i.e. the clinical value.
  Also `isUniqueConstraintViolationOn(error, model)`, which is scoped to a **model** on purpose: the
  write transaction contains two inserts, so an unqualified `P2002` test reports an *audit* constraint
  violation as a `409` on the observation id — and an offline queue reads a `409` as permanent and
  stops retrying, losing the patient's entry silently. An `AuditPersistenceError` is rethrown unchanged
  rather than re-wrapped, so an audit-write failure stays distinguishable in the incident log.

Three rules that are easy to undo by accident:

- **A value the canonical column cannot hold is a Tier 1 rejection, not a database error.**
  `packages/core`'s `representableRange.ts` blocks a magnitude at or beyond `10^8` and anything with
  more than 4 decimal places, because `observations.value_quantity_value` is `DECIMAL(12,4)`. Both used
  to reach Postgres and fail there — as `numeric field overflow` and as a positivity-CHECK violation
  after rounding to `0.0000` — and neither is a Prisma `P2002`, so both surfaced as HTTP 500. §9 tells
  a client to treat a 5xx as an unknown outcome and **re-push**, so a mistyped volume retried forever
  and never reached the correction inbox. Do not "simplify" these into a database constraint.
- **Tier 2 warns and SAVES.** A value above the soft threshold returns `201` with a warning attached. If
  a change ever makes a warning able to block, the 2,000 mL rule stops being the thing the care team
  most needs to see.
- **`entered_measurement_system` is the CLIENT's asserted value**, not the server's current profile
  (`docs/sync-contract.md` §7.2, and ADR-0012 as amended at P2.S1a). The server validates only that it
  is `metric` or `imperial`. This column records which system the patient actually entered in, and for
  a queued offline write only the device knows that — re-deriving it server-side attributes every
  queued row to a system the patient may have switched away from since, and refusing on a mismatch
  rejects on a field no entry form contains and the patient cannot edit.

## Error responses (`http/`)

`ErrorSanitizerFilter` is registered globally via `APP_FILTER` (`http/error-sanitizer.module.ts`) and
guarantees one property: **no framework- or library-authored error message reaches a client or a log
line.**

It exists because `apps/api` previously had no exception filter at all, so anything thrown outside a
handler got Nest's defaults. The one that mattered: `express.json()` throws a `SyntaxError` on a
malformed body, the Express adapter maps it to `new BadRequestException(error.message)`, and that
message is V8's `JSON.parse` text — which quotes a window of the raw input. For a payload the size of
an observation that is effectively the whole body, so a request corrupted in transit came back with the
patient's own clinical value in the 400, which the mobile client then persists in its correction queue
(`docs/sync-contract.md` §6.3 forbids exactly that). A bad percent-escape in the path reached the same
mapping; an oversized body missed it and surfaced as a logged 500.

Two things a future author needs to know:

- **It must be global, and `@UseFilters` on a controller is not enough.** `express.json()` runs as
  middleware, *before routing*, so a controller-scoped filter is never reached — the request never got
  as far as being that controller's. The first version of this was controller-scoped and the
  integration test caught it. It is registered from a module rather than `main.ts` for the same reason
  `AuditInterceptor` is: anything wired only in `main.ts` is absent from every testing-module graph.
- **An authored error body must never carry a `message` key.** The filter forwards a body only when it
  lacks `statusCode` and `message` — the two keys that mark Nest's own envelope. Both existing authored
  shapes pass (`{ code }` from the auth guards, `{ error: { code, errors } }` from observations).
  Anything else is replaced with a neutral `{ error: { code } }` drawn from a closed set.

A 500 is still logged, but only by the error's `name` — unless the error type sets `phiSafeMessage`,
which `ObservationPersistenceError` and `AuditPersistenceError` both do because their messages are
assembled from identifiers and the original error's `name`/`code`, never its `message`.

## Audit coverage (`audit/`)

`AuditInterceptor` is global and inspects every route, but only acts on ones a handler author marks
`@Audited()` (`audit/audited.decorator.ts`). A handler behind that decorator must call
`stageAuditEntry()` (`audit/audit-recorder.ts`) — once per entity it wrote — before returning; the
interceptor persists whatever was staged via `AuditService.record()`, the single write path to
`audit_events`, and **throws** (failing the request as a 500) if an `@Audited()` route completes having
staged nothing — unless the route opts out with `@Audited({ allowEmpty: true })` for a batch endpoint
where "staged nothing" is a legitimate outcome (e.g. sync push, P2.S1b, when every operation in a batch
is rejected — see `AuditedOptions.allowEmpty`'s doc comment). `route-guard-coverage.spec.ts` closes the
other half: it fails the build if any mutating (POST/PUT/PATCH/DELETE/ALL) route carries no
`@Audited()` at all.

**What a P2 author must do to stay audited:** decorate the mutating route handler with `@Audited()`,
and call `stageAuditEntry(request, { actorType, actorId, action, entityType, entityId, beforeValue,
afterValue, reasonCode })` before the handler returns. If the handler owns a transaction, call
`stageCommittedAuditEntry(request, entry, auditEventId)` instead — **never both** — passing the id
`AuditService.record()` returned. That third argument is required and is the proof: there is no way to
produce one without having written the row, so a handler that forgets `record(ctx, tx)` cannot satisfy
the coverage check by asserting it did. If you forget `@Audited()` itself,
`route-guard-coverage.spec.ts` fails the build. If the decorator is present but nothing was staged, the
interceptor throws — but **the PHI write has already committed by that point**: the interceptor runs
after the handler's observable emits, so a 500 here means the write succeeded and its audit row did
not, not that nothing happened. The interceptor also persists whatever WAS staged before a handler
throws (a `catchError` branch, added after this sprint's own review found staged entries were silently
lost on that path — see `AuditInterceptor`'s doc comment), so a handler that stages entries and then
fails partway through still gets those entries audited even though the response itself fails.

**What this does NOT prove, and this file previously overstated:** the "staged nothing → 500" trip-wire
is a per-ROUTE check, not a per-ENTITY one. A batch handler that applies twenty writes but stages only
one entry satisfies it while nineteen writes go unaudited — the most likely real failure mode for sync
push, and neither trip-wire here touches it. Per-entity coverage is the handler author's responsibility;
closing this fully needs a database-level guarantee neither sprint builds. `AuditService.record()`'s
optional `tx: Prisma.TransactionClient` is the mechanism to use in the meantime, and P2.S1a is its first
real caller: `ObservationsService.create()` opens a `$transaction`, writes the observation, calls
`record(context, tx)` inside it, then stages the entry with `stageCommittedAuditEntry()`
(`audit/audit-recorder.ts`) so the interceptor counts it toward the coverage trip-wire without writing a
duplicate row into an append-only table that has no DELETE grant to fix one. Follow that shape rather
than re-deriving it — especially at P2.S1b, where one route applies many operations. The interceptor
itself still never uses `tx`, since it runs outside the handler's transaction by construction.

A write with no HTTP request of its own — a sync-applied write, or the losing side of a last-write-wins
conflict (ADR-0001) — never goes through the interceptor at all; it calls `AuditService.record()`
directly, supplying its own `correlationId` (the pushing request's id) so an auditor can still
reconstruct which resolution belonged to which push. That id now lands in the indexed
`audit_events.correlation_id` **column**. P1.S5 could not touch `prisma/` and nested it inside whichever
of `beforeValue`/`afterValue` was populated; migration `20260906203344_add_audit_correlation_id` added
the column, and P2.S1a — the first sprint writing real clinical rows — started writing to it before the
wrapped shape could become permanent in a table with no UPDATE grant to normalise it (ADR-0011).
`beforeValue`/`afterValue` again hold the entity's own fields and nothing else.

`AuditService.record()` never lets a raw Prisma error escape it — a failed `auditEvent.create()` (a
constraint violation, a bad JSON shape) is wrapped into a purpose-built `AuditPersistenceError` carrying
only `entityType`/`entityId`/`action`/`actorType` and the original error's `name`/`code`, never the
original error object or its `message`. This matters because `AuditService.record()` is the first and
only code in this repo that hands clinical before/after values to Prisma as a `create()` argument, and a
`PrismaClientValidationError`'s own `.message` renders the offending `data` — i.e. the clinical value
itself — verbatim; `logging/serializers.ts`'s `errSerializer` allow-lists `message` through by design, so
an unwrapped Prisma error here would have put PHI into application logs the moment this write ever
failed.

`audit/test-support/audit-stub.controller.ts` is scaffolding only — a synthetic in-memory entity with
no clinical meaning, used to give the interceptor and its tests something to exercise ahead of P2.S1a's
first genuine PHI endpoint.

P1.S5 left the instruction "remove it in the same change that endpoint lands." **P2.S1a deliberately did
not**, and the reasoning belongs here rather than in a commit message nobody re-reads. The stub is what
makes `audit.integration.spec.ts`'s AC1 falsifiable: that suite boots the SAME write twice, once with
`AuditInterceptorModule` in the graph and once without, and proves the second produces zero audit rows.
Demonstrating "removing the interceptor loses audit rows" needs a module graph you can legitimately
build without it — which the real `ObservationsModule` is not, since it records inside its own
transaction and would keep auditing with the interceptor gone. Deleting the stub would not have moved
that proof onto the real endpoint; it would have deleted the proof.

What P2.S1a's own `observations.integration.spec.ts` adds is the per-entity coverage the stub never
could: audit row count equals write count across mixed accepted and rejected writes, no audit row
survives a refused write, and none survives a failure at COMMIT after both inserts succeeded. The stub
covers "is the interceptor wired at all"; the observations suite covers "does every real PHI write get
exactly one row." Retiring the stub is a live question for whoever owns the next audit-touching sprint,
but it costs a P1.S5 acceptance test and should be a decision, not a tidy-up. `AppModule.register()` only imports `AuditStubModule` when
`config.nodeEnv !== 'production'` — `app.module.spec.ts` asserts a `production`-config graph exposes no
`audit-stub` route.

## What is deliberately not here yet

No observation endpoints, no sync endpoints, no admin config API, no CORS configuration (`apps/web` is
a separate origin — configuring this needs that origin to exist). Those land at P2 (the stoma-output
vertical slice and the web app) and P3.S3 (admin config) respectively.
