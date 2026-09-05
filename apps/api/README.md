# API / Backend

Backend service: authentication, data sync, FHIR-mapped storage, and RxNorm medication lookups.

NestJS, TypeScript, REST (`/api/v1/...`). Scaffolded at P1.S1: typed/validated configuration, the
patient (`JwtAuthGuard`) and admin (`AdminJwtAuthGuard`) OIDC guards, a liveness health check, OpenAPI
generation, and a structured Pino logger. No database, no Prisma, and no business-logic endpoints
yet — those land at P1.S3 onward per `design-specs/planning/v1-implementation-plan.md`.

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
  main.ts                    — bootstrap: config validation, Nest app, global prefix, Swagger, listen
  app.module.ts               — dynamic module; takes the validated AppConfig as a value
  config/                     — env schema (zod), loader, DI token, fatal validation error
  logging/                    — Pino wiring: serializers (req/res/err), redaction lists, request id
  health/                     — GET /api/v1/health (liveness only)
  auth/                       — patient OIDC: JwtAuthGuard, its module, actor accessor, and a stub route
  admin/                      — admin OIDC: AdminJwtAuthGuard, its module, actor accessor, and a stub route
  openapi/                    — OpenAPI document file writer
  test-support/               — test-only fixtures (mocked JWKS, fake ExecutionContext)
  route-guard-coverage.spec.ts — architectural test: every route is guarded or explicitly public
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
convention structurally instead. This does **not** extend to the P1.S5 audit interceptor: that one
*must* be registered globally (`APP_INTERCEPTOR`) to be structural, because per-controller opt-in is
exactly how a sync-applied write ends up unaudited. Guards stay per-controller; the audit interceptor
will not.

## What is deliberately not here yet

No Prisma, no database, no audit logging, no threshold/value-set config, no observation endpoints, no
CORS configuration (`apps/web` is a separate origin — configuring this needs that origin to exist).
Those land at P1.S3 (schema), P1.S5 (audit interceptor + thresholds service), and P2 (the stoma-output
vertical slice and the web app) respectively.
