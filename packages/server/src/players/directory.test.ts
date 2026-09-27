import { FixedClock } from '@fantasy/core';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../errors.js';
import { InMemoryPlayerRepository } from '../repos/memory.js';
import { PlayerDirectory } from './directory.js';
import { fixturePlayers } from './fixtures.js';

function setup() {
  const repo = new InMemoryPlayerRepository(fixturePlayers);
  const clock = new FixedClock('2026-09-10T12:00:00Z');
  const directory = new PlayerDirectory({ repo, clock, ttlMs: 60_000 });
  return { repo, clock, directory };
}

async function resolveError(directory: PlayerDirectory, selector: { playerId?: string; player?: string }) {
  try {
    await directory.resolve(selector);
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected resolve to fail');
}

describe('PlayerDirectory.resolve', () => {
  it.each([
    ['Christian McCaffrey', 'fx-cmc'],
    ['CMC', 'fx-cmc'],
    ['cmc', 'fx-cmc'],
    ['mccaffrey sf', 'fx-cmc'],
    ['McCaffrey', 'fx-cmc'],
    ['mccafrey', 'fx-cmc'],
    ['ARSB', 'fx-arsb'],
    ['amon-ra st. brown', 'fx-arsb'],
    ['aj brown', 'fx-ajbrown'],
    ['Marvin Harrison', 'fx-mhj'],
    ['Kenneth Walker III', 'fx-kwalker'],
    ['jamarr chase', 'fx-chase'],
    ['niners', 'fx-def-sf'],
    ['SF', 'fx-def-sf'],
    ['hill mia', 'fx-tyhill'],
    ['josh allen', 'fx-jallen']
  ])('resolves %s', async (name, id) => {
    const { directory } = setup();
    expect((await directory.resolve({ player: name })).id).toBe(id);
  });

  it('resolves ids, and prefers the id when both are given', async () => {
    const { directory } = setup();
    expect((await directory.resolve({ playerId: 'fx-lamb' })).name).toBe('CeeDee Lamb');
    expect((await directory.resolve({ playerId: 'fx-lamb', player: 'cmc' })).id).toBe('fx-lamb');
  });

  it('returns AMBIGUOUS_PLAYER with candidates in rank order', async () => {
    const { directory } = setup();
    const error = await resolveError(directory, { player: 'williams' });
    expect(error.code).toBe('AMBIGUOUS_PLAYER');
    expect(error.fix).toMatch(/playerId/);
    const candidates = error.details?.candidates as { id: string }[];
    expect(candidates.map((c) => c.id)).toEqual(['fx-kyrenw', 'fx-jamesonw', 'fx-javontew', 'fx-mikew']);
    expect(candidates[0]).toEqual({ id: 'fx-kyrenw', name: 'Kyren Williams', team: 'LAR', position: 'RB' });
    expect((await resolveError(directory, { player: 'josh' })).code).toBe('AMBIGUOUS_PLAYER');
    expect((await resolveError(directory, { player: 'hill' })).code).toBe('AMBIGUOUS_PLAYER');
  });

  it('returns PLAYER_NOT_FOUND with a fix', async () => {
    const { directory } = setup();
    const byName = await resolveError(directory, { player: 'Nobody Special' });
    expect(byName.code).toBe('PLAYER_NOT_FOUND');
    expect(byName.fix).toMatch(/search_players/);
    const byId = await resolveError(directory, { playerId: 'nope' });
    expect(byId.code).toBe('PLAYER_NOT_FOUND');
    expect(byId.details).toEqual({ playerId: 'nope' });
  });

  it('rejects a missing selector', async () => {
    const { directory } = setup();
    expect((await resolveError(directory, {})).code).toBe('INVALID_INPUT');
    expect((await resolveError(directory, { player: '   ' })).code).toBe('INVALID_INPUT');
  });
});

describe('PlayerDirectory.search', () => {
  it('limits and filters', async () => {
    const { directory } = setup();
    const wrs = await directory.search({ position: 'WR', limit: 3 });
    expect(wrs.map((p) => p.id)).toEqual(['fx-chase', 'fx-jjefferson', 'fx-lamb']);
    expect((await directory.search({ query: 'cmc', limit: 5 })).map((p) => p.id)).toEqual(['fx-cmc']);
  });

  it('caches the index until the TTL passes, and on invalidate', async () => {
    const { directory, repo, clock } = setup();
    const spy = vi.spyOn(repo, 'listIndex');
    await directory.search({ limit: 1 });
    clock.advance(59_000);
    await directory.search({ limit: 1 });
    expect(spy).toHaveBeenCalledTimes(1);
    clock.advance(2_000);
    await directory.search({ limit: 1 });
    expect(spy).toHaveBeenCalledTimes(2);
    directory.invalidate();
    await directory.search({ limit: 1 });
    expect(spy).toHaveBeenCalledTimes(3);
    expect(await directory.get('fx-cmc')).not.toBeNull();
  });

  it('uses a 10 minute TTL by default', async () => {
    const repo = new InMemoryPlayerRepository(fixturePlayers);
    const clock = new FixedClock('2026-09-10T12:00:00Z');
    const directory = new PlayerDirectory({ repo, clock });
    const spy = vi.spyOn(repo, 'listIndex');
    await directory.search({ limit: 1 });
    clock.advance(9 * 60_000);
    await directory.search({ limit: 1 });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
