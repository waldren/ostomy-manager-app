# API / Backend

Backend service: authentication, data sync, FHIR-mapped storage, and RxNorm medication lookups.

NestJS, TypeScript, REST (`/api/v1/...`). Scaffolded at P1.S1: typed/validated configuration, the
patient (`JwtAuthGuard`) and admin (`AdminJwtAuthGuard`) OIDC guards, a liveness health check, OpenAPI
generation, and a PHI-scrubbing Pino logger. No database, no Prisma, and no business-logic endpoints
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

`start`/`start:dev` fail fast with a clear message if a required environment variable in
`.env.example` is missing or malformed — see `src/config/load-config.ts`.

In non-production (`NODE_ENV` unset or not `production`), Swagger UI is served at `/api-docs` and the
generated OpenAPI document is written to `dist/openapi.json` (or `openapi.json` in the working
directory under `start:dev`) — see "OpenAPI generation" below.

## Structure

```
src/
  main.ts                    — bootstrap: config validation, Nest app, global prefix, Swagger, listen
  app.module.ts               — dynamic module; takes the validated AppConfig as a value
  config/                     — env schema (zod), loader, DI token, fatal validation error
  logging/                    — Pino wiring: PHI-scrubbing serializers, redaction list
  health/                     — GET /api/v1/health (liveness only)
  auth/                       — patient OIDC: JwtAuthGuard, its module, and a stub route
  admin/                      — admin OIDC: AdminJwtAuthGuard, its module, and a stub route
  openapi/                    — OpenAPI document file writer
  test-support/               — test-only fixtures (mocked JWKS, fake ExecutionContext)
```

`auth/` and `admin/` are structurally separate on purpose: `AdminJwtAuthGuard` shares no code with
`JwtAuthGuard`, is bound to a different issuer/audience, and every controller under `admin/` applies
it at the controller level rather than relying on a global guard. See the comments at the top of each
guard file and `design-specs/decisions/0008-admin-config-api-before-console.md`.

## What is deliberately not here yet

No Prisma, no database, no audit logging, no threshold/value-set config, no observation endpoints.
Those are P1.S3 (schema), P1.S5 (audit interceptor + thresholds service), and P2 (the stoma-output
vertical slice) respectively.
