# Web App

Patient-facing React + Vite SPA (SRS_v2 §4.2). **Online-only by explicit decision** — no local persistence layer, no service-worker data cache, no offline queue. Every read and write goes straight to `apps/api`; do not add offline support here (that asymmetry with `apps/mobile` is deliberate).

## What's here (P2.S3)

- **Auth:** OAuth 2.0 Authorization Code + PKCE against the standard OIDC issuer configured in `.env` (`src/auth/`) — no vendor SDK, no client secret (a public SPA cannot hold one). Tokens live in `sessionStorage` for the lifetime of the session only; no clinical data is ever persisted client-side. Three properties worth knowing before changing anything in `src/auth/`:
  - **The discovery document's `issuer` is validated** against the configured one (OIDC Discovery §4.3). That document decides where credentials get sent, so it is the one place the issuer's self-declared identity meets the identity the deployment intended.
  - **Sign-out ends the session at the issuer**, not just locally (RP-Initiated Logout §2). Without it, the next person at a shared clinic workstation is silently re-authenticated into the previous clinician's patient. Local tokens are cleared *before* the redirect, so a failure anywhere downstream still leaves this browser signed out.
  - **A 15-minute inactivity timeout** (`VITE_SESSION_IDLE_TIMEOUT_MINUTES`, `0` disables) ends the session on elapsed time rather than a timer, because background-tab throttling and laptop suspend are exactly the cases where a timer does not fire.
- **i18n:** `src/i18n` composes nothing of its own — it takes `resources` straight from the shared `@ostomy/core/i18n` catalog (ADR-0006: "There are no per-app catalogs"). This app's shell copy lives in that package as the `web` namespace, at `packages/core/src/i18n/locales/en/web.ts`; see its doc comment for what belongs in a per-app namespace and what must stay in `common`/`validationErrors`/`validationWarnings`/`redFlags`.
- **The physician view** (`src/pages/PhysicianOutputView.tsx`): a chronological chart + accessible table of the day's stoma output. This is **not** the patient dashboard — there is no composite status, and there will not be one even once other hydration signals exist server-side. Daily Net Fluid Balance is rendered as an explicit, explained empty state (`DailyBalanceNotice`) rather than a number, because it needs fluid intake data that does not exist yet (P3).
- **`packages/ui`** supplies the accessible primitives (`Button`, `TextField`, `ToggleGroup`, `Badge`, `InlineNotice`, ...); this app owns nothing web-agnostic that belongs there instead.

## Commands

```
pnpm --filter @ostomy/web dev         # http://localhost:5173
pnpm --filter @ostomy/web build
pnpm --filter @ostomy/web typecheck
pnpm --filter @ostomy/web test
```

Copy `.env.example` to `.env.local` before running `dev` — see that file for what each variable is for and its `mock-oauth2-server` default.

## Known gaps and deliberate simplifications (report, not silent scope-narrowing)

- **No persisted measurement-system preference.** Preference Management is a P4 feature. The unit toggle on the physician view is local view state for this session only; it never rewrites a stored value.
- **Mixed-entry-system daily totals.** When a day's entries were not all entered in the same measurement system, `formatObservationsForDisplay.ts` rounds the total to a whole unit rather than applying a fully specified mixed-system policy. The reasoning (no single same-system readback exists, so the total is a converted figure by definition) is at the call site, and it is asserted in both display systems so the behaviour does not depend on how core decides to round.
- **This view renders the SIGNED-IN ACCOUNT'S OWN records.** `GET /api/v1/observations` takes no patient identifier in any route parameter, query string or body — the patient is the subject of the presented token, deliberately (`observations.controller.ts`). There is no physician identity, no patient-selection path, and no authorization surface that would allow one. The layout is the uncombined clinical one (SRS §3.5) rather than the patient dashboard, but the reader in v1 is the account holder. SRS §3.5 Epic 5's secure read-only share link is the route by which a physician is intended to reach it, and it does not exist yet. The copy was reworded to claim neither an audience nor a selected patient; do not reintroduce a heading that implies either until the share-link surface lands.
- **No dedicated `/callback` route.** The OIDC redirect URI is the app root; `AuthProvider` inspects the URL's query string on mount regardless of path, so the callback can land on any guarded route without a separate page — but the redirect URI must be configured to a route this app actually renders (the root), not an arbitrary path.
