import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentPrincipal } from '../../src/auth/principal.js';
import { registry } from '../../src/operations/index.js';
import { invokeTool } from '../../src/registry/invoke.js';
import { advanceSeason, scoreLiveWeek } from '../../src/jobs/season.js';
import { silentLogger } from '../../src/log.js';
import { createHarness, type Harness } from '../support/harness.js';
import { as, data, errorCode, type Caller } from '../support/league-client.js';
import { ALICE, BOB } from '../support/leagues.js';
import {
  MONDAY_KICKOFF,
  SEASON,
  SUNDAY_KICKOFF,
  THURSDAY_KICKOFF,
  seedNflSchedule,
  seedSeasonLeague
} from '../support/season.js';

/**
 * The season loop end to end over HTTP (dynalite): rosters and lineups with per-player locks,
 * live scoring from stored stats, the provisional final, and the rollover into week 2.
 * team-1 is Alice's, team-2 is an agent seat, team-3 is Bob's.
 */

const L = '/leagues/lg-season';
let h: Harness;
let alice: Caller;
let bob: Caller;

interface RosterRow {
  player: { id: string; name: string };
  slot: string;
  locked: boolean;
  onBye: boolean;
  byeWeek: number | null;
  kickoff: string | null;
  status: string;
  projectedPoints: number | null;
  points: number | null;
}

const slotOf = (players: RosterRow[], id: string) => players.find((p) => p.player.id === id)?.slot;
const warnings = (res: { body: unknown }) =>
  ((res.body as { warnings?: { code: string }[] }).warnings ?? []).map((w) => w.code);

beforeAll(async () => {
  h = await createHarness({ backend: 'dynamo', registry });
  alice = as(h, ALICE);
  bob = as(h, BOB);
  const deps = { repos: h.repos, reference: h.services.data.reference };
  await seedNflSchedule(deps.reference);
  await seedSeasonLeague(deps, { id: 'lg-season', owners: [ALICE, null, BOB] });
  await seedSeasonLeague(deps, {
    id: 'lg-setup',
    owners: [ALICE],
    overrides: { phase: 'setup', week: null },
    lineup: false
  });
  await deps.reference.projections.putSnapshot(
    { season: SEASON, week: 1, capturedAt: '2026-09-09T12:00:00.000Z', hash: 'season', count: 1 },
    [{ playerId: 'fx-cmc', season: SEASON, week: 1, stats: { rush_yd: 100, rush_td: 1 } }]
  );
});
afterAll(() => h.close());

