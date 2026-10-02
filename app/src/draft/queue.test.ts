import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type ApiFetch, type ApiRequest } from '../api/client';
import { move, readQueue, useDraftQueue, type ServerDraftQueue } from './queue';

const chase = { id: 'fx-chase', name: "Ja'Marr Chase", team: 'CIN', position: 'WR' };
const lamb = { id: 'fx-lamb', name: 'CeeDee Lamb', team: 'DAL', position: 'WR' };
const KNOWN = [chase, lamb];

/** A server queue in memory; `fail` makes the next request of that method throw. */
function server(initial: string[] = []) {
  let ids = initial;
  const calls: { path: string; request: ApiRequest }[] = [];
  const fail: Record<'GET' | 'PUT', false | 'api' | 'network'> = { GET: false, PUT: false };
  const view = (): ServerDraftQueue => ({
    teamId: 'team-1',
    maxSize: 50,
    updatedAt: null,
    players: ids.map((id) => ({
      player: KNOWN.find((p) => p.id === id) as typeof chase,
      rank: null,
      available: true
    }))
  });
  const api = (async (path: string, request: ApiRequest = {}) => {
    calls.push({ path, request });
    const method = request.method === 'PUT' ? 'PUT' : 'GET';
    const failure = fail[method];
    if (failure !== false) {
      fail[method] = false;
      if (failure === 'network') throw 'offline';
      throw new ApiError(403, { code: 'FORBIDDEN', message: 'You do not manage a team in this league.' });
    }
    if (method === 'PUT') ids = (request.body as { playerIds: string[] }).playerIds;
    return { data: view(), league: null, warnings: [] };
  }) as ApiFetch;
  return { api, calls, fail, ids: () => ids };
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('draft queue', () => {
  it('moves entries, clamped to the list', () => {
    expect(move(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(move(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(move(['a', 'b', 'c'], 1, 5)).toEqual(['a', 'c', 'b']);
  });

  it('loads the server queue and saves every change as the whole ordered list', async () => {
    const s = server(['fx-lamb']);
    const { result } = renderHook(() => useDraftQueue('L1', s.api));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.players).toEqual([lamb]);
    act(() => result.current.add(chase));
    act(() => result.current.add(chase));
    expect(result.current.has('fx-chase')).toBe(true);
    act(() => result.current.move('fx-chase', -1));
    await waitFor(() => expect(s.ids()).toEqual(['fx-chase', 'fx-lamb']));
    act(() => result.current.remove('fx-lamb'));
    await waitFor(() => expect(s.ids()).toEqual(['fx-chase']));
    expect(s.calls.map((c) => c.path)).toEqual(Array(4).fill('/leagues/L1/draft/queue'));
  });

  it('uploads a queue this browser kept once, when the server queue is empty', async () => {
    localStorage.setItem('fantasy:draft-queue:L1', JSON.stringify([chase, { id: 1 }, lamb]));
    const s = server();
    const { result } = renderHook(() => useDraftQueue('L1', s.api));
    await waitFor(() => expect(result.current.players).toEqual([chase, lamb]));
    expect(s.calls[1]?.request).toEqual({ method: 'PUT', body: { playerIds: ['fx-chase', 'fx-lamb'] } });
    expect(readQueue('L1')).toEqual([]);
    // Next time the server has it, so nothing is uploaded again.
    const again = renderHook(() => useDraftQueue('L1', s.api));
    await waitFor(() => expect(again.result.current.players).toEqual([chase, lamb]));
    expect(s.calls.filter((c) => c.request.method === 'PUT')).toHaveLength(1);
  });

  it('keeps the server queue over a local one, and forgets the local one', async () => {
    localStorage.setItem('fantasy:draft-queue:L1', JSON.stringify([chase]));
    const s = server(['fx-lamb']);
    const { result } = renderHook(() => useDraftQueue('L1', s.api));
    await waitFor(() => expect(result.current.players).toEqual([lamb]));
    expect(s.calls.some((c) => c.request.method === 'PUT')).toBe(false);
    expect(readQueue('L1')).toEqual([]);
  });

  it('says why a load or save failed, and keeps a local queue it could not upload', async () => {
    localStorage.setItem('fantasy:draft-queue:L1', JSON.stringify([chase]));
    const s = server();
    s.fail.GET = 'api';
    const { result } = renderHook(() => useDraftQueue('L1', s.api));
    await waitFor(() => expect(result.current.error).toMatch(/do not manage a team/));
    expect(result.current.ready).toBe(false);
    act(() => result.current.add(lamb));
    expect(s.calls).toHaveLength(1);
    expect(readQueue('L1')).toEqual([chase]);
    const loaded = renderHook(() => useDraftQueue('L1', s.api));
    await waitFor(() => expect(loaded.result.current.ready).toBe(true));
    s.fail.PUT = 'api';
    act(() => loaded.result.current.add(lamb));
    await waitFor(() => expect(loaded.result.current.error).toMatch(/do not manage a team/));
    act(() => loaded.result.current.move(lamb.id, 0));
    await waitFor(() => expect(loaded.result.current.error).toBeNull());
    expect(s.ids()).toEqual(['fx-chase', 'fx-lamb']);
    s.fail.PUT = 'network';
    act(() => loaded.result.current.remove('fx-chase'));
    await waitFor(() => expect(loaded.result.current.error).toBe('Could not save your queue.'));
  });

  it('retries the queue on screen after a failed save, and reloads after a failed load', async () => {
    const s = server();
    s.fail.GET = 'network';
    const { result } = renderHook(() => useDraftQueue('L1', s.api));
    await waitFor(() => expect(result.current.error).toBe('Could not load your queue.'));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.error).toBeNull();
    // One player queued, and that one save fails: the screen keeps him, the server does not.
    s.fail.PUT = 'api';
    act(() => result.current.add(chase));
    await waitFor(() => expect(result.current.error).toMatch(/do not manage a team/));
    expect(result.current.players).toEqual([chase]);
    expect(s.ids()).toEqual([]);
    // Retrying sends that same queue, unchanged.
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.error).toBeNull());
    expect(s.ids()).toEqual(['fx-chase']);
    expect(s.calls.at(-1)?.request).toEqual({ method: 'PUT', body: { playerIds: ['fx-chase'] } });
  });

  it('reports saving until every queued change settles, including one that fails', async () => {
    const s = server(['fx-lamb']);
    const held: (() => void)[] = [];
    const slowPut = (async (...args: Parameters<ApiFetch>) => {
      if (args[1]?.method === 'PUT') await new Promise<void>((resolve) => held.push(resolve));
      return s.api(...args);
    }) as ApiFetch;
    const { result } = renderHook(() => useDraftQueue('L1', slowPut));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.saving).toBe(false);
    s.fail.PUT = 'api';
    act(() => result.current.add(chase));
    act(() => result.current.move('fx-chase', -1));
    expect(result.current.saving).toBe(true);
    await waitFor(() => expect(held).toHaveLength(1));
    act(() => held[0]!());
    await waitFor(() => expect(result.current.error).toMatch(/do not manage a team/));
    // The later change is still in flight, so the queue is still saving.
    expect(result.current.saving).toBe(true);
    await waitFor(() => expect(held).toHaveLength(2));
    act(() => held[1]!());
    await waitFor(() => expect(result.current.saving).toBe(false));
    expect(result.current.error).toBeNull();
    expect(s.ids()).toEqual(['fx-chase', 'fx-lamb']);
  });

  it('falls back to a plain message when the network fails, and ignores a load after unmount', async () => {
    const s = server();
    s.fail.GET = 'network';
    const { result } = renderHook(() => useDraftQueue('L1', s.api));
    await waitFor(() => expect(result.current.error).toBe('Could not load your queue.'));
    let release: () => void = () => undefined;
    const slow = (async (...args: Parameters<ApiFetch>) => {
      await new Promise<void>((resolve) => (release = resolve));
      return s.api(...args);
    }) as ApiFetch;
    const gone = renderHook(() => useDraftQueue('L1', slow));
    gone.unmount();
    release();
    await waitFor(() => expect(s.calls).toHaveLength(2));
    expect(gone.result.current.ready).toBe(false);
    const failing = server();
    failing.fail.GET = 'network';
    let releaseFail: () => void = () => undefined;
    const slowFail = (async (...args: Parameters<ApiFetch>) => {
      await new Promise<void>((resolve) => (releaseFail = resolve));
      return failing.api(...args);
    }) as ApiFetch;
    const goneFail = renderHook(() => useDraftQueue('L1', slowFail));
    goneFail.unmount();
    releaseFail();
    await waitFor(() => expect(failing.calls).toHaveLength(1));
    expect(goneFail.result.current.error).toBeNull();
  });

  it('ignores stored junk and a storage that refuses access', async () => {
    localStorage.setItem('fantasy:draft-queue:L1', '{bad');
    expect(readQueue('L1')).toEqual([]);
    localStorage.setItem('fantasy:draft-queue:L1', '{"not":"a list"}');
    expect(readQueue('L1')).toEqual([]);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const s = server(['fx-chase']);
    const { result } = renderHook(() => useDraftQueue('L1', s.api));
    await waitFor(() => expect(result.current.players).toEqual([chase]));
    expect(result.current.error).toBeNull();
  });
});
