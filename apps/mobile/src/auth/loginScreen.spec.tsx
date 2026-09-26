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
 * Rendering tests for `app/login.tsx`.
 *
 * **In `src/`, not next to the screen.** A `*.spec.tsx` file inside `app/` becomes an
 * Expo Router route, which pulls `@testing-library/react-native` into the shipped
 * bundle — found the hard way at #72.
 *
 * `app/login.tsx` had no spec at all before this. Both reviews of #84 asked for one,
 * and the specific hole is that the two automatic-sign-out reasons each render their
 * own copy: adding a third reason with no copy typechecked cleanly and reproduced
 * #40's symptom, a patient meeting a bare sign-in screen with no explanation.
 */
import { render, screen } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';

import type { AuthPhase } from './authPhase';
import type { SignedOutReason } from './tokenStorage';

const mockAuthState: {
  phase: AuthPhase;
  signedOutReason: SignedOutReason | undefined;
} = { phase: 'signedOut', signedOutReason: undefined };

jest.mock('./AuthContext', () => ({
  useAuth: () => ({
    phase: mockAuthState.phase,
    signedOutReason: mockAuthState.signedOutReason,
    unlock: jest.fn(async () => ({ outcome: 'success' })),
    signInFailed: false,
    clearSignInFailure: jest.fn(),
  }),
}));

jest.mock('./biometricUnlock', () => ({
  isLocalUnlockAvailable: jest.fn(async () => true),
}));

jest.mock('./useOidcLogin', () => ({
  useOidcLogin: () => ({ login: jest.fn(), isReady: true }),
}));

jest.mock('expo-router', () => ({ Redirect: () => null }));

// Real catalog, so these assertions are against the copy that ships rather than
// against translation keys — the point of the spec is what the patient reads.
import '../i18n/i18n';

import Login from '../../app/login';

const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthState.phase = 'signedOut';
  mockAuthState.signedOutReason = undefined;
});

describe('the screen says why the app ended the session', () => {
  it('explains an enrolment change, and does not mention an expired sign-in', async () => {
    mockAuthState.signedOutReason = 'unlock-settings-changed';

    await render(<Login />);

    expect(screen.getByText(/keep your diary safe/i)).toBeTruthy();
    expect(screen.queryByText(/sign-in has ended/i)).toBeNull();
  });

  /**
   * The half that shipped unrendered would have been caught here. #84 persisted
   * `session-expired` and, at one point in review, had no branch rendering it — so
   * the patient met exactly the bare sign-in screen the reason exists to prevent.
   */
  it('explains an expired sign-in, and does not blame the phone', async () => {
    mockAuthState.signedOutReason = 'session-expired';

    await render(<Login />);

    expect(screen.getByText(/sign-in has ended/i)).toBeTruthy();
    // Must NOT reuse the enrolment copy: it asserts something about the phone's
    // security that is false here and sends the patient looking for a problem that
    // does not exist.
    expect(screen.queryByText(/fingerprint, face, or screen lock on this phone/i)).toBeNull();
  });

  it('says nothing at all when the patient signed out deliberately', async () => {
    await render(<Login />);

    expect(screen.queryByText(/keep your diary safe/i)).toBeNull();
    expect(screen.queryByText(/sign-in has ended/i)).toBeNull();
  });

  /**
   * Both reasons promise this, and both are true — `endSession` clears the token and
   * never purges, which `AuthContext.spec.tsx` asserts. It is the first thing a
   * patient meeting an unexpected sign-in screen needs, so it is worth pinning that
   * the promise is actually on screen rather than only in the catalog.
   */
  it.each(['unlock-settings-changed', 'session-expired'] as const)(
    'reassures the patient nothing is lost (%s)',
    async (reason) => {
      mockAuthState.signedOutReason = reason;

      await render(<Login />);

      expect(screen.getByText(/nothing you wrote is lost/i)).toBeTruthy();
    },
  );
});

describe('the swap from unlock to sign-in is announced', () => {
  /**
   * Both pre-authenticated phases render this one component, so a session ended
   * inside `unlock()` — the only way `session-expired` is ever recorded — replaces
   * the unlock button under an already-mounted screen. Nothing was spoken for that,
   * and it is worse than a failed sign-in: the patient's unlock SUCCEEDED and the
   * screen silently became something else.
   */
  it('announces the reason when the phase flips from locked to signedOut', async () => {
    mockAuthState.phase = 'locked';
    const view = await render(<Login />);

    mockAuthState.phase = 'signedOut';
    mockAuthState.signedOutReason = 'session-expired';
    await view.rerender(<Login />);

    expect(announce).toHaveBeenCalledWith(expect.stringMatching(/sign-in has ended/i));
  });

  it('does not announce it again on a cold start', async () => {
    // Here the reason is read back from storage and the block IS initial content, so
    // reading order carries it. Announcing anyway would speak it twice.
    mockAuthState.signedOutReason = 'unlock-settings-changed';

    await render(<Login />);

    expect(announce).not.toHaveBeenCalled();
  });
});
