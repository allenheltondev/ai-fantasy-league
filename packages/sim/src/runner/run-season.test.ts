import { beforeAll, describe, expect, it } from 'vitest';
import { fixtureArchive } from '../../test/helpers.js';
import type { SimArchive } from '../archive/format.js';
import { buildTimeline } from '../clock/timeline.js';
import { CoreOnlyEngine } from '../engine/core-engine.js';
import type { EngineEnv } from '../engine/types.js';
import { scriptedPolicy } from '../policy/scripted.js';
import type { TeamPolicy } from '../policy/types.js';
import { INVARIANT_NAMES } from './invariants.js';
import { SimulationError, runSeason, type SeasonReport, type SimTeam } from './run-season.js';
import { formatSummary } from './summary.js';

const teams = (policy: () => TeamPolicy = () => scriptedPolicy()): SimTeam[] =>
  Array.from({ length: 8 }, (_, i) => ({ id: `team-${i + 1}`, policy: policy() }));

describe('runSeason on the fixture archive (8 scripted teams, 4 weeks)', () => {
  let archive: SimArchive;
  let report: SeasonReport;
  const logs: string[] = [];

  beforeAll(async () => {
    archive = await fixtureArchive();
    report = await runSeason({
      archive,
      teams: teams(),
      seed: 'fixture',
      weeks: 4,
      log: (l) => logs.push(l)
    });
  });

  it('plays the draft, the regular season, and the playoffs to a champion', () => {
    expect(report.settings).toEqual({
      teamCount: 8,
      startWeek: 1,
      regularSeasonEndWeek: 2,
      playoffWeeks: [3, 4],
      faabBudget: 100
    });
    expect(report.engine).toBe('core-only');
    expect(report.teams.map((t) => t.policy)).toEqual(Array(8).fill('scripted'));
    expect(report.transactions.filter((t) => t.type === 'draft_pick')).toHaveLength(128);
    expect(report.weeks.map((w) => [w.week, w.kind])).toEqual([
      [1, 'regular'],
      [2, 'regular'],
      [3, 'playoffs'],
      [4, 'playoffs']
    ]);
    for (const w of report.weeks.slice(0, 2)) expect(w.matchups).toHaveLength(4);
    expect(report.weeks[2]?.matchups).toHaveLength(2);
    expect(report.weeks[3]?.matchups).toHaveLength(1);
    const final = report.weeks[3]!.matchups[0]!;
    expect(report.champion).toBe(
      final.winnerTeamId ??
        report.bracket?.games.find((g) => g.id === report.bracket?.finalGameId)?.winnerTeamId ??
        null
    );
    expect(report.standings).toHaveLength(8);
    expect(report.standings.every((r) => r.gamesPlayed === 2)).toBe(true);
    for (const w of report.weeks) {
      for (const points of Object.values(w.teamPoints)) expect(points).toBeGreaterThan(20);
    }
    expect(report.events).toBe(buildTimeline(archive.schedule, { weeks: [1, 2, 3, 4] }).length);
    expect(logs).toHaveLength(4);
  });

  it('checks every invariant every week, and they all hold', () => {
    expect(report.violations).toEqual([]);
    expect(report.rejected).toEqual([]);
    for (const week of report.weeks) {
      expect(week.invariants.map((i) => i.name)).toEqual([...INVARIANT_NAMES]);
      expect(week.invariants.every((i) => i.ok)).toBe(true);
    }
    expect(report.dataAccess.futureAccessAttempts).toBe(0);
    expect(report.dataAccess.byMethod.getWeekProjections).toBeGreaterThan(0);
    expect(report.dataAccess.reads).toBeGreaterThan(100);
  });

  it('runs waivers with FAAB, conserving every dollar', () => {
    const adds = report.transactions.filter((t) => t.type === 'waiver_add');
    expect(adds.length).toBeGreaterThan(0);
    const spent = adds.reduce((s, t) => s + (t.type === 'waiver_add' ? t.cost : 0), 0);
    const left = Object.values(report.finalFaab).reduce((a, b) => a + b, 0);
    expect(spent + left).toBe(800);
  });

  it('is deterministic: the same seed gives an identical report, another seed a different one', async () => {
    const again = await runSeason({ archive, teams: teams(), seed: 'fixture', weeks: 4 });
    expect(again).toEqual(report);
    expect(JSON.stringify(again)).toBe(JSON.stringify(report));
    const other = await runSeason({ archive, teams: teams(), seed: 'another', weeks: 4 });
    expect(other.draftOrder).not.toEqual(report.draftOrder);
  });

  it('plays identically with anonymized player names (decisions use ids, never names)', async () => {
    const masked = await runSeason({
      archive,
      teams: teams(),
      seed: 'fixture',
      weeks: 4,
      anonymizePlayers: true
    });
    expect(masked).toEqual(report);
  });

  it('summarizes the season', () => {
    const text = formatSummary(report);
    expect(text).toContain(`Champion: ${report.champion}`);
    expect(text).toContain('Invariants: all held across 4 weeks');
    expect(text).toMatch(/Week {2}3 playoffs/);
    const broken = formatSummary({
      ...report,
      champion: null,
      rejected: [{ week: 1, teamId: 'team-1', action: 'set_lineup', codes: ['PLAYER_LOCKED'] }],
      violations: [{ week: 2, name: 'faab_conserved', message: 'boom' }],
      weeks: report.weeks.map((w) => ({ ...w, invariants: w.invariants.map((i) => ({ ...i, ok: false })) }))
    });
    expect(broken).toContain('Champion: none');
    expect(broken).toContain('Refused actions: 1 (PLAYER_LOCKED)');
    expect(broken).toContain('week 2 faab_conserved: boom');
    expect(broken).toContain('FAILED: rosters_valid');
  });
});

