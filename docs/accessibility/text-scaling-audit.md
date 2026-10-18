# Text scaling and contrast audit (P4.S3 slice 6)

Issue #139, decision 4: accessibility is **honoured, not re-implemented**. The app follows the phone's own text-size and contrast settings rather than adding settings of its own. This document records the audit that decision called for: that nothing switches the OS setting off, that every screen survives the largest system font, and whether an in-app contrast toggle is needed.

Audited 2026-10-17, on the `apps/mobile` code at the head of `feat/139-a11y-audit`.

## What was checked, and how

### 1. Nothing switches OS text scaling off (static)

The app's screens (`app/`) and components (`src/`) were searched for every way React Native lets a component stop text following the OS setting: `allowFontScaling={false}`, `maxFontSizeMultiplier`, `adjustsFontSizeToFit`, `minimumFontScale`, and the truncation props `numberOfLines` and `ellipsizeMode`. None is used. Two components set `allowFontScaling` explicitly, to its default of `true`.

That is now a build check, not a one-off search: `apps/mobile/src/ui/textScaling.spec.ts` fails if any of them appears outside a comment. It was confirmed to fail by adding `maxFontSizeMultiplier` to `Heading`.

Every route renders inside `Screen`, whose `ScrollView` is what lets a screen grow taller than the phone at a large text size.

### 2. Every screen at the largest system font (emulator)

On a Pixel 8 emulator running Android 16, at the largest system text size (`font_scale` 2.0), against the local dev stack, these screens were opened and scrolled end to end:

| Screen | Result |
| --- | --- |
| Sign in (session ended) | Passes. Headings and body wrap; the button grows with its label. |
| Unlock ("Welcome back") | Passes. |
| Home, including the "Log again" buttons | Passes, with one layout fix (below). |
| Settings | Passes, with one layout fix (below). |
| Quick-Add buttons | Passes. |
| Add a stoma entry | Passes: the amount field, the Measured/Estimated choice, the date and time, and Save. |
| Add a urine entry | **Failed**, then fixed (below). |

Line heights in this app are written in density-independent pixels. React Native scales them with the text when `allowFontScaling` is on, which the screenshots confirm: no line overlapped another on any screen.

**What the emulator could not reach.** The screens behind the app's unlock — Add intake, Add meal, the correction inbox and the target ranges screen — were not re-checked after the fix below, because unlocking needs the device PIN typed into a secure system window that `adb` cannot drive (`scripts/android-emulator.sh` documents this). They use the same components as the screens that were checked: `Screen`, `Heading`, `BodyText`, `Button`, `NumericField`, `TextField`, `ChoiceGroup` and `TagGroup`.

### 3. Contrast

Every colour pair in `packages/ui`'s tokens has its contrast ratio computed, not claimed, by `packages/ui/src/tokens.spec.ts`, and every pair that carries text meets WCAG 2.1 AA.

Android's own **high contrast text** setting reaches this app. With it on, body text turns pure black and button labels get a dark backing behind them, the same treatment the system gives its own text.

## Findings and fixes

1. **The urine colour scale broke at large text (WCAG 1.4.4, Resize text). Fixed.** At 2.0× the option labels ran past their borders, the colour swatches stuck out past the options' left edges, and "Orange-brown" broke mid-word and was hidden behind the next swatch. The cause was in `ChoiceGroup`: each option had a fixed 140 dp width basis, so two options stayed side by side however large the text grew, and the label could not shrink to wrap inside its box. Now:
   - the basis scales with the OS text size, so at a large size each option takes a whole row and the options stack;
   - the label shrinks and wraps within its option;
   - the swatch and the check mark keep their size.

   The same change un-crams the two-option choices elsewhere, such as the units question in Settings, where "Millilitres and kilograms (mL, kg)" was squeezed onto four lines beside the check mark. Pinned by `apps/mobile/src/ui/ChoiceGroup.spec.tsx`.
2. **The "Log again" buttons ran together at large text. Fixed.** Each button's "Change before saving" sat flush against the next button below it, so which entry it changed was a guess. Each button's group now has space after it.

## Decision: no in-app contrast toggle

Not built, as #139 decision 4 proposed. The app already meets AA contrast by computation. The OS high-contrast text setting already reaches it, so a patient who needs more contrast gets it from the setting they already use for every other app. SRS §5.4 asks us to honour OS settings "where the platform exposes them", and Android does.

If the accessibility review disagrees, the toggle becomes a `debt` issue rather than a change to this decision.

## What this audit does not prove

- **No real hardware.** This was run on an emulator. `docs/gate-b-hardware-verification.md` is unchanged: an emulator pass never closes a hardware item.
- **No screen reader.** TalkBack was not used here. Focus order, spoken names and announcements were reviewed in code for #147 and #149 and are unverified on a device. The date and time dialogs are #137.
- **Not the web app.** `apps/web` is outside decision 4, which is about the phone.
- **No patients.** This is not the usability review with representative patients that SRS §5.4 requires before launch.
