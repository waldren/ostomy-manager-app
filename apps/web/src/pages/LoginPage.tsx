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

import { Button, InlineNotice, NoticeIcon } from '@ostomy/ui';
import { useTranslation } from 'react-i18next';
import { Navigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext.js';

/**
 * Reasons the session ended on its own, and the copy for each.
 *
 * These are not sign-in failures and must not be dressed as them. Telling a
 * clinician "we could not sign you in" when they were already signed in
 * reads as the app being broken, and an assertive red error for an expected
 * fifteen-minute timeout trains people to ignore the one that is not
 * expected. Anything not listed here really was a failed attempt.
 */
const SESSION_ENDED_COPY: Readonly<Record<string, string>> = {
  session_expired: 'auth.sessionExpired',
  session_idle: 'auth.sessionIdle',
};

export function LoginPage() {
  const { t } = useTranslation();
  const { status, error, signIn } = useAuth();

  if (status === 'authenticated') {
    return <Navigate to="/" replace />;
  }

  const sessionEndedKey = error ? SESSION_ENDED_COPY[error] : undefined;

  return (
    <main id="main-content" tabIndex={-1}>
      <h1>{t('auth.signInHeading')}</h1>
      <p>{t('auth.signInBody')}</p>

      {error ? (
        sessionEndedKey ? (
          <InlineNotice variant="info" live="polite">
            <p>{t(sessionEndedKey)}</p>
          </InlineNotice>
        ) : (
          <InlineNotice variant="error" icon={<NoticeIcon />} live="assertive">
            <p>{t('auth.signInError')}</p>
          </InlineNotice>
        )
      ) : null}

      <Button onClick={() => void signIn()}>{t('auth.signInButton')}</Button>
    </main>
  );
}
