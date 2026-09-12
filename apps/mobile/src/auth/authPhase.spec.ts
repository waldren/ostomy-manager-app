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

import { deriveAuthPhase } from './authPhase';

describe('deriveAuthPhase', () => {
  it('is signedOut with no stored refresh token, regardless of unlock state', () => {
    expect(deriveAuthPhase({ hasStoredRefreshToken: false, unlockedThisSession: false })).toBe(
      'signedOut',
    );
    expect(deriveAuthPhase({ hasStoredRefreshToken: false, unlockedThisSession: true })).toBe(
      'signedOut',
    );
  });

  it('is locked with a stored refresh token not yet unlocked this session', () => {
    expect(deriveAuthPhase({ hasStoredRefreshToken: true, unlockedThisSession: false })).toBe(
      'locked',
    );
  });

  it('is authenticated with a stored refresh token unlocked this session', () => {
    expect(deriveAuthPhase({ hasStoredRefreshToken: true, unlockedThisSession: true })).toBe(
      'authenticated',
    );
  });
});
