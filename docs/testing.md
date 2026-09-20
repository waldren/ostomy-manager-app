# Testing

Test strategy and how to run and write tests for each app and package.

The framework choices below are settled in [ADR-0002](../design-specs/decisions/0002-testing-strategy.md). This document is the operational half: conventions every builder agent follows.

## Runners

| Workspace                | Runner                                                    | Why                                                                                                                                                               |
| ------------------------ | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`          | Vitest                                                    |                                                                                                                                                                   |
| `packages/ui`            | Vitest                                                    |                                                                                                                                                                   |
| `packages/seed`          | Vitest                                                    |                                                                                                                                                                   |
| `apps/api` — unit        | Vitest                                                    |                                                                                                                                                                   |
| `apps/api` — integration | Vitest + Supertest + **real PostgreSQL** (Testcontainers) | A mocked Prisma client cannot exercise database grants, constraint violations, or transactional audit coupling — which is most of what these tests exist to prove |
| `apps/web`               | Vitest                                                    |                                                                                                                                                                   |
| `apps/admin`             | Vitest                                                    |                                                                                                                                                                   |
| `apps/mobile`            | **jest-expo**                                             | Forced, not chosen. Vitest does not carry the React Native preset cleanly                                                                                         |
| `apps/web` — e2e         | Playwright                                                |                                                                                                                                                                   |
| `apps/mobile` — e2e      | _Deferred to Gate C_                                      | The sync path is the only thing worth e2e testing on mobile, and it does not stabilize until then                                                                 |

Two runners in one monorepo is a known cost. Root `pnpm test` fans out to both.

## Commands

Recorded in `docs/getting-started.md` once P0 lands. The root contract is:

```
pnpm test            # everything
pnpm test:unit       # excludes Testcontainers-backed integration
pnpm --filter <ws> test
```

Integration tests require a Docker daemon. They are skipped with a clear message, not silently, when one is unavailable.

## Acceptance-criteria traceability

`SRS_v2.md` §7 carries acceptance criteria by ID for Epics 2, 12–14, 17 and 18. Those IDs are the **only** formal link between the spec and the code.

**Any test covering a spec acceptance criterion names it in its `describe` block:**

```ts
describe('AC 13.1 AC3 — server-side re-enforcement on synced operations', () => {
  it('rejects a queued operation that violates a tier 1 rule', async () => {
    /* … */
  });
});
```

Format is exactly `AC <story>.<n> AC<n> — <short restatement>`. This makes coverage greppable:

```
rg "AC 13\.1 AC3" --type ts
```

`code-reviewer` checks that a PR claiming to cover an AC has a test naming it.

**Where no spec AC exists** — Epics 3–11, 15, 16, which §7 leaves as a backlog-refinement task — do not invent an AC ID. Describe the behavior plainly and state the exit criteria in the PR description instead.

## What must be tested

Beyond ordinary coverage of what changed, these are required and are not optional in any sprint that touches them:

- **Audit coverage is a required test, not an aspiration.** An integration test must prove that a PHI write with no corresponding `audit_events` row **fails**. There must be no code path and no database grant permitting `UPDATE` or `DELETE` on the audit table. This applies to direct writes, sync-applied writes, and the losing side of a conflict — the last two are the ones that get missed.
- **Validation is tested on both sides of the wire.** A rule defined in `packages/core` is tested there, and its server-side re-enforcement is tested again in `apps/api`, including on the sync path. A payload from an offline device is untrusted input.
- **A soft warning must be structurally incapable of blocking.** Test the return type distinction, not just the message.
- **Threshold injection.** Assert that validation reads thresholds as injected data. A test that hardcodes an expected bound is asserting the wrong thing — parameterize it.
- **Unit handling.** Canonical storage is mL and kg ([ADR-0004](../design-specs/decisions/0004-canonical-storage-units.md)); conversion is render-time and rounds to whole units for volume only, never weight ([ADR-0005](../design-specs/decisions/0005-decimal-volumetric-entry-and-conversion-rounding.md)). Both rules need tests, including the weight carve-out.
- **Offline behavior.** Local-first save confirms from the local write, never from a network response. Queued data survives app restart and OS background termination.

## What only a device can prove

Some of `apps/mobile`'s controls cannot be tested by any runner here: jest has no keychain, cannot simulate a biometric enrolment change, and has no OS backup transport, and an emulator has software KeyMint rather than secure hardware. That covers [ADR-0014](../design-specs/decisions/0014-local-phi-encryption-and-device-ownership.md)'s encrypted store and [ADR-0015](../design-specs/decisions/0015-biometric-local-access.md)'s enrolment invalidation and Class 3 requirement.

[`gate-b-hardware-verification.md`](gate-b-hardware-verification.md) holds those as HW-1 to HW-10, with procedures and pass conditions, and records which have been run. Do not write an automated test that claims to cover one of them — a mocked keychain asserts only that the mock was called.

## Test data

**Synthetic only, always.** Same rule as every other environment: no real or realistic-looking patient data in any fixture, ever.

- Prefer generating fixtures with `packages/seed` ([ADR-0009](../design-specs/decisions/0009-synthetic-seed-data-generation.md)) so test data and dev data obey the same validation rules.
- Names, dates of birth, and identifiers are generated, never sampled from a real dataset.
- CI must have no route to a database holding PHI.

**One trap worth naming.** `packages/seed` writes through Prisma directly, so **seeded rows carry no audit events**. Any test asserting audit coverage must create its data through the API, not the seeder. Forgetting this produces a confusing failure.

## Never log PHI, including in tests

Test output, snapshots, and failure messages are logs. Assert on field identifiers and rule codes, not on clinical values, wherever the assertion works either way. Snapshot files must not accumulate clinical values.

## Coverage

No global percentage gate. Two rules instead, both checked by `code-reviewer`:

1. Validation rules in `packages/core` are covered at full branch coverage — every rule, both tiers, both outcomes.
2. Every acceptance criterion a PR claims has a test naming it.

A percentage target on the rest would measure the wrong thing in a repo where the risk is concentrated in sync, validation, and audit.
