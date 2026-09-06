# packages/core

Shared validation, unit conversion, Daily Net Fluid Balance classification, and the i18n catalog — the shared kernel consumed by `apps/api` and both patient clients (SRS §3.8; [ADR-0007](../../design-specs/decisions/0007-packages-core-ownership.md)).

This package is authored per-path, not as a whole. See ADR-0007 for the full ownership table. This sprint (P1.S4) covers exactly:

| Path                            | Contents                                                                                 |
| -------------------------------- | ----------------------------------------------------------------------------------------- |
| `src/units`                      | Canonical mL/kg types and conversion. Mixed-system values are unrepresentable in the type ([ADR-0004](../../design-specs/decisions/0004-canonical-storage-units.md)). Conversion rounding, including the weight carve-out ([ADR-0005](../../design-specs/decisions/0005-decimal-volumetric-entry-and-conversion-rounding.md)). Daily totals computed from canonical values and rounded once. |
| `src/validation`                 | The two-tier validation engine for volumetric entries. Thresholds are injected, never hardcoded. A Tier 2 (soft) result cannot express a blocking outcome — enforced by its type, not a severity field. `ESTIMATION_METHOD_CODE` (D4, unresolved — do not invent a code). |
| `src/hydration`                  | The Daily Net Fluid Balance LOINC-code classification (SRS §3.7): stoma output and fluid intake count; voided urine, weight, and heart rate are named exclusions. Nothing beyond what P2 needs — the composite hydration status is P6/P7, not here. |
| `src/i18n`                       | The shared English catalog ([ADR-0006](../../design-specs/decisions/0006-i18n-library-and-shared-catalog.md)): `validationErrors`, `validationWarnings`, `redFlags`, and `common` as separate namespaces, plus `Intl`-based date/time/number/unit formatters. |

`src/fhir` (owned by `fhir-data-modeler`), `src/sync` (owned by `nestjs-api-developer`), and `src/api-client` (generated from OpenAPI) do not exist yet and are out of this sprint's scope — see ADR-0007's conflict procedure before adding to them.

## Module system (ADR-0010)

This package is ESM (`"type": "module"`), and its built `dist/` output is the **first ESM package the CommonJS `apps/api` imports**, via Node's `require(esm)`. That capability throws `ERR_REQUIRE_ASYNC_MODULE` if the required module's entry graph contains top-level await — so nothing under `src/` may use it, directly or transitively. Vitest transforms everything to ESM and cannot see this; only running the built output proves it.

Root `pnpm verify` includes `verify:core-require`, which builds this package and has `apps/api`'s own CommonJS runtime `require()` its four subpath exports — see `apps/api/scripts/require-core-smoke.cjs`.

## Subpath exports only — no root barrel

There is no `"."` export. Each owned area (`./units`, `./validation`, `./hydration`, `./i18n`) is an independent entry point; future owners add their own (`./fhir`, `./sync`) without needing to touch a shared barrel. This is deliberate: `packages/config/eslint/index.js`'s admin-boundary rule already treats an all-encompassing `@ostomy/core` specifier as the thing to guard against, since a root barrel would launder every patient-scoped type through one import the zero-PHI admin console could otherwise reach for.

## Commands

```
pnpm --filter @ostomy/core build           # emit dist/ (real Node ESM)
pnpm --filter @ostomy/core typecheck
pnpm --filter @ostomy/core test
pnpm --filter @ostomy/core test:coverage   # full branch coverage on src/validation
```
