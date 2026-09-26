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

import { act, renderHook } from '@testing-library/react-native';

const mockReadThresholds = jest.fn();
jest.mock('../db/repositories/thresholdsRepository', () => ({
  readThresholds: (...args: unknown[]) => mockReadThresholds(...args),
}));

const mockSyncStatus = { isRunning: false };
jest.mock('../sync/SyncProvider', () => ({
  useSyncStatus: () => mockSyncStatus,
}));

import { useCachedThresholds } from './useCachedThresholds';

const executor = {} as never;
const readyDatabase = { status: 'ready', executor } as never;

const THRESHOLDS = { thresholds: { maxVolumeMl: '2000' } };

beforeEach(() => {
  jest.clearAllMocks();
  mockSyncStatus.isRunning = false;
  mockReadThresholds.mockResolvedValue(THRESHOLDS);
});

describe('the three states are distinct', () => {
  /**
   * `undefined` must not read as `null`. Collapsing them shows the cannot-save
   * message during the ordinary first render, i.e. to every patient on every open.
   */
  it('stays undefined while the read is still in flight', async () => {
    // A read that never settles, because that is the state under test: `undefined`
    // is "we have not looked yet", and it must not read as `null`. Awaiting a
    // resolved read would flush straight past it and assert nothing.
    mockReadThresholds.mockReturnValue(new Promise(() => undefined));

    const { result } = await renderHook(() => useCachedThresholds(readyDatabase));

    expect(result.current).toBeUndefined();
  });

  it('becomes the cached value once read', async () => {
    const { result } = await renderHook(() => useCachedThresholds(readyDatabase));

    await act(async () => undefined);
    expect(result.current).toEqual(THRESHOLDS);
  });

  it('becomes null when the cache is empty', async () => {
    mockReadThresholds.mockResolvedValue(null);

    const { result } = await renderHook(() => useCachedThresholds(readyDatabase));

    await act(async () => undefined);
    expect(result.current).toBeNull();
  });

  it('becomes null when the read itself fails', async () => {
    // An unreadable cache and an empty one have the same consequence: the save must
    // refuse rather than validate against nothing.
    mockReadThresholds.mockRejectedValue(new Error('database closed'));

    const { result } = await renderHook(() => useCachedThresholds(readyDatabase));

    await act(async () => undefined);
    expect(result.current).toBeNull();
  });

  it('does not read at all before the database is open', async () => {
    await renderHook(() => useCachedThresholds({ status: 'opening' } as never));

    await act(async () => undefined);
    expect(mockReadThresholds).not.toHaveBeenCalled();
  });
});

/**
 * #63. The cache fills from the sync worker's `/thresholds` call, which happens
 * after this screen can already be open — so reading once at mount left the patient
 * looking at a permanently disabled Save button with the cache populated underneath
 * it, recoverable only by leaving the screen and coming back.
 *
 * That is the same defect as the copy #63 is about, in a different costume: the
 * message would have to tell the patient to back out and re-enter.
 */
describe('it recovers when a sync fills the cache', () => {
  it('re-reads after a cycle finishes', async () => {
    mockReadThresholds.mockResolvedValue(null);
    const { result, rerender } = await renderHook(() => useCachedThresholds(readyDatabase));
    await act(async () => undefined);
    expect(result.current).toBeNull();

    // A cycle runs and populates the cache.
    mockReadThresholds.mockResolvedValue(THRESHOLDS);
    mockSyncStatus.isRunning = true;
    await act(async () => {
      rerender(undefined);
    });
    mockSyncStatus.isRunning = false;
    await act(async () => {
      rerender(undefined);
    });

    expect(result.current).toEqual(THRESHOLDS);
  });

  it('does not re-read when nothing about the sync changed', async () => {
    const { rerender } = await renderHook(() => useCachedThresholds(readyDatabase));
    await act(async () => undefined);
    expect(mockReadThresholds).toHaveBeenCalledTimes(1);

    await act(async () => {
      rerender(undefined);
    });

    expect(mockReadThresholds).toHaveBeenCalledTimes(1);
  });
});
