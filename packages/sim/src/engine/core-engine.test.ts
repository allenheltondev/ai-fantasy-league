import { autopick, currentPick, isComplete, yahooDefaultSettings, type LineupEntry } from '@fantasy/core';
import { HistoricalDataProvider, InMemoryArchiveStore } from '@fantasy/data';
import { beforeEach, describe, expect, it } from 'vitest';
import { fixtureArchive } from '../../test/helpers.js';
import type { SimArchive } from '../archive/format.js';
import { toSeasonArchive } from '../archive/season-archive.js';
import { SimClock } from '../clock/sim-clock.js';
import { buildTimeline, type SimEvent } from '../clock/timeline.js';
import { AsOfGuardedProvider } from '../guard/guard.js';
import { toRosterPlayer } from '../players.js';
import { replaySettings } from '../runner/settings.js';
import { CoreOnlyEngine, EngineStateError, createCoreOnlyEngine } from './core-engine.js';

const TEAMS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const settings = replaySettings(8, 1, 4);

interface Harness {
  archive: SimArchive;
  clock: SimClock;
  engine: CoreOnlyEngine;
  data: AsOfGuardedProvider;
  event: (kind: SimEvent['kind'], week: number) => SimEvent;
}

async function harness(): Promise<Harness> {
  const archive = await fixtureArchive();
  const timeline = buildTimeline(archive.schedule, { weeks: [1, 2, 3, 4] });
  const clock = new SimClock(timeline);
  const data = new AsOfGuardedProvider(
    new HistoricalDataProvider(new InMemoryArchiveStore([toSeasonArchive(archive)])),
    clock
  );
  const engine = createCoreOnlyEngine({ clock, data, season: 2025 });
  const event = (kind: SimEvent['kind'], week: number): SimEvent =>
    timeline.find((e) => e.kind === kind && e.week === week) as SimEvent;
  return { archive, clock, engine, data, event };
}

async function create(h: Harness): Promise<void> {
  await h.engine.createLeague({
    leagueId: 'L',
    settings,
    teams: TEAMS.map((id) => ({ id, name: id.toUpperCase() })),
    draftOrder: TEAMS,
    seed: 'seed'
  });
}

/** Drafts every pick with core autopick over week-1 projections (points = sum of projected stats). */
async function draftAll(h: Harness): Promise<void> {
  h.clock.advanceTo(h.event('draft', 1).at);
  const players = (await h.data.getPlayers()).map(toRosterPlayer);
  const proj = await h.data.getWeekProjections(2025, 1);
  const rank = proj
    .map((l) => ({ id: l.playerId, pts: Object.values(l.stats).reduce((a, b) => a + b, 0) }))
    .sort((x, y) => y.pts - x.pts)
    .map((x) => x.id);
  for (let d = await h.engine.draft(); !isComplete(d); d = await h.engine.draft()) {
    const choice = autopick(d, players, rank, settings);
    const made = await h.engine.makeDraftPick(currentPick(d)!.teamId, choice!.playerId);
    expect(made.ok).toBe(true);
  }
}

