import { computeStandings, yahooDefaultSettings, type LeagueSettings } from '@fantasy/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { seedNflSchedule } from '../dev/season-demo.js';
import { InMemoryEventPublisher } from '../events/publisher.js';
import { newTeam } from '../league/seats.js';
import { silentLogger } from '../log.js';
import { fixturePlayers } from '../players/fixtures.js';
import { createInMemoryRepos } from '../repos/memory.js';
import { createInMemoryReferenceStore } from '../repos/memory-reference.js';
import type { ReferenceStore } from '../repos/reference.js';
import type { League, Repos, Team } from '../repos/types.js';
import type { WaiverClaimRecord } from '../repos/waivers.js';
import { weekLocks } from '../season/lineups.js';
import { processLeagueWaivers } from './process.js';
import { dropClearsAt, leaguePlayers } from './rosters.js';

/**
 * Season integrity in waiver processing (#111): locked drop players, drops through awards going on
 * waivers, game-time and post-draft waivers, a cancel racing the run, the reverse-standings
 * tiebreak, and IR slots in the roster limit. Week 5 of the demo NFL schedule: KC plays Thursday
 * night (2026-10-09 00:20 UTC), BUF on Sunday.
 */

/** Saturday of week 5, at the waiver run: KC players are locked, BUF players are not. */
const SATURDAY = new Date('2026-10-10T08:00:00.000Z');
const baseSettings = yahooDefaultSettings(4);
baseSettings.roster.slots = { QB: 1, RB: 1, BN: 1, IR: 1 };

function league(overrides: Partial<League> = {}, settings: LeagueSettings = baseSettings): League {
  return {
    id: 'lg',
    name: 'Integrity',
    season: 2026,
    phase: 'regular_season',
    week: 5,
    settings,
    commissionerId: 'u',
    commissionerName: 'U',
    createdBy: 'u',
    scheduleSeed: 's',
    deadlines: { draftStartsAt: null, nextLineupLockAt: null, nextWaiverRunAt: null, tradeDeadlineAt: null },
    createdAt: SATURDAY.toISOString(),
    updatedAt: SATURDAY.toISOString(),
    version: 1,
    ...overrides
  };
}

function claim(overrides: Partial<WaiverClaimRecord>): WaiverClaimRecord {
  return {
    id: 'c1',
    leagueId: 'lg',
    teamId: 't1',
    addPlayerId: 'fx-def-buf',
    dropPlayerId: null,
    bid: 10,
    priority: 1,
    status: 'pending',
    week: 5,
    processesAt: SATURDAY.toISOString(),
    createdAt: '2026-10-08T00:00:00.000Z',
    createdBy: 'test',
    resolvedAt: null,
    failure: null,
    cost: null,
    awardingRunId: null,
    version: 1,
    ...overrides
  };
}

let repos: Repos;
let reference: ReferenceStore;
let teams: Team[];

async function seed(rosters: string[][], lg: League = league()) {
  await repos.leagues.create(lg);
  teams = rosters.map((roster, i) => ({
    ...newTeam({ leagueId: 'lg', id: `t${i + 1}`, draftSlot: i + 1, settings: lg.settings, now: SATURDAY }),
    roster
  }));
  await repos.teams.create(teams);
  for (const team of teams) for (const p of team.roster) await repos.waivers.acquirePlayer('lg', p, team.id);
  return lg;
}

const run = (lg: League, now = SATURDAY) =>
  processLeagueWaivers(
    { repos, reference, events: new InMemoryEventPublisher(), log: silentLogger },
    lg,
    now
  );

beforeEach(async () => {
  repos = createInMemoryRepos({ players: fixturePlayers });
  reference = createInMemoryReferenceStore(repos.players);
  await seedNflSchedule(reference);
});

