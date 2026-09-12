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
 * `apps/web`'s own i18n namespace.
 *
 * ADR-0006 calls for ONE shared catalog in `packages/core/src/i18n`, with
 * "no per-app catalogs." This sprint's scope explicitly excludes modifying
 * `packages/core/src/**` (that subpath is owned elsewhere under ADR-0007),
 * so app-shell copy that has no clinical meaning — navigation labels,
 * sign-in screen text, table/column headings — lives here instead, as a
 * deliberate, reported deviation rather than a silent workaround. Anything
 * with clinical or cross-app meaning (the Measured/Estimated labels, a
 * validation message, a red-flag prompt) stays sourced from
 * `@ostomy/core/i18n`, never duplicated here.
 *
 * Follow-up: fold this namespace into `packages/core/src/i18n` once
 * `apps/mobile` needs the same app-shell copy, so ADR-0006's "one shared
 * catalog" becomes true again rather than "true except apps/web."
 *
 * Same key-naming convention as the core catalog (see
 * `packages/core/src/i18n/index.ts`): `*.label` is visible text,
 * `*.a11yLabel` is an accessible name only when it must differ from the
 * visible label, `*.hint` is supplementary text.
 */
export const web = {
  'app.title': 'Ostomy Care',
  'app.skipToMainContent': 'Skip to main content',

  'auth.signInHeading': 'Sign in to your account',
  'auth.signInBody': 'Sign in to see your stoma output history.',
  'auth.signInButton': 'Sign in',
  'auth.signingIn': 'Signing you in…',
  'auth.signOutButton': 'Sign out',
  'auth.signInError':
    'We could not sign you in. Please try again, or contact your care team if this keeps happening.',
  'auth.sessionExpired': 'Your session ended. Please sign in again.',

  'nav.physicianView': 'Physician view',

  'physicianView.heading': 'Physician view — stoma output',
  'physicianView.intro':
    'This page shows your stoma output for one day. Each signal is shown on its own — nothing is combined into a single score.',
  'physicianView.loading': 'Loading stoma output…',
  'physicianView.loadError':
    'We could not load stoma output right now. Please try again in a moment.',
  'physicianView.retryButton': 'Try again',
  'physicianView.previousDay': 'Show the previous day',
  'physicianView.nextDay': 'Show the next day',
  'physicianView.nextDayDisabledHint': 'You cannot view a day in the future.',
  'physicianView.selectedDate': 'Date shown',
  'physicianView.unitsLabel': 'Show volumes in',
  'physicianView.unitsMetric': 'Milliliters (mL)',
  'physicianView.unitsImperial': 'Fluid ounces (oz)',

  'physicianView.emptyState.heading': 'No stoma output logged for this day',
  'physicianView.emptyState.body': 'No entries were recorded for this date yet.',

  'physicianView.netBalance.heading': 'Daily net fluid balance: not available yet',
  'physicianView.netBalance.body':
    'Net fluid balance needs both fluid intake and stoma output. Fluid intake logging is not built yet, so this number is not shown. Showing a number now could be wrong and could be trusted by mistake.',

  'physicianView.chart.heading': 'Stoma output over the day',
  'physicianView.chart.caption':
    'A chart of stoma output volume by time of day. The same values are listed in the table below this chart.',
  'physicianView.chart.axisTime': 'Time of day',
  'physicianView.chart.axisVolume': 'Output volume',
  'physicianView.chart.longDescriptionIntro':
    'Text description of the chart above, for screen readers and anyone who prefers reading numbers to a picture:',

  'physicianView.table.caption': 'Stoma output entries for the selected day, earliest first',
  'physicianView.table.columnTime': 'Time',
  'physicianView.table.columnVolume': 'Volume',
  'physicianView.table.columnMethod': 'Measured or estimated',
  'physicianView.table.totalRowLabel': 'Total stoma output for this day',

  'errors.notFoundHeading': 'Page not found',
  'errors.notFoundBody': 'The page you are looking for does not exist.',
  'errors.notFoundLinkHome': 'Go to the physician view',
} as const;
