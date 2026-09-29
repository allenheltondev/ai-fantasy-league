import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetLastLeague, LAST_LEAGUE_KEY, readLastLeague, rememberLastLeague } from './lastLeague';

describe('the last league in storage (#212)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads nothing until a league is remembered, then that league', () => {
    expect(readLastLeague()).toBeNull();
    rememberLastLeague('L1');
    expect(localStorage.getItem(LAST_LEAGUE_KEY)).toBe('L1');
    expect(readLastLeague()).toBe('L1');
    rememberLastLeague('L2');
    expect(readLastLeague()).toBe('L2');
  });

  it('forgets it', () => {
    rememberLastLeague('L1');
    forgetLastLeague();
    expect(readLastLeague()).toBeNull();
  });

  it('treats an empty value as nothing', () => {
    localStorage.setItem(LAST_LEAGUE_KEY, '');
    expect(readLastLeague()).toBeNull();
  });

  it('gets by when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => rememberLastLeague('L1')).not.toThrow();
    expect(readLastLeague()).toBeNull();
    expect(() => forgetLastLeague()).not.toThrow();
  });
});
