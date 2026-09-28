import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { ApiFetch, ApiRequest } from '../api/client';
import { useDraftQueue, type ServerDraftQueue } from './queue';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('preserves the existing server queue when a player is queued before GET finishes', async () => {
  const saved = { id: 'saved', name: 'Saved player', team: 'KC', position: 'WR' };
  const added = { id: 'added', name: 'Added player', team: 'BUF', position: 'RB' };
  let serverIds = [saved.id];
  const pending = deferred<{ data: ServerDraftQueue; league: null; warnings: [] }>();
  const api = (async (_path: string, request: ApiRequest = {}) => {
    if (request.method !== 'PUT') return pending.promise;
    serverIds = (request.body as { playerIds: string[] }).playerIds;
    return { data: {}, league: null, warnings: [] };
  }) as ApiFetch;
  const { result } = renderHook(() => useDraftQueue('audit', api));
  expect(result.current.ready).toBe(false);
  act(() => result.current.add(added));
  await act(async () => {
    pending.resolve({
      data: {
        teamId: 't1',
        maxSize: 50,
        updatedAt: null,
        players: [{ player: saved, rank: 1, available: true }]
      },
      league: null,
      warnings: []
    });
  });
  await waitFor(() => expect(result.current.ready).toBe(true));
  expect(serverIds).toContain(saved.id);
  expect(result.current.players.map((p) => p.id)).toEqual(serverIds);
});