describe('where players stand', () => {
  it('holds a player whose game kicked off on waivers until the run after the week, and undrafted players after the draft', async () => {
    const lg = await seed([['fx-mahomes'], ['fx-jallen']], league({}));
    await repos.waivers.putWireEntry({
      leagueId: 'lg',
      playerId: 'fx-chase',
      droppedByTeamId: 't1',
      droppedAt: '2026-10-08T09:00:00.000Z',
      clearsAt: '2026-10-10T09:00:00.000Z'
    });
    const locks = await weekLocks(reference, lg, SATURDAY);
    const players = await leaguePlayers(repos, lg, teams, SATURDAY, locks);
    // Kelce's KC game was Thursday night; Monday night's game ends 2026-10-13 04:45 UTC.
    expect(players.standing('fx-kelce', 'KC')).toEqual({
      status: 'waivers',
      clearsAt: '2026-10-13T08:00:00.000Z',
      reason: 'game_time',
      droppedByTeamId: null
    });
    expect(players.standing('fx-def-buf', 'BUF')).toEqual({ status: 'free_agent' });
    expect(players.standing('fx-kelce')).toEqual({ status: 'free_agent' });
    // A drop's waiver period is rounded up to the run that processes the claims on him.
    expect(players.standing('fx-chase', 'CIN')).toMatchObject({
      reason: 'dropped',
      clearsAt: '2026-10-11T08:00:00.000Z',
      droppedByTeamId: 't1'
    });

    const afterDraft = {
      ...lg,
      deadlines: { ...lg.deadlines, postDraftWaiversUntil: '2026-10-11T08:00:00.000Z' }
    };
    const held = await leaguePlayers(repos, afterDraft, teams, SATURDAY);
    expect(held.standing('fx-def-buf', 'BUF')).toMatchObject({ status: 'waivers', reason: 'post_draft' });
    expect(held.standing('fx-mahomes')).toEqual({ status: 'rostered', teamId: 't1' });
    // With several reasons the latest end wins.
    expect(held.standing('fx-chase', 'CIN')).toMatchObject({ clearsAt: '2026-10-11T08:00:00.000Z' });
    const later = await leaguePlayers(repos, afterDraft, teams, new Date('2026-10-11T08:00:00.000Z'));
    expect(later.standing('fx-def-buf', 'BUF')).toEqual({ status: 'free_agent' });
  });

  it('has no waiver period at all when the league sets 0 days', () => {
    const settings = { ...baseSettings, waivers: { ...baseSettings.waivers, waiverPeriodDays: 0 } };
    expect(dropClearsAt(settings, SATURDAY)).toBeNull();
    expect(dropClearsAt(baseSettings, new Date('2026-10-10T09:00:00.000Z'))).toBe('2026-10-13T08:00:00.000Z');
  });
});

