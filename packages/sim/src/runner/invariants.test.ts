import { yahooDefaultSettings, type RosterPlayer } from '@fantasy/core';
import { describe, expect, it } from 'vitest';
import { freshArchive } from '../../test/helpers.js';
import type { LineupRecord, TeamView, Transaction } from '../engine/types.js';
import {
  archiveKickoffs,
  auditRead,
  checkFaabConserved,
  checkLineupLocks,
  checkNoSharedPlayers,
  checkRostersValid
} from './invariants.js';

const settings = yahooDefaultSettings(4);
const team = (id: string, roster: TeamView['roster'], faabRemaining = 100): TeamView => ({
  id,
  name: id,
  faabRemaining,
  roster
});
const universe = new Map<string, RosterPlayer>([
  ['qb', { playerId: 'qb', positions: ['QB'], status: 'active', nflTeam: 'KC' }],
  ['wr', { playerId: 'wr', positions: ['WR'], status: 'active', nflTeam: 'KC' }]
]);

describe('roster invariants', () => {
  it('accepts valid rosters and reports illegal slots, unknown players, and oversize rosters', () => {
    expect(checkRostersValid(settings, [team('a', [{ playerId: 'qb', slot: 'QB' }])], universe).ok).toBe(
      true
    );
    const bad = checkRostersValid(settings, [team('a', [{ playerId: 'wr', slot: 'QB' }])], universe);
    expect(bad.ok).toBe(false);
    expect(bad.violations[0]).toMatch(/INELIGIBLE_FOR_SLOT/);
    const unknown = checkRostersValid(settings, [team('a', [{ playerId: 'ghost', slot: 'QB' }])], universe);
    expect(unknown.ok).toBe(false);
    const big = Array.from({ length: 17 }, (_, i) => ({ playerId: `p${i}`, slot: 'BN' as const }));
    const huge = checkRostersValid(settings, [team('a', big)], new Map());
    expect(huge.violations.some((v) => /17 active players, limit 16/.test(v))).toBe(true);
  });

  it('finds a player on two rosters', () => {
    const one = team('a', [{ playerId: 'qb', slot: 'QB' }]);
    expect(checkNoSharedPlayers([one, team('b', [{ playerId: 'wr', slot: 'BN' }])]).ok).toBe(true);
    const shared = checkNoSharedPlayers([one, team('b', [{ playerId: 'qb', slot: 'BN' }])]);
    expect(shared.violations).toEqual(['qb is on a and b']);
  });
});

describe('checkFaabConserved', () => {
  const add = (teamId: string, cost: number): Transaction => ({
    seq: 1,
    type: 'waiver_add',
    at: '2025-09-10T00:00:00.000Z',
    week: 2,
    teamId,
    addPlayerId: 'x',
    dropPlayerId: null,
    cost
  });
  const pick: Transaction = {
    seq: 2,
    type: 'draft_pick',
    at: '',
    teamId: 'a',
    playerId: 'y',
    round: 1,
    overall: 1
  };

  it('holds when budgets minus winning bids equal what is left', () => {
    expect(
      checkFaabConserved(settings, [team('a', [], 88), team('b', [], 100)], [add('a', 12), pick]).ok
    ).toBe(true);
  });

  it('flags created or destroyed dollars and negative budgets', () => {
    const r = checkFaabConserved(
      settings,
      [team('a', [], 90), team('b', [], -5)],
      [add('a', 12), add('b', 105)]
    );
    expect(r.ok).toBe(false);
    expect(r.violations.join('\n')).toMatch(/a: budget 100 - spent 12 != remaining 90/);
    expect(r.violations.join('\n')).toMatch(/negative FAAB/);
    expect(r.violations.join('\n')).toMatch(/league FAAB/);
  });
});

describe('checkLineupLocks', () => {
  const kickoffOf = (id: string): number | null =>
    id === 'early' ? Date.parse('2025-09-07T17:00:00Z') : null;
  const rec = (at: string, week: number, lineup: LineupRecord['lineup']): LineupRecord => ({
    at,
    week,
    teamId: 'a',
    lineup
  });

  it('allows changes before kickoff and to players who never lock', () => {
    const history = [
      rec('2025-09-03T00:00:00Z', 1, [{ playerId: 'early', slot: 'BN' }]),
      rec('2025-09-07T16:59:00Z', 1, [{ playerId: 'early', slot: 'WR' }]),
      rec('2025-09-08T00:00:00Z', 1, [
        { playerId: 'early', slot: 'WR' },
        { playerId: 'bye', slot: 'WR' }
      ])
    ];
    expect(checkLineupLocks(history, kickoffOf).ok).toBe(true);
  });

  it('flags a locked player moved or dropped after kickoff', () => {
    const moved = [
      rec('2025-09-03T00:00:00Z', 1, [{ playerId: 'early', slot: 'WR' }]),
      rec('2025-09-07T18:00:00Z', 1, [{ playerId: 'early', slot: 'BN' }])
    ];
    const r = checkLineupLocks(moved, kickoffOf);
    expect(r.violations).toEqual(['a week 1: early moved WR -> BN at 2025-09-07T18:00:00Z, after kickoff']);
    const dropped = [moved[0]!, rec('2025-09-07T18:00:00Z', 1, [])];
    expect(checkLineupLocks(dropped, kickoffOf).violations[0]).toMatch(/WR -> dropped/);
    expect(checkLineupLocks(moved, kickoffOf, new Set([2])).ok).toBe(true);
  });
});

describe('auditRead', () => {
  it('flags projections captured after kickoff or served before capture, and stats or scores served early', async () => {
    const archive = await freshArchive();
    const kickoffOf = archiveKickoffs(archive);
    const w1 = archive.weeks[1]!;
    const player = Object.keys(w1.projections.lines)[0]!;
    const kickoff = kickoffOf(player, 1)!;
    const game = archive.schedule.find((g) => g.week === 1)!;
    const ok = auditRead(
      { method: 'getWeekProjections', asOf: w1.projections.capturedAt, week: 1, playerIds: [player] },
      archive,
      kickoffOf
    );
    expect(ok).toEqual([]);
    const early = auditRead(
      { method: 'getWeekProjections', asOf: '2025-01-01T00:00:00.000Z', week: 1, playerIds: [player] },
      archive,
      kickoffOf
    );
    expect(early.map((v) => v.name)).toEqual(['no_future_data']);
    w1.projections.capturedAt = new Date(kickoff).toISOString();
    const late = auditRead(
      { method: 'getWeekProjections', asOf: '2026-01-01T00:00:00.000Z', week: 1, playerIds: [player] },
      archive,
      kickoffOf
    );
    expect(late.map((v) => v.name)).toEqual(['pre_kickoff_projections']);
    const stats = auditRead(
      {
        method: 'getWeekStats',
        asOf: new Date(kickoff).toISOString(),
        week: 1,
        playerIds: [player, 'ghost']
      },
      archive,
      kickoffOf
    );
    expect(stats).toHaveLength(2);
    const schedule = auditRead(
      { method: 'getSchedule', asOf: game.kickoff, finalGameIds: [game.gameId, 'ghost'] },
      archive,
      kickoffOf
    );
    expect(schedule).toHaveLength(2);
    expect(auditRead({ method: 'getPlayers', asOf: game.kickoff }, archive, kickoffOf)).toEqual([]);
    expect(kickoffOf('nobody', 1)).toBeNull();
  });
});