describe('get_roster', () => {
  it('shows the saved lineup with bye weeks, kickoffs, projections, and no locks before kickoff', async () => {
    const res = await alice.get(`${L}/teams/team-1/roster`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const roster = data<{
      week: number;
      lineupSaved: boolean;
      players: RosterRow[];
      slots: { slot: string }[];
    }>(res);
    expect(roster).toMatchObject({ week: 1, lineupSaved: true });
    expect(roster.players[0]).toMatchObject({ slot: 'QB', player: { id: 'fx-jallen' } });
    expect(roster.slots.map((s) => s.slot)).toEqual([
      'QB',
      'WR',
      'RB',
      'TE',
      'W/R/T',
      'K',
      'DEF',
      'BN',
      'IR'
    ]);
    const walker = roster.players.find((p) => p.player.id === 'fx-kwalker');
    expect(walker).toMatchObject({ slot: 'BN', onBye: true, byeWeek: 1, kickoff: null, locked: false });
    const cmc = roster.players.find((p) => p.player.id === 'fx-cmc');
    expect(cmc).toMatchObject({
      kickoff: SUNDAY_KICKOFF,
      projectedPoints: 16,
      points: null,
      status: 'active'
    });
    expect(roster.players.every((p) => !p.locked)).toBe(true);
    expect(warnings(res)).toEqual(['EMPTY_STARTER_SLOT']);
  });

  it('carries nothing for a team that never saved a lineup: everyone starts on the bench', async () => {
    const res = await bob.get(`${L}/teams/team-2/roster?week=2`);
    const roster = data<{ lineupSaved: boolean; carriedFromWeek: number | null; players: RosterRow[] }>(res);
    expect(roster).toMatchObject({ lineupSaved: false, carriedFromWeek: null });
    expect(roster.players.every((p) => p.slot === 'BN')).toBe(true);
    expect(warnings(res)).toContain('EMPTY_STARTER_SLOT');
  });

  it('lists an empty roster without warnings, and a player missing from the universe on the bench', async () => {
    const empty = await bob.get(`${L}/teams/team-3/roster`);
    expect(data<{ players: unknown[] }>(empty).players).toEqual([]);
    expect(warnings(empty)).toEqual([]);
    const team = (await h.repos.teams.get('lg-season', 'team-2'))!;
    await h.repos.teams.update({ ...team, roster: [...team.roster, 'retired-guy'] });
    const roster = data<{ players: RosterRow[] }>(await bob.get(`${L}/teams/team-2/roster`));
    expect(roster.players.find((p) => p.player.id === 'retired-guy')).toMatchObject({
      slot: 'BN',
      status: 'na',
      byeWeek: null,
      player: { name: 'retired-guy', team: null }
    });
  });

  it('refuses weeks the league does not play and unknown teams', async () => {
    expect(errorCode(await alice.get(`${L}/teams/team-1/roster?week=18`))).toBe('INVALID_INPUT');
    expect(errorCode(await alice.get(`${L}/teams/team-9/roster`))).toBe('TEAM_NOT_FOUND');
  });
});

describe('set_lineup', () => {
  it('swaps players by id or name and reports what changed', async () => {
    const res = await alice.put(`${L}/teams/team-1/lineup`, {
      moves: [
        { playerId: 'fx-jallen', slot: 'BN' },
        { player: 'mahomes', slot: 'QB' }
      ]
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = data<{
      changed: { player: { id: string }; from: string; to: string }[];
      players: RosterRow[];
    }>(res);
    expect(body.changed).toEqual([
      expect.objectContaining({ player: expect.objectContaining({ id: 'fx-jallen' }), from: 'QB', to: 'BN' }),
      expect.objectContaining({ player: expect.objectContaining({ id: 'fx-mahomes' }), from: 'BN', to: 'QB' })
    ]);
    expect(slotOf(body.players, 'fx-mahomes')).toBe('QB');
    const roster = data<{ players: RosterRow[] }>(await alice.get(`${L}/teams/team-1/roster`));
    expect(slotOf(roster.players, 'fx-mahomes')).toBe('QB');
  });

  it('warns, but allows, starting a player on bye', async () => {
    const res = await alice.put(`${L}/teams/team-1/lineup`, {
      moves: [
        { playerId: 'fx-kwalker', slot: 'RB' },
        { playerId: 'fx-bijan', slot: 'BN' }
      ]
    });
    expect(res.status).toBe(200);
    expect(warnings(res)).toContain('STARTER_ON_BYE');
  });

  it('rejects illegal lineups with every problem and a fix, changing nothing', async () => {
    const ineligible = await alice.put(`${L}/teams/team-1/lineup`, {
      moves: [{ playerId: 'fx-kelce', slot: 'QB' }]
    });
    expect(ineligible.status).toBe(400);
    expect(ineligible.body).toMatchObject({
      error: {
        code: 'INVALID_LINEUP',
        fix: expect.stringContaining('Nothing was changed'),
        details: {
          issues: expect.arrayContaining([expect.objectContaining({ code: 'INELIGIBLE_FOR_SLOT' })])
        }
      }
    });
    const notMine = await alice.put(`${L}/teams/team-1/lineup`, {
      moves: [{ player: 'lamar jackson', slot: 'BN' }]
    });
    expect(notMine.body).toMatchObject({
      error: {
        code: 'INVALID_LINEUP',
        details: { issues: [expect.objectContaining({ code: 'PLAYER_NOT_ON_ROSTER' })] }
      }
    });
    const roster = data<{ players: RosterRow[] }>(await alice.get(`${L}/teams/team-1/roster`));
    expect(slotOf(roster.players, 'fx-kelce')).toBe('W/R/T');
  });

  it('resolves names among the roster first and reports ambiguity', async () => {
    const agent = agentPrincipal({ agentId: 'agent-team-2', teamId: 'team-2', leagueId: 'lg-season' });
    const call = (args: Record<string, unknown>, key: string) =>
      invokeTool({
        registry,
        services: h.services,
        principal: agent,
        name: 'set_lineup',
        args: { ...args, idempotencyKey: key }
      });
    const ambiguous = await call(
      { leagueId: 'lg-season', teamId: 'team-2', moves: [{ player: 'hill', slot: 'WR' }] },
      'season-amb-1-key'
    );
    expect(ambiguous.body).toMatchObject({ error: { code: 'AMBIGUOUS_PLAYER' } });
    const empty = await call(
      { leagueId: 'lg-season', teamId: 'team-2', moves: [{ slot: 'WR' }] },
      'season-amb-2-key'
    );
    expect(empty.body).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    const ok = await call(
      { leagueId: 'lg-season', teamId: 'team-2', moves: [{ player: 'tyreek', slot: 'WR' }] },
      'season-amb-3-key'
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const other = await call(
      { leagueId: 'lg-season', teamId: 'team-1', moves: [{ player: 'kelce', slot: 'BN' }] },
      'season-amb-4-key'
    );
    expect(other.body).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });

  it('lets only the owner set a lineup, only in season, only for weeks not over', async () => {
    const move = { moves: [{ playerId: 'fx-kelce', slot: 'BN' }] };
    expect(errorCode(await bob.put(`${L}/teams/team-1/lineup`, move))).toBe('FORBIDDEN');
    expect(errorCode(await alice.put('/leagues/lg-setup/teams/team-1/lineup', move))).toBe(
      'PHASE_NOT_ALLOWED'
    );
    expect(errorCode(await alice.put(`${L}/teams/team-1/lineup`, { ...move, week: 18 }))).toBe(
      'INVALID_INPUT'
    );
    const league = (await h.repos.leagues.get('lg-season'))!;
    const moved = await h.repos.leagues.update({ ...league, week: 2 });
    expect(errorCode(await alice.put(`${L}/teams/team-1/lineup`, { ...move, week: 1 }))).toBe(
      'INVALID_INPUT'
    );
    await h.repos.leagues.update({ ...moved, week: 1 });
  });

  it("locks each player at his own game's kickoff", async () => {
    h.clock.set(new Date(Date.parse(THURSDAY_KICKOFF) + 60_000));
    const roster = data<{ players: RosterRow[] }>(await alice.get(`${L}/teams/team-1/roster`));
    expect(roster.players.find((p) => p.player.id === 'fx-mahomes')).toMatchObject({ locked: true });
    expect(roster.players.find((p) => p.player.id === 'fx-jallen')).toMatchObject({ locked: false });

    const res = await alice.put(`${L}/teams/team-1/lineup`, {
      moves: [
        { playerId: 'fx-mahomes', slot: 'BN' },
        { playerId: 'fx-jallen', slot: 'QB' }
      ]
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: {
        code: 'PLAYER_LOCKED',
        message: expect.stringContaining('Patrick Mahomes'),
        fix: expect.stringContaining('Keep')
      }
    });
    // Unlocked players still move freely.
    const ok = await alice.put(`${L}/teams/team-1/lineup`, {
      moves: [
        { playerId: 'fx-kwalker', slot: 'BN' },
        { playerId: 'fx-bijan', slot: 'RB' }
      ]
    });
    expect(ok.status).toBe(200);
  });
});

describe('live scoring and the weekly cycle', () => {
  const jobDeps = () => ({
    repos: h.repos,
    reference: h.services.data.reference,
    events: h.events,
    log: silentLogger
  });
  const line = (playerId: string, stats: Record<string, number>) => ({
    playerId,
    season: SEASON,
    week: 1,
    stats,
    updatedAt: '2026-09-13T18:00:00.000Z'
  });

  it('scores starters only during a game window and emits Scores Updated', async () => {
    h.clock.set('2026-09-12T12:00:00.000Z');
    expect(await scoreLiveWeek(jobDeps(), h.clock)).toMatchObject({
      status: 'skipped',
      reason: 'outside_game_window'
    });

    await h.services.data.reference.stats.putLines([
      line('fx-mahomes', { pass_yd: 300, pass_td: 2 }),
      line('fx-jallen', { pass_yd: 400, pass_td: 5 }),
      line('fx-cmc', { rush_yd: 100, rush_td: 1 }),
      line('fx-lamar', { pass_yd: 200 })
    ]);
    h.clock.set(new Date(Date.parse(SUNDAY_KICKOFF) + 3_600_000));
    const before = h.events.events.length;
    expect(await scoreLiveWeek(jobDeps(), h.clock)).toMatchObject({ status: 'ok', live: 1, updated: 1 });
    const scored = h.events.events.slice(before).find((e) => e.detailType === 'Scores Updated');
    expect(scored?.detail).toMatchObject({ leagueId: 'lg-season', week: 1 });
    const matchups = await h.repos.schedule.listMatchups('lg-season', 1);
    const mine = matchups.find((m) => m.homeTeamId === 'team-1' || m.awayTeamId === 'team-1')!;
    // Mahomes 20 (the QB) + CMC 16; Josh Allen's 36 sit on the bench.
    const score = mine.homeTeamId === 'team-1' ? mine.homeScore : mine.awayScore;
    expect(score).toBe(36);
    expect(mine.status).toBe('in_progress');

    // Nothing changed: no event.
    const again = h.events.events.length;
    expect(await scoreLiveWeek(jobDeps(), h.clock)).toMatchObject({ updated: 0 });
    expect(h.events.events.length).toBe(again);
  });

  it('shows both lineups with live points in get_matchup', async () => {
    await h.services.data.reference.stats.putLines([line('fx-cmc', { rush_yd: 150, rush_td: 1 })]);
    const res = await alice.get(`${L}/matchup`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = data<{
      matchup: { home: { teamId: string; score: number }; away: { teamId: string; score: number } };
      lineups: { home: { teamId: string; points: number; players: RosterRow[] } };
    }>(res);
    const side = body.matchup.home.teamId === 'team-1' ? body.matchup.home : body.matchup.away;
    expect(side.score).toBe(41);
    const lineup =
      body.lineups.home.teamId === 'team-1'
        ? body.lineups.home
        : (body as never as { lineups: { away: { points: number } } }).lineups.away;
    expect(lineup.points).toBe(41);
  });

  it('finalizes the week after Monday night and rolls over to week 2', async () => {
    h.clock.set(new Date(Date.parse(MONDAY_KICKOFF) + 60 * 60_000));
    expect(await advanceSeason(jobDeps(), h.clock)).toMatchObject({ skipped: 1 });

    h.clock.set(new Date(Date.parse(MONDAY_KICKOFF) + 5 * 60 * 60_000));
    const before = h.events.events.length;
    expect(await advanceSeason(jobDeps(), h.clock)).toMatchObject({ rolled_over: 1, failed: 0 });
    const emitted = h.events.events.slice(before);
    expect(emitted.map((e) => e.detailType)).toEqual([
      'Week Provisionally Final',
      'Week Rolled Over',
      'Schedule Event',
      'Schedule Event',
      'Schedule Event',
      'Schedule Event'
    ]);
    expect(emitted[1]?.detail).toMatchObject({
      leagueId: 'lg-season',
      fromWeek: 1,
      week: 2,
      phase: 'regular_season'
    });
    expect(emitted[2]?.detail).toMatchObject({
      name: 'lineup-lock-lg-season-W02-1',
      event: { detailType: 'Lineup Lock Approaching', detail: { leagueId: 'lg-season', week: 2 } }
    });

    const league = await h.repos.leagues.get('lg-season');
    expect(league).toMatchObject({ week: 2, phase: 'regular_season' });
    expect(league?.deadlines.nextLineupLockAt).toBe('2026-09-18T00:20:00.000Z');
    expect((await h.repos.schedule.listMatchups('lg-season', 1)).every((m) => m.status === 'final')).toBe(
      true
    );

    const standings = data<{ throughWeek: number; standings: { teamId: string; wins: number }[] }>(
      await alice.get(`${L}/standings`)
    );
    expect(standings.throughWeek).toBe(1);
    expect(standings.standings).toHaveLength(4);

    const week2 = data<{ lineupSaved: boolean; players: RosterRow[] }>(
      await alice.get(`${L}/teams/team-1/roster`)
    );
    expect(week2.lineupSaved).toBe(true);
    expect(slotOf(week2.players, 'fx-mahomes')).toBe('QB');

    // A second run finds week 2 in progress and does nothing.
    expect(await advanceSeason(jobDeps(), h.clock)).toMatchObject({ skipped: 1 });
  });
});

describe('a draft that ran into the season (void weeks)', () => {
  it('scores nothing before the first week and leaves it out of the standings', async () => {
    const deps = { repos: h.repos, reference: h.services.data.reference };
    await seedSeasonLeague(deps, { id: 'lg-mid', owners: [ALICE, null, BOB], overrides: { week: 3 } });
    // Stats exist for week 1, but the league began in week 3.
    await deps.reference.stats.putLines([
      {
        playerId: 'fx-jallen',
        season: SEASON,
        week: 1,
        stats: { pass_td: 3 },
        updatedAt: '2026-09-13T20:00:00.000Z'
      }
    ]);
    h.clock.set('2026-09-24T12:00:00.000Z');
    const week1 = await alice.get('/leagues/lg-mid/matchup?week=1');
    expect(warnings(week1)).toEqual(['WEEK_VOID']);
    const side = data<{ matchup: { home: { score: number | null }; away: { score: number | null } } }>(week1);
    expect([side.matchup.home.score, side.matchup.away.score]).toEqual([null, null]);

    const jobDeps = { ...deps, events: h.events, log: silentLogger };
    h.clock.set(new Date(Date.parse(MONDAY_KICKOFF) + 2 * 7 * 86_400_000 + 5 * 3_600_000));
    await advanceSeason(jobDeps, h.clock);
    expect(await h.repos.leagues.get('lg-mid')).toMatchObject({ week: 4 });
    const standings = data<{ throughWeek: number; standings: { record: string }[] }>(
      await alice.get('/leagues/lg-mid/standings')
    );
    expect(standings.throughWeek).toBe(3);
    // One game each: only week 3 counted.
    const games = (record: string) => record.split('-').reduce((sum, n) => sum + Number(n), 0);
    expect(standings.standings.every((r) => games(r.record) === 1)).toBe(true);
    const voided = await h.repos.schedule.listMatchups('lg-mid', 1);
    expect(voided.every((m) => m.status === 'scheduled' && m.homeScore === null)).toBe(true);
  });
});
