# API / Backend

Backend service: authentication, data sync, FHIR-mapped storage, and RxNorm medication lookups.

NestJS, TypeScript, REST (`/api/v1/...`). Scaffolded at P1.S1: typed/validated configuration, the
patient (`JwtAuthGuard`) and admin (`AdminJwtAuthGuard`) OIDC guards, a liveness health check, OpenAPI
generation, and a structured Pino logger. P1.S3 added the FHIR-shaped Postgres schema and
`PrismaService`. P1.S5 added the audit interceptor and `ThresholdsService` — see "Structure" below.
No business-logic (PHI) endpoints yet — those land at P2.S1a per
`design-specs/planning/v1-implementation-plan.md`.

## Commands

Run from this directory, or via `pnpm --filter @ostomy/api <script>` from the repo root.

```bash
pnpm install            # from the repo root
cp .env.example .env    # then fill in real values for local development

pnpm --filter @ostomy/api typecheck
pnpm --filter @ostomy/api test
pnpm --filter @ostomy/api build
pnpm --filter @ostomy/api start:dev   # runs src/main.ts directly via tsx
pnpm --filter @ostomy/api start       # runs the build output in dist/
```

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
never stops the server from starting, and the typed client generator (P2.S1a) that consumes this file
is expected to move to a dedicated `openapi:generate` script rather than depend on this boot-time
write.

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
  openapi/                    — OpenAPI document file writer
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

## Audit coverage (`audit/`)

`AuditInterceptor` is global and inspects every route, but only acts on ones a handler author marks
`@Audited()` (`audit/audited.decorator.ts`). A handler behind that decorator must call
`stageAuditEntry()` (`audit/audit-recorder.ts`) — once per entity it wrote — before returning; the
interceptor persists whatever was staged via `AuditService.record()`, the single write path to
`audit_events`, and **throws** (failing the request as a 500) if an `@Audited()` route completes having
staged nothing. `route-guard-coverage.spec.ts` closes the other half: it fails the build if any
mutating (POST/PUT/PATCH/DELETE) route carries no `@Audited()` at all.

**What a P2 author must do to stay audited:** decorate the mutating route handler with `@Audited()`,
and call `stageAuditEntry(request, { actorType, actorId, action, entityType, entityId, beforeValue,
afterValue, reasonCode })` before the handler returns. **If you forget either half**, the route fails
loudly — `route-guard-coverage.spec.ts` if `@Audited()` itself is missing, or a 500 at request time if
the decorator is present but nothing was staged — rather than shipping an unaudited PHI write.

A write with no HTTP request of its own — a sync-applied write, or the losing side of a last-write-wins
conflict (ADR-0001) — never goes through the interceptor at all; it calls `AuditService.record()`
directly, supplying its own `correlationId` (the pushing request's id) so an auditor can still
reconstruct which resolution belonged to which push. See `audit/audit-context.ts`'s doc comment for the
current, explicitly-flagged limitation this implies: `audit_events` has no dedicated correlation-id
column, so it is nested inside whichever of `beforeValue`/`afterValue` is populated rather than getting
one of its own.

`audit/test-support/audit-stub.controller.ts` is scaffolding only — a synthetic in-memory entity with
no clinical meaning, used solely to give the interceptor and its tests something real to exercise ahead
of P2.S1a's first genuine PHI endpoint. Remove it in the same change that endpoint lands.

## What is deliberately not here yet

No observation endpoints, no sync endpoints, no admin config API, no CORS configuration (`apps/web` is
a separate origin — configuring this needs that origin to exist). Those land at P2 (the stoma-output
vertical slice and the web app) and P3.S3 (admin config) respectively.