describe('processLeagueWaivers integrity', () => {
  it('fails a claim whose drop player is locked, and puts an award’s drop player on waivers', async () => {
    const lg = await seed([
      ['fx-mahomes', 'fx-cmc', 'fx-chase'],
      ['fx-jallen', 'fx-bijan', 'fx-lamb']
    ]);
    await repos.waivers.createClaim(claim({ bid: 20, dropPlayerId: 'fx-mahomes' }));
    await repos.waivers.createClaim(claim({ id: 'c2', teamId: 't2', dropPlayerId: 'fx-jallen' }));
    const result = await run(lg);
    expect(result).toMatchObject({ status: 'processed', awarded: 1, failed: 1 });
    expect(await repos.waivers.getClaim('lg', 'c1')).toMatchObject({
      status: 'failed',
      failure: { code: 'PLAYER_LOCKED', fix: expect.stringContaining('drop player') }
    });
    expect((await repos.teams.get('lg', 't1'))?.roster).toEqual(['fx-mahomes', 'fx-cmc', 'fx-chase']);
    expect((await repos.teams.get('lg', 't2'))?.roster).toEqual(['fx-bijan', 'fx-lamb', 'fx-def-buf']);
    const wire = await repos.waivers.listWire('lg');
    expect(wire).toEqual([
      expect.objectContaining({
        playerId: 'fx-jallen',
        droppedByTeamId: 't2',
        clearsAt: '2026-10-12T08:00:00.000Z'
      })
    ]);
  });

  it('skips a claim cancelled while the run was going, and picks up a reorder', async () => {
    const lg = await seed([['fx-cmc'], ['fx-bijan']]);
    await repos.waivers.createClaim(claim({}));
    await repos.waivers.createClaim(claim({ id: 'c2', teamId: 't2', addPlayerId: 'fx-chase' }));
    const stale = await repos.waivers.listClaims('lg', 'pending');
    // The team cancels c1 and the other team reorders c2 after the run read its claims.
    const c1 = (await repos.waivers.getClaim('lg', 'c1'))!;
    await repos.waivers.updateClaim({ ...c1, status: 'cancelled', resolvedAt: SATURDAY.toISOString() });
    const c2 = (await repos.waivers.getClaim('lg', 'c2'))!;
    await repos.waivers.updateClaim({ ...c2, priority: 2 });
    vi.spyOn(repos.waivers, 'listClaims').mockResolvedValueOnce(stale);

    const result = await run(lg);
    expect(result).toMatchObject({ status: 'processed', awarded: 1, failed: 0 });
    expect(await repos.waivers.getClaim('lg', 'c1')).toMatchObject({ status: 'cancelled' });
    expect(await repos.waivers.getClaim('lg', 'c2')).toMatchObject({ status: 'awarded', priority: 2 });
    expect((await repos.teams.get('lg', 't1'))?.roster).toEqual(['fx-cmc']);
    expect((await repos.teams.get('lg', 't2'))?.roster).toEqual(['fx-bijan', 'fx-chase']);
  });

  it('leaves a claim alone when it is cancelled before it is marked failed', async () => {
    const lg = await seed([['fx-cmc'], ['fx-bijan']]);
    await repos.waivers.createClaim(claim({ dropPlayerId: 'fx-nobody' }));
    const stale = await repos.waivers.listClaims('lg', 'pending');
    const c1 = (await repos.waivers.getClaim('lg', 'c1'))!;
    await repos.waivers.updateClaim({ ...c1, status: 'cancelled', resolvedAt: SATURDAY.toISOString() });
    vi.spyOn(repos.waivers, 'listClaims').mockResolvedValueOnce(stale);
    expect(await run(lg)).toMatchObject({ awarded: 0, failed: 0 });
    expect(await repos.waivers.getClaim('lg', 'c1')).toMatchObject({ status: 'cancelled' });
  });

  it('breaks a tied bid by reverse standings under faabTiebreak reverse_standings', async () => {
    const settings: LeagueSettings = {
      ...baseSettings,
      waivers: { ...baseSettings.waivers, faabTiebreak: 'reverse_standings' }
    };
    const lg = await seed([['fx-cmc'], ['fx-bijan']], league({}, settings));
    // t2 is first on the priority list, but t1 has the worse record.
    await repos.schedule.putStandings({
      leagueId: 'lg',
      week: 4,
      rows: computeStandings(
        settings,
        [{ week: 1, homeTeamId: 't2', awayTeamId: 't1', homeScore: 100, awayScore: 90 }],
        { teamIds: ['t1', 't2'] }
      ),
      computedAt: SATURDAY.toISOString()
    });
    await repos.waivers.createClaim(claim({ id: 'c2', teamId: 't2', createdAt: '2026-10-07T00:00:00.000Z' }));
    await repos.waivers.createClaim(claim({}));
    await run(lg);
    expect(await repos.waivers.getClaim('lg', 'c1')).toMatchObject({ status: 'awarded' });
    expect(await repos.waivers.getClaim('lg', 'c2')).toMatchObject({ failure: { code: 'PLAYER_CLAIMED' } });
  });

  it('does not count a player in an IR slot toward the roster limit', async () => {
    const lg = await seed([['fx-jallen', 'fx-cmc', 'fx-chase', 'fx-bijan'], []]);
    await repos.lineups.put([
      {
        leagueId: 'lg',
        teamId: 't1',
        week: 5,
        entries: [
          { playerId: 'fx-jallen', slot: 'QB' },
          { playerId: 'fx-cmc', slot: 'RB' },
          { playerId: 'fx-chase', slot: 'BN' },
          { playerId: 'fx-bijan', slot: 'IR' }
        ],
        updatedAt: SATURDAY.toISOString(),
        updatedBy: 'test'
      }
    ]);
    await repos.waivers.createClaim(claim({}));
    expect(await run(lg)).toMatchObject({ awarded: 0, failed: 1 });
    expect(await repos.waivers.getClaim('lg', 'c1')).toMatchObject({ failure: { code: 'ROSTER_FULL' } });

    const next = new Date('2026-10-11T08:00:00.000Z');
    await repos.lineups.put([
      {
        leagueId: 'lg',
        teamId: 't1',
        week: 5,
        entries: [
          { playerId: 'fx-jallen', slot: 'QB' },
          { playerId: 'fx-cmc', slot: 'IR' },
          { playerId: 'fx-chase', slot: 'BN' },
          { playerId: 'fx-bijan', slot: 'IR' }
        ],
        updatedAt: next.toISOString(),
        updatedBy: 'test'
      }
    ]);
    await repos.waivers.createClaim(claim({ id: 'c3' }));
    expect(await run(lg, next)).toMatchObject({ awarded: 1 });
  });
});
