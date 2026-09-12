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

const mockHasHardwareAsync = jest.fn();
const mockIsEnrolledAsync = jest.fn();
const mockAuthenticateAsync = jest.fn();

jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: (...args: unknown[]) => mockHasHardwareAsync(...args),
  isEnrolledAsync: (...args: unknown[]) => mockIsEnrolledAsync(...args),
  authenticateAsync: (...args: unknown[]) => mockAuthenticateAsync(...args),
}));

import { authenticate, isBiometricUnlockAvailable } from './biometricUnlock';

describe('biometricUnlock', () => {
  beforeEach(() => {
    mockHasHardwareAsync.mockReset();
    mockIsEnrolledAsync.mockReset();
    mockAuthenticateAsync.mockReset();
  });

  it('is unavailable with no hardware', async () => {
    mockHasHardwareAsync.mockResolvedValue(false);
    mockIsEnrolledAsync.mockResolvedValue(true);
    expect(await isBiometricUnlockAvailable()).toBe(false);

    const result = await authenticate('prompt');
    expect(result).toEqual({ outcome: 'unavailable' });
    expect(mockAuthenticateAsync).not.toHaveBeenCalled();
  });

  it('is unavailable with hardware but nothing enrolled', async () => {
    mockHasHardwareAsync.mockResolvedValue(true);
    mockIsEnrolledAsync.mockResolvedValue(false);
    expect(await isBiometricUnlockAvailable()).toBe(false);
  });

  it('succeeds when the OS prompt succeeds', async () => {
    mockHasHardwareAsync.mockResolvedValue(true);
    mockIsEnrolledAsync.mockResolvedValue(true);
    mockAuthenticateAsync.mockResolvedValue({ success: true });

    const result = await authenticate('Unlock your diary');
    expect(result).toEqual({ outcome: 'success' });
    expect(mockAuthenticateAsync).toHaveBeenCalledWith({ promptMessage: 'Unlock your diary' });
  });

  it('reports failure without throwing when the OS prompt is cancelled', async () => {
    mockHasHardwareAsync.mockResolvedValue(true);
    mockIsEnrolledAsync.mockResolvedValue(true);
    mockAuthenticateAsync.mockResolvedValue({ success: false, error: 'user_cancel' });

    const result = await authenticate('prompt');
    expect(result).toEqual({ outcome: 'failed' });
  });
});
