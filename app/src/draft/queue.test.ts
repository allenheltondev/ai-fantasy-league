import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { move, readQueue, useDraftQueue } from './queue';

const chase = { id: 'fx-chase', name: "Ja'Marr Chase", team: 'CIN', position: 'WR' };
const lamb = { id: 'fx-lamb', name: 'CeeDee Lamb', team: 'DAL', position: 'WR' };

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

  it('keeps the queue per league in this browser', () => {
    const { result } = renderHook(() => useDraftQueue('L1'));
    act(() => result.current.add(chase));
    act(() => result.current.add(lamb));
    act(() => result.current.add(chase));
    expect(result.current.players.map((p) => p.id)).toEqual(['fx-chase', 'fx-lamb']);
    expect(result.current.has('fx-lamb')).toBe(true);
    act(() => result.current.move('fx-lamb', -1));
    expect(readQueue('L1').map((p) => p.id)).toEqual(['fx-lamb', 'fx-chase']);
    act(() => result.current.remove('fx-lamb'));
    expect(readQueue('L1')).toEqual([chase]);
    expect(readQueue('L2')).toEqual([]);
    expect(renderHook(() => useDraftQueue('L1')).result.current.players).toEqual([chase]);
  });

  it('ignores stored junk and a storage that refuses writes', () => {
    localStorage.setItem('fantasy:draft-queue:L1', '{bad');
    expect(readQueue('L1')).toEqual([]);
    localStorage.setItem('fantasy:draft-queue:L1', '{"not":"a list"}');
    expect(readQueue('L1')).toEqual([]);
    localStorage.setItem('fantasy:draft-queue:L1', JSON.stringify([chase, { id: 1 }, null]));
    expect(readQueue('L1')).toEqual([chase]);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full');
    });
    const { result } = renderHook(() => useDraftQueue('L1'));
    act(() => result.current.add(lamb));
    expect(result.current.players).toEqual([chase, lamb]);
  });
});
