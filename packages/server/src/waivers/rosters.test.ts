import { FixedClock, yahooDefaultSettings } from '@fantasy/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryEventPublisher } from '../events/publisher.js';
import { processWaivers } from '../jobs/process-waivers.js';
import { newTeam } from '../league/seats.js';
import { silentLogger } from '../log.js';
import { staleTeam } from '../repos/errors.js';
import { createInMemoryRepos } from '../repos/memory.js';
import { createInMemoryReferenceStore } from '../repos/memory-reference.js';
import type { ReferenceStore } from '../repos/reference.js';
import type { League, Repos, Team } from '../repos/types.js';
import type { WaiverClaimRecord } from '../repos/waivers.js';
import { processLeagueWaivers } from './process.js';
import { acquisitionsThisWeek, changeRoster, leaguePlayers, openSpots } from './rosters.js';

const NOW = new Date('2026-10-07T08:00:00.000Z');
const settings = yahooDefaultSettings(4);
settings.roster.slots = { QB: 1, RB: 1, BN: 1 };

function league(overrides: Partial<League> = {}): League {
  return {
    id: 'lg',
    name: 'Unit',
    season: 2026,
    phase: 'regular_season',
    week: 5,
    settings,
    commissionerId: 'u',
    commissionerName: 'U',
    createdBy: 'u',
    scheduleSeed: 's',
    deadlines: { draftStartsAt: null, nextLineupLockAt: null, nextWaiverRunAt: null, tradeDeadlineAt: null },
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    version: 1,
    ...overrides
  };
}

