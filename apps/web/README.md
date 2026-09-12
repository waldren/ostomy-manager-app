# Web App

Patient-facing React + Vite SPA (SRS_v2 §4.2). **Online-only by explicit decision** — no local persistence layer, no service-worker data cache, no offline queue. Every read and write goes straight to `apps/api`; do not add offline support here (that asymmetry with `apps/mobile` is deliberate).

## What's here (P2.S3)

- **Auth:** OAuth 2.0 Authorization Code + PKCE against the standard OIDC issuer configured in `.env` (`src/auth/`) — no vendor SDK, no client secret (a public SPA cannot hold one). Tokens live in `sessionStorage` for the lifetime of the session only; no clinical data is ever persisted client-side.
- **i18n:** `src/i18n` merges the shared `@ostomy/core/i18n` catalog with this app's own `web` namespace. See `src/i18n/locales/en/web.ts`'s doc comment for why a second namespace exists here and what belongs in each.
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

- **ADR-0006 states one shared i18n catalog with "no per-app catalogs."** This sprint's scope excludes modifying `packages/core/src/**`, so app-shell copy with no clinical meaning lives in this app's own `web` namespace instead, as a reported deviation — see that file's doc comment for the intended follow-up.
- **No persisted measurement-system preference.** Preference Management is a P4 feature. The unit toggle on the physician view is local view state for this session only; it never rewrites a stored value.
- **Mixed-entry-system daily totals.** `formatObservationsForDisplay.ts`'s day-total rounding falls back to "always round" when a day's entries were not all entered in the same measurement system, rather than a fully specified mixed-system policy — documented in that file.
- **No dedicated `/callback` route.** The OIDC redirect URI is the app root; `AuthProvider` inspects the URL's query string on mount regardless of path, so the callback can land on any guarded route without a separate page — but the redirect URI must be configured to a route this app actually renders (the root), not an arbitrary path.
