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

import { Button } from '@ostomy/ui';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

export interface IdleWarningDialogProps {
  /** Extends the session. Wired to the same activity bookkeeping a keypress uses. */
  readonly onStaySignedIn: () => void;
  readonly onSignOut: () => void;
}

/**
 * The warning WCAG 2.2.1 (Timing Adjustable, Level A) requires before an
 * inactivity timeout ends a session.
 *
 * ## Why this is required rather than optional
 *
 * The inactivity timeout was added to stop an unattended clinic workstation
 * from leaving one patient's stoma output on screen. That is a real
 * protection, and shipping it without this dialog traded a security problem
 * for an accessibility failure at Level A.
 *
 * The exception people reach for with security timeouts is "the time limit
 * is essential and extending it would invalidate the activity". It does not
 * apply here, and the reason is structural: a single keypress already
 * extends this session — that is exactly what the activity listeners do — so
 * extension cannot invalidate anything. The essential exception covers
 * deadlines that ARE the activity, like an auction close or a timed exam.
 *
 * ## Why it matters disproportionately for this population
 *
 * The activity listeners deliberately exclude `mousemove`, so a jittery
 * sensor cannot hold a session open. The cost of that correct decision is
 * that a user who reads slowly, uses a screen reader, or navigates with a
 * switch device can sit on one screen of numbers for fifteen minutes
 * without being idle at all, and gets no accidental reprieve.
 *
 * ## Implementation notes
 *
 * `role="alertdialog"` rather than `role="dialog"`: this both interrupts and
 * requires a response. Focus moves to the confirm button on open and returns
 * to whatever held it before, so a keyboard user is not dropped at the top of
 * the document. Escape extends rather than dismisses — the safe reading of an
 * ambiguous gesture is that the user is present.
 *
 * No live countdown is announced. A number changing every second in an
 * assertive region is unusable with a screen reader, and the copy does not
 * name a duration at all because the timeout is deployment configuration
 * (`VITE_SESSION_IDLE_TIMEOUT_MINUTES`) — copy hardcoding "15 minutes" goes
 * silently wrong the moment a site changes it.
 */
export function IdleWarningDialog({ onStaySignedIn, onSignOut }: IdleWarningDialogProps) {
  const { t } = useTranslation();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<Element | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    confirmRef.current?.focus();

    return () => {
      // Returning focus is what keeps this from being a trap in the other
      // direction: dismissing it must not leave the user at the document
      // top having lost their place in the day's table.
      if (previouslyFocused.current instanceof HTMLElement) {
        previouslyFocused.current.focus();
      }
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onStaySignedIn();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onStaySignedIn]);

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="idle-warning-heading"
      aria-describedby="idle-warning-body"
      className="ostomyIdleWarning"
    >
      <div className="ostomyIdleWarning__panel">
        <h2 id="idle-warning-heading">{t('auth.idleWarning.heading')}</h2>
        <p id="idle-warning-body">{t('auth.idleWarning.body')}</p>
        <Button ref={confirmRef} onClick={onStaySignedIn}>
          {t('auth.idleWarning.stayButton')}
        </Button>
        <Button variant="secondary" onClick={onSignOut}>
          {t('auth.idleWarning.signOutButton')}
        </Button>
      </div>
    </div>
  );
}