describe('runSeason options and failures', () => {
  let archive: SimArchive;
  beforeAll(async () => {
    archive = await fixtureArchive();
  });

  it('supports a mid-season start (draft right before the start week)', async () => {
    const report = await runSeason({ archive, teams: teams(), seed: 'mid', startWeek: 2 });
    expect(report.settings).toMatchObject({ startWeek: 2, regularSeasonEndWeek: 3, playoffWeeks: [4] });
    expect(report.weeks.map((w) => w.week)).toEqual([2, 3, 4]);
    expect(report.violations).toEqual([]);
    expect(report.champion).not.toBeNull();
    const week1End = Math.max(
      ...archive.schedule.filter((g) => g.week === 1).map((g) => Date.parse(g.kickoff))
    );
    expect(Date.parse(report.transactions[0]!.at)).toBeGreaterThan(week1End);
  });

  it('runs behind any engine factory (the port the server engine will implement)', async () => {
    const created: string[] = [];
    const engine = (env: EngineEnv): CoreOnlyEngine => {
      created.push(env.clock.now().toISOString());
      return new CoreOnlyEngine(env);
    };
    const report = await runSeason({ archive, teams: teams(), seed: 'port', weeks: 4, engine });
    expect(created).toHaveLength(1);
    expect(report.violations).toEqual([]);
  });

  it('refuses weeks the archive does not have', async () => {
    await expect(runSeason({ archive, teams: teams(), seed: 's', weeks: 6 })).rejects.toThrow(
      SimulationError
    );
    await expect(runSeason({ archive, teams: teams(), seed: 's', startWeek: 9 })).rejects.toThrow(
      /not all available/
    );
  });

  it('refuses settings that leave no season', async () => {
    const base = (await import('./settings.js')).replaySettings(8, 1, 4);
    const settings = { ...base, schedule: { ...base.schedule, startWeek: 3 } };
    await expect(runSeason({ archive, teams: teams(), seed: 's', weeks: 4, settings })).rejects.toThrow(
      SimulationError
    );
  });

  it('stops on a bot that makes no pick or an illegal pick', async () => {
    const lazy: TeamPolicy = { ...scriptedPolicy(), name: 'lazy', draftPick: () => null };
    await expect(runSeason({ archive, teams: teams(() => lazy), seed: 's', weeks: 4 })).rejects.toThrow(
      /made no pick/
    );
    const greedy: TeamPolicy = { ...scriptedPolicy(), name: 'greedy', draftPick: () => 'not-a-player' };
    await expect(runSeason({ archive, teams: teams(() => greedy), seed: 's', weeks: 4 })).rejects.toThrow(
      /refused/
    );
  });

  it('has the engine refuse a bot that tries to move a locked player, so locks still hold', async () => {
    const scripted = scriptedPolicy();
    const calls = new Map<string, number>();
    const flipFlop: TeamPolicy = {
      ...scripted,
      name: 'flip-flop',
      lineup: async (ctx) => {
        const n = (calls.get(ctx.teamId) ?? 0) + 1;
        calls.set(ctx.teamId, n);
        // Alternate between benching everyone and the optimal lineup (ignoring locks), so some change
        // eventually lands on a player whose game has already kicked off.
        const best = await scripted.lineup({ ...ctx, currentLineup: [] });
        return n % 2 === 0 ? ctx.currentLineup.map((e) => ({ ...e, slot: 'BN' as const })) : best;
      }
    };
    const report = await runSeason({ archive, teams: teams(() => flipFlop), seed: 's', weeks: 4 });
    const locked = report.rejected.filter((r) => r.action === 'set_lineup');
    expect(locked.length).toBeGreaterThan(0);
    expect(locked[0]?.codes).toContain('PLAYER_LOCKED');
    expect(report.violations).toEqual([]);
  });

  it('records refused waiver claims', async () => {
    const scripted = scriptedPolicy();
    const overbid: TeamPolicy = {
      ...scripted,
      name: 'overbid',
      waiverClaims: (ctx) => [{ addPlayerId: ctx.roster[0]!.playerId, dropPlayerId: null, bid: 1000 }]
    };
    const report = await runSeason({ archive, teams: teams(() => overbid), seed: 's', weeks: 4 });
    expect(report.rejected.some((r) => r.action === 'claim_waiver' && r.codes.includes('INVALID_BID'))).toBe(
      true
    );
    expect(report.violations).toEqual([]);
  });
});
