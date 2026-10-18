# Text scaling and contrast audit (P4.S3 slice 6)

Issue #139, decision 4: accessibility is **honoured, not re-implemented**. The app follows the phone's own text-size and contrast settings rather than adding settings of its own. This document records the audit that decision called for: that nothing switches the OS setting off, that every screen survives the largest system font, and whether an in-app contrast toggle is needed.

Audited 2026-10-17 and re-checked after review on 2026-10-18, on the `apps/mobile` code at the head of `feat/139-a11y-audit`.

## What was checked, and how

### 1. Nothing switches OS text scaling off (static)

The app's screens (`app/`) and components (`src/`) were searched for every way React Native lets a component stop text following the OS setting: `allowFontScaling={false}`, `maxFontSizeMultiplier`, `adjustsFontSizeToFit`, `minimumFontScale`, and the truncation props `numberOfLines` and `ellipsizeMode`. None is used. Two components set `allowFontScaling` explicitly, to its default of `true`.

That is now a build check, not a one-off search: `apps/mobile/src/ui/textScaling.spec.ts` fails if any of them appears outside a comment. It was confirmed to fail by adding `maxFontSizeMultiplier` to `Heading`. After review it also refuses `allowFontScaling` set to anything but `true` (a variable included), `defaultProps`, dividing a size by the font scale, and the containers that can clip grown text (a fixed `height`/`maxHeight`, `overflow: 'hidden'`, `position: 'absolute'`). Each new rule was confirmed to fail on a planted use.

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
| Add a urine entry | **Failed**, then fixed (below), and re-checked: passes. |
| Add a drink | Passes, after the fix: the Measured/Estimated and drink-type choices stack. |
| Add a meal | Passes, after the fix: the size choices stack and the tags wrap. |
| Your target ranges | Passes. |
| Entries that need your attention | Passes (nothing to correct at the time). |

Line heights in this app are written in density-independent pixels. React Native scales them with the text when `allowFontScaling` is on, which the screenshots confirm: no line overlapped another on any screen.

**After the fixes**, every screen above was opened again at 2.0× (the device PIN entered by hand, since `adb` cannot type into the secure unlock window that `scripts/android-emulator.sh` documents). The home screen's buttons were confirmed spaced apart. The emulator was then returned to the default text size.

### 3. Contrast

Every colour pair in `packages/ui`'s tokens has its contrast ratio computed, not claimed, by `packages/ui/src/tokens.spec.ts`, and every pair that carries text meets WCAG 2.1 AA.

Android's own **high contrast text** setting reaches this app. With it on, body text turns pure black and button labels get a dark backing behind them, the same treatment the system gives its own text.

### 4. Second pass, after review (#150)

The review asked for more than the largest text size. Re-checked on the same emulator:

| Condition | Screens | Result |
| --- | --- | --- |
| 2.0× text at the default display size | Home, Add a urine entry | Passes. |
| 2.0× text **and** a larger display size (density 560, about 308 dp wide) | Unlock, Home, Add a urine entry, Settings | Passes after finding 3 below. |
| Settings when the profile could not be fetched (an error state) | Settings | Passes: the error and its retry wrap. |
| "Open phone settings" | Settings | Opens Android's accessibility settings; Back returns to the app. |

Not re-checked on a device, and still open: 1.15×, 1.3× and 1.5× text; landscape; the phone in dark theme (the status bar is now forced to dark icons in code, unseen); onboarding. Every layout rule involved scales continuously with the text, so the intermediate sizes are expected to sit between 1.0× and 2.0×, but expected is not checked.

## Findings and fixes

1. **The urine colour scale broke at large text (WCAG 1.4.4, Resize text). Fixed.** At 2.0× the option labels ran past their borders, the colour swatches stuck out past the options' left edges, and "Orange-brown" broke mid-word and was hidden behind the next swatch. The cause was in `ChoiceGroup`: each option had a fixed 140 dp width basis, so two options stayed side by side however large the text grew, and the label could not shrink to wrap inside its box. Now:
   - the basis scales with the OS text size, so at a large size each option takes a whole row and the options stack;
   - the label shrinks and wraps within its option;
   - the swatch and the check mark keep their size.

   The same change un-crams the two-option choices elsewhere, such as the units question in Settings, where "Millilitres and kilograms (mL, kg)" was squeezed onto four lines beside the check mark. Pinned by `apps/mobile/src/ui/ChoiceGroup.spec.tsx`, and re-checked on the emulator: each colour is now on its own row, inside its option, with "Orange-brown" whole.
2. **The "Log again" buttons ran together at large text. Fixed.** Each button's "Change before saving" sat flush against the next button below it, so which entry it changed was a guess. Each button's group now has space after it, and the button's spoken name says which entry it changes, since spacing only tells sighted patients.
3. **"Orange-brown" still broke mid-word at a larger display size. Fixed.** At 2.0× text with display size raised, the options stacked as intended, but beside the check mark and swatch the label had about 148 dp, the word needs about 160, and Android would not break it at the hyphen ("Orange-bro / wn"). Once the options have stacked (measured, since it depends on the screen's width in dp as well as the text), a colour option puts its swatch above its label, which then has the option's whole width. Re-checked: whole, and selecting it adds the mark without moving anything.
4. **Smaller layout fixes from review.** An option is never wider than its row; the check mark keeps its space when unselected, so choosing an option cannot re-wrap its label and move the options below under the patient's finger; colour swatches line up on the left like a printed chart; labels in `TagGroup` and `Button` wrap rather than run past their borders.
5. **SRS §3.10's "text scaling and contrast options" now has a visible entry point.** Settings gains "Text size and contrast", which says the app follows the phone's settings and opens them. Decision 4 is unchanged; this is where a patient looking for the option finds it.

## Decision: no in-app contrast toggle

Not built, as #139 decision 4 proposed. The app already meets AA contrast by computation. The OS high-contrast text setting already reaches it, so a patient who needs more contrast gets it from the setting they already use for every other app. SRS §3.10 lists "text scaling and contrast options, honoring OS-level settings where the platform exposes them", and Android does.

If the accessibility review disagrees, the toggle becomes a `debt` issue rather than a change to this decision.

## What this audit does not prove

- **No real hardware.** This was run on an emulator. `docs/gate-b-hardware-verification.md` is unchanged: an emulator pass never closes a hardware item.
- **No screen reader.** TalkBack was not used here. Focus order, spoken names and announcements were reviewed in code for #147 and #149 and are unverified on a device. The date and time dialogs are #137.
- **Only some text sizes, and one phone shape.** See the second pass above for what was not re-checked. Android's "bold text" setting and its separate contrast levels were not tried.
- **Contrast is computed for the light palette only.** The app has no dark palette; with the phone in dark theme it stays light.
- **Not the web app.** `apps/web` is outside decision 4, which is about the phone.
- **No patients.** This is not the usability review with representative patients that SRS §5.4 requires before launch.
