/*
Copyright (C) 2026 Steven E. Waldren

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published
by the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

/**
 * The `web` namespace: `apps/web`'s app-shell copy.
 *
 * Per-app namespace, **shared catalog**. ADR-0006 requires one catalog in
 * this package with no per-app catalogs, and that is what this is — the
 * namespace is scoped to one app because a web table heading is not mobile
 * shell copy, but it lives here so a reviewer auditing patient-facing text
 * reads all of it in one place. That single-place-to-audit property is the
 * ADR's actual argument, and it survives namespacing by app; it would not
 * survive a catalog inside `apps/web`.
 *
 * Scope discipline, which is what keeps this from drifting back toward two
 * catalogs: **only copy with no clinical meaning belongs here** —
 * navigation, sign-in, table and column headings, empty states. Anything
 * clinical or cross-app (the Measured/Estimated labels, a validation
 * message, a red-flag prompt) belongs in `common`, `validationErrors`,
 * `validationWarnings` or `redFlags`, and is never duplicated here.
 *
 * Same key-naming convention as the rest of the catalog (see
 * `packages/core/src/i18n/index.ts`): `*.label` is visible text,
 * `*.a11yLabel` is an accessible name only when it must differ from the
 * visible label, `*.hint` is supplementary text.
 */
export const web = {
  // The table had no heading at all, so a screen-reader user navigating by
  // heading met the chart's and then nothing.
  // Shown when the day held more entries than one request returns. The total
  // below it is then a total of what was fetched, not of the day — which is
  // the whole reason this says so rather than letting the number stand.
  // Announced when a day finishes loading. Without it the loading region
  // was unmounted and the chart, heading and table appeared silently with
  // focus unmoved — a screen-reader user pressed "previous day", heard
  // "Loading…", then nothing, and had no way to know whether the rows under
  // their cursor were the new day's or the old one's.
  'physicianView.loadedStatus_one': '{{count}} entry loaded for {{date}}.',
  'physicianView.loadedStatus_other': '{{count}} entries loaded for {{date}}.',
  'physicianView.truncated.heading': 'This day may have more entries than are shown',
  'physicianView.truncated.body':
    'Only the {{limit}} most recent entries for this day were loaded, so the earliest ones are not shown and the total below may be lower than the true total. Check the full record before using this number.',
  'physicianView.table.heading': 'All entries for this day',
  'app.title': 'Ostomy Care',
  // WCAG 2.4.2: the title names the page, not just the product. In an SPA it
  // is also how a screen-reader user learns a route changed.
  'app.documentTitle': '{{page}} — Ostomy Care',
  'app.skipToMainContent': 'Skip to main content',

  'auth.signInHeading': 'Sign in to your account',
  // Second person removed throughout this namespace: every screen it serves
  // is the PHYSICIAN view. "Your stoma output" told to a clinician is wrong,
  // and it is the kind of wrong that erodes trust in a clinical tool on the
  // first read.
  'auth.signInBody': 'Sign in to see stoma output history.',
  'auth.signInButton': 'Sign in',
  // Shown during SESSION RESTORE, not sign-in. A returning user was told
  // they were being signed in when they were not — and it was the only text
  // on a page with no landmark and no heading.
  'auth.restoringSessionHeading': 'Checking your sign-in',
  'auth.restoringSession': 'One moment while we check you are still signed in.',
  'auth.signOutButton': 'Sign out',
  // "your care team" was addressed to a physician, who does not have one.
  'auth.signInError':
    'We could not sign you in. Please try again. If this keeps happening, contact support.',
  'auth.sessionExpired': 'Your session ended. Please sign in again.',
  // Says WHY, because a timeout with no explanation reads as a fault. Names
  // the reason the timeout exists rather than the number of minutes: the
  // timeout is deployment configuration, and copy that hardcodes "15
  // minutes" goes silently wrong the moment a site changes it.
  // The WCAG 2.2.1 warning. Written in the ROUTINE voice, not the red-flag
  // voice: this is a housekeeping prompt, and dressing it as urgent would
  // spend the alarm vocabulary P7's safety prompts need. It names no number
  // of minutes because the timeout is deployment configuration — copy that
  // hardcodes "15 minutes" goes silently wrong when a site changes it.
  'auth.idleWarning.heading': 'Are you still there?',
  'auth.idleWarning.body':
    'This page has not been used for a little while, so it will sign you out soon. This keeps health information from being left on screen on a shared computer.',
  'auth.idleWarning.stayButton': 'Stay signed in',
  'auth.idleWarning.signOutButton': 'Sign out now',
  'auth.sessionIdle':
    'You were signed out because this page was not used for a while. This keeps patient information from staying on screen on a shared computer. Please sign in again.',

  'nav.physicianView': 'Physician view',

  // Deliberately names no audience and no patient.
  //
  // It read "Physician view — stoma output" over an intro saying "for this
  // patient", and GET /api/v1/observations takes no patient identifier at
  // all — the patient is the subject of the presented token. So the page
  // can only ever render the signed-in account's own records, and both
  // halves of that framing asserted something the data is not. Claiming a
  // selected patient is the same class of defect as showing one day's
  // figures under another day's heading.
  // Names the DAY, not one of the things on it. The page carried the heading
  // "Stoma output" while rendering a net fluid balance above the chart and,
  // since P3.S2, urine output beside it — so its own h1 described a third of
  // its content, and a reader could reasonably stop at the chart believing
  // they had seen the page. The chart and table keep their own "Stoma output"
  // headings, which is where that label is true.
  'physicianView.heading': 'One day of fluid records',
  'physicianView.intro':
    'Fluid balance, urine output, and every stoma entry for the day, listed and charted by time of day.',
  'physicianView.loading': 'Loading stoma output…',
  'physicianView.loadError':
    'We could not load stoma output right now. Please try again in a moment.',
  'physicianView.retryButton': 'Try again',
  'physicianView.previousDay': 'Show the previous day',
  'physicianView.nextDay': 'Show the next day',
  'physicianView.nextDayDisabledHint': 'Today is the most recent day that can be shown.',
  // Two keys, because they name two different things. One key served as
  // both the <nav> landmark's label and the date field's label, so a screen
  // reader announced "Date shown navigation" — which describes nothing
  // navigable — wrapping a field called "Date shown". It also meant a
  // translator could not diverge them and an edit to one silently changed
  // the other.
  'physicianView.dateNavLabel': 'Choose which day to show',
  'physicianView.selectedDate': 'Date shown',
  'physicianView.unitsLabel': 'Show volumes in',
  // Says plainly that the toggle is display-only. Without it a clinician can
  // reasonably read a unit switch as changing what was recorded.
  'physicianView.unitsHint':
    'This changes how volumes are shown here. It does not change what was recorded.',
  'physicianView.unitsMetric': 'Milliliters (mL)',
  'physicianView.unitsImperial': 'Fluid ounces (oz)',

  'physicianView.emptyState.heading': 'No stoma output logged for this day',
  'physicianView.emptyState.body':
    'No entries were recorded for this day. That does not always mean there was no output — it may not have been logged.',

  // Daily Net Fluid Balance (SRS §3.5), rendered now that intake logging
  // exists (P3.S1). The figure is intake MINUS output, so it is signed.
  //
  // The label does not say "negative" or "positive": a minus sign is already
  // in the formatted number, and naming the sign in words invites reading it
  // as a verdict. This view is a physician's, and SRS §3.5 keeps the four
  // hydration signals separate and uncombined — interpretation is the
  // reader's, not this page's.
  'physicianView.netBalance.heading': 'Daily net fluid balance',
  'physicianView.netBalance.value': '{{amount}}',
  // Says what the number IS, because a bare signed volume is ambiguous about
  // which direction is which.
  'physicianView.netBalance.explanation':
    'Fluid taken in, minus stoma output, for this day. A figure below zero means more was lost than taken in.',
  // Urine is excluded on purpose and the page says so unprompted. A reader
  // who assumes it is included would read a balance that looks reassuring
  // while urine output is dangerously low — the exact failure SRS §3.7's
  // separation exists to prevent, and it is invisible unless stated.
  'physicianView.netBalance.excludesUrine':
    'Urine is not part of this figure. It is tracked separately.',
  // The honest empty state: not "unavailable", which implies a fault, but
  // "nothing was recorded", which is a fact about the day.
  'physicianView.netBalance.noInputs':
    'No fluid intake or stoma output was recorded for this day, so there is no balance to show.',
  // A balance computed from one side only is not a balance. Rendering it
  // without saying so would let a day of output with no intake logged read
  // as a genuine deficit, when it may only be an unlogged one.
  'physicianView.netBalance.intakeMissing':
    'No fluid intake was recorded for this day. This figure is stoma output alone, and is not a complete balance.',
  'physicianView.netBalance.outputMissing':
    'No stoma output was recorded for this day. This figure is fluid intake alone, and is not a complete balance.',

  // --- Urine output, the second hydration signal (SRS §3.7, AC 12.1) -----
  //
  // Its own block on the page, immediately after the balance and never inside
  // it. The two are adjacent because a reader comparing them is the point,
  // and separate because combining them is the one thing CLAUDE.md names
  // outright about this data: net balance measures stoma losses, urine output
  // independently signals renal perfusion, and a normal-looking balance can
  // hide a dangerously low urine output.
  //
  // This is a physician's view, so it reports and does not interpret. No
  // threshold, no verdict, no colour-coded status — SRS §5.4 reserves the
  // urgent voice for the red-flag prompt, and the four signals stay separate
  // and uncombined here.
  'physicianView.urine.heading': 'Urine output',
  'physicianView.urine.total': 'Measured total: {{amount}}',
  // Says how much of the day the total actually covers. AC 12.1 AC2 makes the
  // amount optional, so a day can hold four entries and one measured volume —
  // and a bare total would describe that day as though the other three had
  // not happened.
  'physicianView.urine.measuredOf_one': 'From 1 of {{total}} entries recorded this day.',
  'physicianView.urine.measuredOf_other': 'From {{count}} of {{total}} entries recorded this day.',
  // The whole day was recorded by colour. Not an error and not a gap in the
  // data: it is the entry AC 12.1 AC2 exists for, made by a patient who
  // cannot measure, and it carries a real hydration signal.
  'physicianView.urine.noneMeasured_one': '1 entry was recorded this day, with no amount measured.',
  'physicianView.urine.noneMeasured_other':
    '{{count}} entries were recorded this day, with no amount measured.',
  'physicianView.urine.colorsHeading': 'Colours recorded',
  // Named for what it is worth: colour is a proxy a patient can report when
  // they cannot measure, and darker means more concentrated. Stated without a
  // threshold, because reading it against this patient is the clinician's job.
  'physicianView.urine.colorsExplanation':
    'Darker urine is more concentrated. These are the shades the patient recorded, not a measurement.',
  // The mirror of `netBalance.excludesUrine`, said from this side too. A
  // reader arriving at this block first should not have to find the other one
  // to learn the two figures are separate.
  'physicianView.urine.separateFromBalance':
    'This is tracked on its own and is not part of the daily net fluid balance above.',

  // ADR-0016: an entry is filed under the patient's local day, derived from
  // the zone captured at entry. An entry whose zone this runtime cannot
  // resolve belongs to no day this page can name, so it is excluded — and
  // said out loud, because the alternative is an empty state asserting
  // nothing was recorded when something was.
  'physicianView.undatable.heading': 'Some entries could not be placed on a day',
  'physicianView.undatable.body_one':
    '1 entry could not be matched to a calendar day and is not included below. The day shown may be incomplete.',
  'physicianView.undatable.body_other':
    '{{count}} entries could not be matched to a calendar day and are not included below. The day shown may be incomplete.',

  'physicianView.chart.heading': 'Stoma output over the day',
  'physicianView.chart.caption':
    'A chart of stoma output volume by time of day. The same values are listed in the table below this chart.',
  'physicianView.chart.axisTime': 'Time of day',
  // Names its unit. Without it the scale was ambiguous on a page carrying a
  // metric/imperial toggle: the same bar means 350 mL or 12 fl oz depending
  // on a control elsewhere, and the chart said neither.
  'physicianView.chart.axisVolume': 'Output volume ({{unit}})',
  // The trailing clause promised "…and anyone who prefers reading numbers to
  // a picture" from inside a visually-hidden block no sighted user can reach.
  'physicianView.chart.longDescriptionIntro': 'Text description of the chart above.',

  'physicianView.table.caption': 'Stoma output entries for the selected day, earliest first',
  'physicianView.table.columnTime': 'Time',
  'physicianView.table.columnVolume': 'Volume',
  'physicianView.table.columnMethod': 'Measured or estimated',
  'physicianView.table.totalRowLabel': 'Total stoma output for this day',

  'errors.notFoundHeading': 'Page not found',
  'errors.notFoundBody': 'The page you are looking for does not exist.',
  'errors.notFoundLinkHome': 'Go to the physician view',
} as const;
