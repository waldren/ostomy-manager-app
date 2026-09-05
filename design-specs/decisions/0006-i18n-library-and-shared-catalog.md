# ADR-0006: Use i18next with one shared English catalog in `packages/core`, and Intl for all formatting

- **Status:** Accepted
- **Date:** 2026-09-05
- **Deciders:** Steven Waldren (accepted from implementation-planning recommendation)
- **Related:** SRS_v2 §5.4, §3.8, §3.13 · [ADR-0007](0007-packages-core-ownership.md)

## Context

SRS_v2 §5.4 requires that no user-facing string is hardcoded and that date, time, number and unit formatting is locale-aware from day one, even though v1 ships English-only. That makes this a decision that must land **before the first screen**, not before the first translation — retrofitting string externalisation across a built UI is one of the most expensive and least rewarding tasks available.

Two constraints narrow the choice. The same copy must render on React Native and on web, so the library has to work unchanged across both. And §5.4 sets a 6th–8th grade reading level for patient-facing copy, while §3.8 and §3.13 impose a _tonal_ requirement that is genuinely safety-relevant: a Tier 2 validation warning must never scold, and the heart-rate red-flag prompt must be unmistakably distinct in voice from any data-quality warning, because conflating them trains patients to dismiss an urgent message.

That tonal requirement is what makes catalog _location_ a real decision rather than a filing preference. `accessibility-copy-reviewer` can only enforce a consistent voice if it can read all the copy in one place.

Surfaced by implementation planning.

## Decision

We will use **`i18next` with `react-i18next`** on both clients, and **`Intl`-based date, time, number and unit formatters defined in `packages/core`**.

All user-facing copy lives in **one shared English catalog at `packages/core/i18n/`**, consumed by `apps/mobile`, `apps/web`, and `apps/admin`. There are no per-app catalogs.

A `no-literal-string` ESLint rule scoped to UI directories lands at P0.S1 — before the first screen exists — and fails CI.

## Consequences

**What this gets us.** One place to audit reading level, tone, and the warning-versus-red-flag voice distinction, which is exactly what `accessibility-copy-reviewer` needs and cannot do across scattered files. One place where a clinical term is defined, so the patient-friendly wording of a medication or a skin-condition severity cannot drift between phone and web. Locale-aware formatting from the first render means adding a second locale later is a translation task, not a refactor.

**What this costs.** `packages/core` gains a dependency that is only meaningful to UI consumers, which slightly blurs its role as the shared logic package. Every copy change becomes a cross-cutting change touching a package three apps depend on, so a one-word wording fix rebuilds more than it would with per-app catalogs. Under [ADR-0007](0007-packages-core-ownership.md) the catalog has a single owning agent, so a builder working on mobile who needs new copy must stop and hand off rather than adding a key inline — a real round-trip cost, accepted because divergent safety copy is the worse outcome.

**What it forecloses.** Per-app catalogs become expensive to split back out once keys are shared and reused. Swapping i18next for another library later touches every component on both clients. Neither is likely to be wanted.

## Alternatives considered

| Alternative                                 | Why not                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-app catalogs                            | The option that will be re-proposed the first time a copy change feels heavier than it should. It permits the same Tier 2 warning to be phrased two ways on two clients — precisely the failure `accessibility-copy-reviewer` exists to catch, and one that becomes a safety issue where the red-flag voice is concerned. |
| `react-intl` / FormatJS                     | Strong on web, weaker and less used under React Native; the message-descriptor model also fits less naturally with a single shared catalog consumed by three apps.                                                                                                                                                        |
| Defer i18n until a second locale is planned | Directly contradicts §5.4, and is the expensive path: externalising strings after the UI is built means touching every component.                                                                                                                                                                                         |
| Hand-rolled string map                      | Cheap to start, then reimplements pluralisation, interpolation and locale fallback badly.                                                                                                                                                                                                                                 |

## Spec impact

**No spec change.** §5.4 states the requirement; this decides how it is met.

## Compliance and safety review

Touches patient-facing safety copy directly. Two requirements carry into implementation:

- The **red-flag prompt (§3.13, AC 18.3 AC 3)** and **Tier 2 validation warnings (§3.8)** must be distinguishable in the catalog's own structure — separate namespaces, not adjacent keys — so that the distinction is legible to a reviewer reading the catalog alone, and so a red-flag string cannot be reused as a warning.
- Copy keys must never be constructed by interpolating a clinical value into a key name; values are interpolated into messages, never into identifiers, or the catalog leaks PHI shape into logs and bundle analysis.

`accessibility-copy-reviewer` reviews the catalog structure at P1.S4, before any screen consumes it.

## Notes

v1 ships English-only. The catalog is structured for a second locale but no second locale is planned, and none should be added to the plan without a clinical review of translated safety copy.
