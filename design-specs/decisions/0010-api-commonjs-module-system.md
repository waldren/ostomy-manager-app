# ADR-0010: Build `apps/api` as CommonJS with `nodenext` resolution, against an ESM monorepo

- **Status:** Accepted
- **Date:** 2026-09-05
- **Deciders:** Steven Waldren (accepted from P1.S1 implementation and review)
- **Related:** SRS_v2 §4.1, §4.3 · [ADR-0002](0002-testing-strategy.md) · [ADR-0003](0003-monorepo-task-tooling.md) · [ADR-0007](0007-packages-core-ownership.md)

## Context

The monorepo root sets `"type": "module"`, and `packages/config/tsconfig.base.json` sets `verbatimModuleSyntax: true` — both sensible defaults for a repo whose other workspaces are Vite and Expo, which are ESM-native and bundler-resolved.

NestJS does not fit that shape without work. Its dependency injection is decorator-driven, and `verbatimModuleSyntax` is incompatible with the CommonJS emit Nest's tooling assumes: with `type: commonjs` and CJS output, TypeScript rejects `export` on value declarations under that flag. Something had to give at P1.S1, before there was any application code to migrate.

This surfaced during implementation rather than planning, and the implementing agent correctly stopped and escalated it rather than deciding silently. A first attempt at `moduleResolution: "node10"` shipped, and review caught that it was the genuinely dangerous half of the divergence.

## Decision

`apps/api` is a **CommonJS workspace inside an ESM monorepo**:

- `apps/api/package.json` sets `"type": "commonjs"`, overriding the root. Node resolves the nearest `package.json`, so the override is scoped to this workspace.
- `apps/api/tsconfig.json` sets `"module": "nodenext"`, `"moduleResolution": "nodenext"`, and `"verbatimModuleSyntax": false`.
- Every other workspace keeps the ESM default.

`nodenext` rather than `node16`, and rather than the `node10` that was written first. Both alternatives fail, for opposite reasons — see below.

## Consequences

**What this gets us.** Nest's decorator DI works with no build-step gymnastics, no `unplugin-swc` required yet (every injection in P1.S1 uses explicit `@Inject()` tokens rather than `design:paramtypes` reflection), and standard Nest tooling behaves as documented. `nodenext` reads `exports` maps, so modern dependencies resolve correctly, and it surfaces real ESM/CJS interop diagnostics at typecheck rather than at runtime.

**What this costs.** Two module systems in one repo, and every future `apps/api` contributor has to know which one they are in. More sharply: **the API's CJS build depends on Node's `require(esm)`**, stable since Node 22.12 and available in the pinned Node 24. That is what lets a CommonJS API `require` an ESM dependency such as `jose` or `@nestjs/common` at all. It is a runtime capability, not a TypeScript one, and it has a hard limit.

**What it forecloses — and this is the one that will bite.** `require(esm)` throws `ERR_REQUIRE_ASYNC_MODULE` if the required module's entry graph contains **top-level await**. So:

> **`packages/core` must not use top-level await anywhere in its entry graph.** Neither must any ESM dependency the API imports.

The failure mode is deliberately nasty and worth stating plainly: **Vitest transforms everything to ESM, so the test suite never exercises the CJS require path.** A top-level await introduced into `packages/core` at P1.S4 would leave `pnpm verify` completely green and break the API only when the built artifact runs — first visible on the development host at P1.S2, or in a container at P9. The unit tests cannot catch it by construction.

Mitigation until something better exists: `apps/api`'s `build` script produces real CJS output, and any sprint touching `packages/core`'s entry graph should run the built API once, not just the tests.

## Alternatives considered

| Alternative | Why not |
|---|---|
| `moduleResolution: "node10"` (what P1.S1 shipped first) | Cannot read `exports` maps. It resolved only by accident: `jose` still ships a legacy top-level `main`. `packages/core` is ESM and, shipped in the normal exports-map-only shape, would fail typecheck — or resolve to the wrong entry point. Caught in review before `packages/core` existed to break it. |
| `moduleResolution: "node16"` | Reviewed and requested, then rejected on evidence: `@nestjs/common@12` ships `"type": "module"` with no CommonJS entry point, and `node16` **statically forbids** `require()` of an ESM package. Every `@nestjs/*` import fails typecheck with `TS1479`. `nodenext` tracks Node's actual `require(esm)` capability instead, which is what the runtime does. |
| Make `apps/api` ESM like the rest of the repo | The consistent option, and the one to re-propose when Nest's ESM story is boring. Today it means a build step and tooling divergence the P1.S1 sprint deliberately avoided, for no benefit while there is no application code. |
| Drop `verbatimModuleSyntax` repo-wide | Fixes the API by making every other workspace worse. The flag is right for the Vite and Expo clients. |
| Keep `"type": "module"` and emit ESM from Nest | Possible, but Nest's decorator metadata and CJS-assuming tooling make it a maintenance burden that would land on every API sprint rather than this one. |

## Spec impact

**No spec change.** SRS_v2 §4.1 specifies a pnpm-workspace monorepo with TypeScript throughout; §4.3 recommends NestJS. Neither states a module system. `CLAUDE.md` is updated, because "which module system am I in" is a rule a working session needs before writing an import.

## Compliance and safety review

No PHI, audit, boundary, validation, or patient-safety dimension. Noted only because `require(esm)`'s failure mode is silent under test: a build that cannot start is an availability problem, not a confidentiality one, and it would be caught by the P1.S2 health check on deploy.

## Notes

Re-check at **P1.S4**, when `packages/core` first ships and the API first imports it — that is the moment this decision either holds or produces `ERR_REQUIRE_ASYNC_MODULE`. Re-check again at Gate C alongside [ADR-0003](0003-monorepo-task-tooling.md).

If `packages/core` ever needs top-level await, this ADR must be superseded rather than worked around.