function claim(overrides: Partial<WaiverClaimRecord>): WaiverClaimRecord {
  return {
    id: 'c1',
    leagueId: 'lg',
    teamId: 't1',
    addPlayerId: 'p9',
    dropPlayerId: null,
    bid: 10,
    priority: 1,
    status: 'pending',
    week: 5,
    processesAt: NOW.toISOString(),
    createdAt: '2026-10-05T00:00:00.000Z',
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
beforeEach(async () => {
  repos = createInMemoryRepos();
  reference = createInMemoryReferenceStore(repos.players);
  await repos.leagues.create(league());
  teams = [1, 2].map((slot) => ({
    ...newTeam({ leagueId: 'lg', id: `t${slot}`, draftSlot: slot, settings, now: NOW }),
    roster: slot === 1 ? ['p1'] : ['p2', 'p3']
  }));
  await repos.teams.create(teams);
});

describe('changeRoster', () => {
  it('reclaims a lock held by a team that no longer rosters the player', async () => {
    await repos.waivers.acquirePlayer('lg', 'p5', 't2');
    const updated = await changeRoster(repos, teams[0] as Team, { add: 'p5' }, NOW);
    expect(updated.roster).toEqual(['p1', 'p5']);
    expect(await repos.waivers.playerOwner('lg', 'p5')).toBe('t1');
  });

  it('refuses a player whose lock is held by the team rostering him', async () => {
    await repos.waivers.acquirePlayer('lg', 'p2', 't2');
    await expect(changeRoster(repos, teams[0] as Team, { add: 'p2' }, NOW)).rejects.toMatchObject({
      code: 'PLAYER_NOT_AVAILABLE'
    });
  });

  it('retries against the latest team after a concurrent write, and releases on failure', async () => {
    const stale = teams[0] as Team;
    await repos.teams.update({ ...stale, name: 'Renamed' });
    const updated = await changeRoster(repos, stale, { add: 'p7' }, NOW);
    expect(updated).toMatchObject({ name: 'Renamed', roster: ['p1', 'p7'] });

    await expect(changeRoster(repos, updated, { add: 'p8', drop: 'p99' }, NOW)).rejects.toMatchObject({
      code: 'PLAYER_NOT_ON_ROSTER'
    });
    expect(await repos.waivers.playerOwner('lg', 'p8')).toBeNull();
    await expect(changeRoster(repos, updated, { add: 'p8', cost: 500 }, NOW)).rejects.toMatchObject({
      code: 'INSUFFICIENT_FAAB'
    });
    expect(await repos.waivers.playerOwner('lg', 'p8')).toBeNull();
  });

  it('gives up after repeated conflicts and on unexpected errors', async () => {
    const team = teams[0] as Team;
    const update = vi.spyOn(repos.teams, 'update');
    update.mockRejectedValue(new Error('boom'));
    await expect(changeRoster(repos, team, { add: 'p6' }, NOW)).rejects.toThrow('boom');
    expect(await repos.waivers.playerOwner('lg', 'p6')).toBeNull();
    update.mockRejectedValue(staleTeam('t1'));
    await expect(changeRoster(repos, team, { add: 'p6' }, NOW)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(update).toHaveBeenCalledTimes(5);
  });
});

describe('league standings and limits', () => {
  it('reports rostered, waivers, and free agents, and open spots', async () => {
    await repos.waivers.putWireEntry({
      leagueId: 'lg',
      playerId: 'p8',
      droppedByTeamId: 't1',
      droppedAt: NOW.toISOString(),
      clearsAt: '2026-10-09T08:00:00.000Z'
    });
    const players = await leaguePlayers(repos, league(), teams, NOW);
    expect(players.standing('p2')).toEqual({ status: 'rostered', teamId: 't2' });
    expect(players.standing('p8')).toMatchObject({ status: 'waivers', clearsAt: '2026-10-09T08:00:00.000Z' });
    expect(players.standing('p0')).toEqual({ status: 'free_agent' });
    const lineup = [
      { playerId: 'p2', slot: 'QB' as const },
      { playerId: 'p3', slot: 'IR' as const }
    ];
    expect(openSpots(settings, lineup, null)).toBe(2);
    expect(openSpots(settings, lineup, 'p2')).toBe(3);
    // Dropping an IR player frees no active spot.
    expect(openSpots(settings, lineup, 'p3')).toBe(2);
  });

  it('counts adds and waiver awards in the current week only', async () => {
    const base = {
      leagueId: 'lg',
      teamId: 't1',
      addPlayerId: 'p1',
      dropPlayerId: null,
      cost: null,
      claimId: null
    };
    await repos.waivers.addTransactions([
      { ...base, id: 'a', at: '2026-10-06T00:00:00.000Z', week: 5, type: 'add' },
      { ...base, id: 'b', at: '2026-10-06T00:00:01.000Z', week: 5, type: 'drop' },
      { ...base, id: 'c', at: '2026-10-01T00:00:00.000Z', week: 4, type: 'add' }
    ]);
    expect(await acquisitionsThisWeek(repos, league(), NOW)).toEqual(new Map([['t1', 1]]));
    expect(await acquisitionsThisWeek(repos, league({ week: null }), NOW)).toEqual(new Map());
  });
});

describe('processLeagueWaivers recovery', () => {
  it('marks an award an interrupted run already applied without charging twice', async () => {
    await repos.teams.update({ ...(teams[0] as Team), roster: ['p1', 'p9'], faabRemaining: 90 });
    await repos.waivers.createClaim(claim({ awardingRunId: '2026-10-07' }));
    await repos.waivers.createClaim(
      claim({
        id: 'c2',
        teamId: 't2',
        addPlayerId: 'p4',
        dropPlayerId: 'p99',
        createdAt: '2026-10-05T00:00:01.000Z'
      })
    );
    const events = new InMemoryEventPublisher();
    const result = await processLeagueWaivers({ repos, reference, events, log: silentLogger }, league(), NOW);
    expect(result).toMatchObject({ status: 'processed', awarded: 1, failed: 1 });
    expect((await repos.teams.get('lg', 't1'))?.faabRemaining).toBe(90);
    expect(await repos.waivers.getClaim('lg', 'c1')).toMatchObject({ status: 'awarded', cost: 10 });
    expect(await repos.waivers.getClaim('lg', 'c2')).toMatchObject({
      status: 'failed',
      failure: { code: 'DROP_PLAYER_NOT_ON_ROSTER' }
    });
    const page = await repos.waivers.listTransactions('lg', { limit: 5 });
    expect(page.items).toMatchObject([{ id: 'c1', type: 'waiver_claim', at: '2026-10-07T08:00:00.000Z' }]);
  });

  it('fails an award whose roster write is refused', async () => {
    await repos.waivers.createClaim(claim({ addPlayerId: 'p9' }));
    await repos.waivers.acquirePlayer('lg', 'p9', 't2');
    await repos.teams.update({ ...(teams[1] as Team), roster: ['p2', 'p9'] });
    // The standings snapshot says p9 is free; the lock says t2 has him.
    const spy = vi.spyOn(repos.teams, 'list').mockResolvedValueOnce(teams);
    const result = await processLeagueWaivers(
      { repos, reference, events: new InMemoryEventPublisher(), log: silentLogger },
      league(),
      NOW
    );
    spy.mockRestore();
    expect(result).toMatchObject({ awarded: 0, failed: 1 });
    expect(await repos.waivers.getClaim('lg', 'c1')).toMatchObject({
      failure: { code: 'PLAYER_NOT_AVAILABLE' }
    });
  });
});

describe('processWaivers job', () => {
  it('processes every in-season league, then fails so the retry picks up the failed one', async () => {
    await repos.leagues.create(league({ id: 'lg-playoffs', phase: 'playoffs' }));
    await repos.leagues.create(league({ id: 'lg-setup', phase: 'setup' }));
    const log = { ...silentLogger, error: vi.fn(), info: vi.fn() };
    const original = repos.teams.list.bind(repos.teams);
    const list = vi.spyOn(repos.teams, 'list').mockImplementation(async (id) => {
      if (id === 'lg-playoffs') throw new Error('table down');
      return original(id);
    });
    const events = new InMemoryEventPublisher();
    await expect(processWaivers({ repos, reference, events, log }, new FixedClock(NOW))).rejects.toThrow(
      'Waiver processing failed for 1 of 2 leagues: lg-playoffs'
    );
    expect(log.error).toHaveBeenCalledOnce();
    expect(log.info).toHaveBeenCalledWith(
      'waiver processing partly done',
      expect.objectContaining({ leagues: 2, processed: 1, failedLeagues: ['lg-playoffs'] })
    );
    // The healthy league finished its window; the failed one released its run for the retry.
    expect(events.events.map((e) => e.detail)).toMatchObject([{ leagueId: 'lg' }, { leagueId: 'lg' }]);
    expect(await repos.waivers.getRun('lg', '2026-10-07')).toMatchObject({ status: 'complete' });
    expect(await repos.waivers.getRun('lg-playoffs', '2026-10-07')).toMatchObject({ status: 'failed' });

    // The retry a minute later: the healthy league is not processed twice.
    list.mockRestore();
    const retry = new InMemoryEventPublisher();
    const later = new FixedClock(new Date(NOW.getTime() + 60_000));
    expect(await processWaivers({ repos, reference, events: retry, log }, later)).toMatchObject({
      status: 'ok',
      leagues: 2,
      processed: 1,
      failedLeagues: []
    });
    expect(retry.events.map((e) => [e.detailType, e.detail.leagueId])).toEqual([
      ['Waivers Processed', 'lg-playoffs'],
      ['Waiver Window Opened', 'lg-playoffs']
    ]);
    expect(await repos.waivers.getRun('lg-playoffs', '2026-10-07')).toMatchObject({ status: 'complete' });
  });

  it('fails loudly when every league fails', async () => {
    vi.spyOn(repos.teams, 'list').mockRejectedValue(new Error('table down'));
    const log = { ...silentLogger, error: vi.fn() };
    await expect(
      processWaivers({ repos, reference, events: new InMemoryEventPublisher(), log }, new FixedClock(NOW))
    ).rejects.toThrow('failed for 1 of 1 leagues');
  });
});

describe('processLeagueWaivers failures', () => {
  const deps = (events = new InMemoryEventPublisher(), log = silentLogger) => ({
    repos,
    reference,
    events,
    log
  });

  it('keeps a completed run complete when announcing it fails, so a retry never processes it twice', async () => {
    const events = new InMemoryEventPublisher();
    vi.spyOn(events, 'publish').mockRejectedValueOnce(new Error('bus down'));
    await expect(processLeagueWaivers(deps(events), league(), NOW)).rejects.toThrow('bus down');
    expect(await repos.waivers.getRun('lg', '2026-10-07')).toMatchObject({ status: 'complete' });
    expect(await processLeagueWaivers(deps(), league(), NOW)).toMatchObject({ status: 'already_processed' });
  });

  it('leaves the run to go stale when it cannot be released', async () => {
    vi.spyOn(repos.teams, 'list').mockRejectedValue(new Error('table down'));
    vi.spyOn(repos.waivers, 'getRun').mockRejectedValue(new Error('table down'));
    const log = { ...silentLogger, warn: vi.fn() };
    await expect(processLeagueWaivers(deps(undefined, log), league(), NOW)).rejects.toThrow('table down');
    expect(log.warn).toHaveBeenCalledWith('could not release the waiver run', expect.anything());
    vi.mocked(repos.waivers.getRun).mockRestore();
    expect(await repos.waivers.getRun('lg', '2026-10-07')).toMatchObject({ status: 'running' });
  });

  it('does not release a run another worker has taken over', async () => {
    vi.spyOn(repos.teams, 'list').mockImplementation(async () => {
      // A stale takeover restarted the window while this run was still going.
      await repos.waivers.completeRun({
        leagueId: 'lg',
        runId: '2026-10-07',
        status: 'running',
        startedAt: '2026-10-07T08:20:00.000Z',
        completedAt: null,
        awarded: 0,
        failed: 0
      });
      throw new Error('table down');
    });
    await expect(processLeagueWaivers(deps(), league(), NOW)).rejects.toThrow('table down');
    expect(await repos.waivers.getRun('lg', '2026-10-07')).toMatchObject({
      status: 'running',
      startedAt: '2026-10-07T08:20:00.000Z'
    });
  });
});
