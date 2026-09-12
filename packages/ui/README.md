# @ostomy/ui

Shared, accessible presentational primitives and design tokens, consumed by `apps/web` today and intended for `apps/mobile` and `apps/admin` later (SRS_v2 §4.2).

## Scope and boundaries

- **No PHI-shaped types, ever.** This package renders `children`/props supplied by the caller; it has no idea what a stoma output volume or a patient record looks like. That keeps it safely importable by the zero-PHI admin console later (SRS §3.11) without an import-boundary lint rule having to guess.
- **No copy of its own.** Every visible string — labels, hints, error text, button text — is a required prop supplied by the consuming app from the shared `@ostomy/core/i18n` catalog (ADR-0006). The `no-literal-string` ESLint rule enforces this for JSX text and for accessible-name attributes (`aria-label`, `alt`, `title`, `placeholder`, ...).
- **React-Native-Web compatibility in mind, not guaranteed today.** `Button`, `TextField`, `ToggleGroup`, `Badge`, `InlineNotice`, `VisuallyHidden` are built from elements with reasonably direct RN-Web equivalents. `SkipLink` is explicitly **web-only** — "skip to main content" and offscreen-until-focused positioning are document-flow concepts with no React Native analogue — and is documented as such in its own file rather than forced into a false shared shape.

## Components

| Component        | Purpose                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| `Button`          | A `>= 44px` touch-target button with a visible `:focus-visible` ring.                              |
| `TextField`       | A labelled text input; label/hint/error are tied to the input via `htmlFor`/`id`/`aria-describedby`. |
| `ToggleGroup`     | A native `fieldset`/`legend`/radio group — e.g. the mandatory Measured/Estimated toggle (SRS §3.1, AC 2.2). Every option always shows visible text, never an icon alone. |
| `Badge`           | A small status indicator. `children` (visible text) is required; `icon` is optional and decorative — so a state is never conveyed by icon or colour alone. |
| `InlineNotice`    | A bordered, iconable banner for empty states and warnings, with an optional `aria-live` region.    |
| `VisuallyHidden`  | Screen-reader-only content (e.g. a chart's long-form text description).                            |
| `SkipLink`        | Web-only "skip to main content" link (WCAG 2.4.1).                                                 |
| `icons`           | Small decorative, `aria-hidden` SVG glyphs (`MeasuredIcon`, `EstimatedIcon`, `NoticeIcon`) meant to be paired with a `Badge`/`InlineNotice`'s visible text, never used alone. |

`tokens.ts` holds design tokens as plain data (colors, spacing, radius, typography, touch-target minimum, focus-ring styling); `styles.css` holds the matching CSS custom properties and the component class rules. The two are kept in sync by convention and asserted by `tokens.spec.ts` — see `tokens.ts`'s own comment for why they are not generated from one source.

## Commands

```
pnpm --filter @ostomy/ui build       # tsc + copy styles.css into dist/
pnpm --filter @ostomy/ui typecheck
pnpm --filter @ostomy/ui test
```

Import the stylesheet once, at the application root:

```ts
import '@ostomy/ui/styles.css';
```