describe('CoreOnlyEngine', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });

  it('refuses every operation before a league exists', async () => {
    await expect(h.engine.league()).rejects.toThrow(EngineStateError);
    await expect(h.engine.draft()).rejects.toThrow(/createLeague/);
  });

  it('validates league creation', async () => {
    const base = {
      leagueId: 'L',
      teams: TEAMS.map((id) => ({ id, name: id })),
      draftOrder: TEAMS,
      seed: 's'
    };
    await expect(h.engine.createLeague({ ...base, settings: yahooDefaultSettings(10) })).rejects.toThrow(
      /10 teams/
    );
    await expect(
      h.engine.createLeague({
        ...base,
        settings: { ...settings, schedule: { ...settings.schedule, startWeek: 3 } }
      })
    ).rejects.toThrow(EngineStateError);
    await expect(h.engine.createLeague({ ...base, settings, draftOrder: ['a', 'a'] })).rejects.toThrow(
      /exactly once/
    );
    const teams = [...base.teams.slice(0, 7), { id: 'a', name: 'dup' }];
    await expect(h.engine.createLeague({ ...base, teams, settings })).rejects.toThrow(/unique/);
  });

  it('creates a league with a schedule, budgets, and reverse-draft waiver order', async () => {
    await create(h);
    const league = await h.engine.league();
    expect(league).toMatchObject({ leagueId: 'L', phase: 'drafting', week: 1 });
    expect(league.teams.every((t) => t.faabRemaining === 100 && t.roster.length === 0)).toBe(true);
    expect(league.waiverOrder).toEqual([...TEAMS].reverse());
    expect(league.schedule.map((w) => w.week)).toEqual([1, 2]);
    expect(h.engine.kind).toBe('core-only');
  });

  it('runs the draft with the core rules and records each pick', async () => {
    await create(h);
    h.clock.advanceTo(h.event('draft', 1).at);
    expect((await h.engine.makeDraftPick('a', 'nobody')).ok).toBe(false);
    const someone = (await h.data.getWeekProjections(2025, 1))[0]!.playerId;
    const wrongTeam = await h.engine.makeDraftPick('b', someone);
    expect(wrongTeam.ok ? [] : wrongTeam.issues.map((i) => i.code)).toEqual(['NOT_YOUR_TURN']);
    const early = await h.engine.setLineup('a', 1, []);
    expect(early.ok ? '' : early.issues[0]?.code).toBe('WEEK_NOT_EDITABLE');
    const claim = await h.engine.submitWaiverClaim({
      teamId: 'a',
      addPlayerId: someone,
      bid: 0,
      priority: 1
    });
    expect(claim.ok ? '' : claim.issues[0]?.code).toBe('WAIVERS_CLOSED');
    await draftAll(h);
    const league = await h.engine.league();
    expect(league.phase).toBe('in_season');
    expect(league.teams.every((t) => t.roster.length === 16 && t.roster.every((e) => e.slot === 'BN'))).toBe(
      true
    );
    const tx = await h.engine.transactions();
    expect(tx).toHaveLength(128);
    expect(tx[0]).toMatchObject({
      type: 'draft_pick',
      teamId: 'a',
      round: 1,
      overall: 1,
      at: h.event('draft', 1).at
    });
    const after = await h.engine.makeDraftPick('a', someone);
    expect(after.ok ? '' : after.issues[0]?.code).toBe('DRAFT_COMPLETE');
  });

  describe('in season', () => {
    beforeEach(async () => {
      await create(h);
      await draftAll(h);
      h.clock.advanceTo(h.event('waiver_run', 1).at);
    });

    it('validates lineups and enforces locks from its clock', async () => {
      const roster = await h.engine.lineup('a', 1);
      const players = new Map((await h.data.getPlayers()).map((p) => [p.id, p]));
      const qb = roster.find((e) => players.get(e.playerId)?.position === 'QB')!;
      const wr = roster.find((e) => players.get(e.playerId)?.position === 'WR')!;
      expect((await h.engine.setLineup('zz', 1, [])).ok).toBe(false);
      const bad = await h.engine.setLineup('a', 1, [{ playerId: wr.playerId, slot: 'QB' }]);
      expect(bad.ok ? '' : bad.issues[0]?.code).toBe('INELIGIBLE_FOR_SLOT');
      const good = await h.engine.setLineup('a', 1, [{ playerId: qb.playerId, slot: 'QB' }]);
      expect(good.ok).toBe(true);
      if (good.ok) expect(good.warnings.some((w) => w.code === 'EMPTY_STARTER_SLOT')).toBe(true);
      expect((await h.engine.lineup('a', 1)).find((e) => e.playerId === qb.playerId)?.slot).toBe('QB');
      // Lineups carry forward to later weeks until changed.
      expect((await h.engine.lineup('a', 2)).find((e) => e.playerId === qb.playerId)?.slot).toBe('QB');

      const kickoff = h.archive.schedule.find(
        (g) =>
          g.week === 1 &&
          (g.homeTeam === players.get(qb.playerId)?.team || g.awayTeam === players.get(qb.playerId)?.team)
      )!.kickoff;
      h.clock.advanceTo(kickoff);
      const locked = await h.engine.setLineup('a', 1, [{ playerId: qb.playerId, slot: 'BN' }]);
      expect(locked.ok ? '' : locked.issues[0]?.code).toBe('PLAYER_LOCKED');
      const history = await h.engine.lineupHistory();
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ teamId: 'a', week: 1, at: h.event('waiver_run', 1).at });
      expect((await h.engine.setLineup('a', 7, [])).ok).toBe(false);
    });

    it('validates claims and resolves waivers with FAAB', async () => {
      const league = await h.engine.league();
      const rostered = new Set(league.teams.flatMap((t) => t.roster.map((e) => e.playerId)));
      const free = (await h.data.getWeekProjections(2025, 1))
        .map((l) => l.playerId)
        .filter((id) => !rostered.has(id));
      const [x, y] = free as [string, string];
      const mine = league.teams.find((t) => t.id === 'a')!.roster;
      const drop = mine[0]!.playerId;
      const codes = async (claim: Parameters<CoreOnlyEngine['submitWaiverClaim']>[0]): Promise<string> => {
        const r = await h.engine.submitWaiverClaim(claim);
        return r.ok ? 'ok' : (r.issues[0]?.code ?? '');
      };
      expect(await codes({ teamId: 'zz', addPlayerId: x, bid: 1, priority: 1 })).toBe('UNKNOWN_TEAM');
      expect(await codes({ teamId: 'a', addPlayerId: x, bid: 101, priority: 1 })).toBe('INVALID_BID');
      expect(await codes({ teamId: 'a', addPlayerId: x, bid: 1.5, priority: 1 })).toBe('INVALID_BID');
      expect(await codes({ teamId: 'a', addPlayerId: drop, bid: 1, priority: 1 })).toBe('PLAYER_UNAVAILABLE');
      expect(await codes({ teamId: 'a', addPlayerId: 'ghost', bid: 1, priority: 1 })).toBe(
        'PLAYER_UNAVAILABLE'
      );
      expect(await codes({ teamId: 'a', addPlayerId: x, dropPlayerId: 'ghost', bid: 1, priority: 1 })).toBe(
        'DROP_PLAYER_NOT_ON_ROSTER'
      );
      expect(await codes({ teamId: 'a', addPlayerId: x, dropPlayerId: drop, bid: 7, priority: 1 })).toBe(
        'ok'
      );
      const otherDrop = league.teams.find((t) => t.id === 'b')!.roster[0]!.playerId;
      expect(await codes({ teamId: 'b', addPlayerId: x, dropPlayerId: otherDrop, bid: 5, priority: 1 })).toBe(
        'ok'
      );
      expect(await codes({ teamId: 'b', addPlayerId: y, bid: 0, priority: 2 })).toBe('ok');

      const run = await h.engine.processWaivers(1);
      expect(run.awarded).toEqual([{ teamId: 'a', addPlayerId: x, dropPlayerId: drop, cost: 7 }]);
      expect(run.failed.map((f) => f.code).sort()).toEqual(['PLAYER_CLAIMED', 'ROSTER_FULL']);
      const after = await h.engine.league();
      const a = after.teams.find((t) => t.id === 'a')!;
      expect(a.faabRemaining).toBe(93);
      expect(a.roster.some((e) => e.playerId === x && e.slot === 'BN')).toBe(true);
      expect(a.roster.some((e) => e.playerId === drop)).toBe(false);
      expect(after.waiverOrder[after.waiverOrder.length - 1]).toBe('a');
      expect((await h.engine.transactions()).at(-1)).toMatchObject({ type: 'waiver_add', week: 1, cost: 7 });
      expect((await h.engine.processWaivers(1)).awarded).toEqual([]);
    });

    it('scores, finalizes, seeds the bracket, and crowns a champion', async () => {
      const lineups = new Map<string, LineupEntry[]>();
      for (const t of TEAMS) lineups.set(t, await h.engine.lineup(t, 1));
      for (const week of [1, 2, 3, 4]) {
        h.clock.advanceTo(h.event('games_final', week).at);
        const live = await h.engine.scoreWeek(week);
        expect(live.stage).toBe('live');
        h.clock.advanceTo(h.event('monday_night_final', week).at);
        const provisional = await h.engine.finalizeWeek(week, 'provisional');
        expect(provisional).toMatchObject({
          week,
          stage: 'provisional',
          kind: week <= 2 ? 'regular' : 'playoffs'
        });
        expect((await h.engine.league()).week).toBe(Math.min(week + 1, 4));
        h.clock.advanceTo(h.event('stat_correction', week).at);
        const official = await h.engine.finalizeWeek(week, 'official');
        expect(official.stage).toBe('official');
        expect(await h.engine.finalizeWeek(week, 'official')).toBe(official);
        if (week === 2) {
          const bracket = await h.engine.bracket();
          expect(bracket?.seeds).toHaveLength(4);
          expect((await h.engine.league()).phase).toBe('playoffs');
        }
        if (week <= 2) expect(official.matchups).toHaveLength(4);
        else expect(official.matchups).toHaveLength(week === 3 ? 2 : 1);
      }
      expect((await h.engine.standings()).map((r) => r.gamesPlayed)).toEqual(Array(8).fill(2));
      const champ = await h.engine.champion();
      expect(TEAMS).toContain(champ);
      expect((await h.engine.league()).phase).toBe('complete');
      expect((await h.engine.setLineup('a', 4, [])).ok).toBe(false);
    });
  });

  it('has no champion before the playoffs', async () => {
    await create(h);
    expect(await h.engine.champion()).toBeNull();
    expect(await h.engine.bracket()).toBeNull();
  });
});
