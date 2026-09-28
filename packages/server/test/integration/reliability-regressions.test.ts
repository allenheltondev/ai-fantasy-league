import { ApiError } from '../../src/errors.js';
import { resumeDraftStartup } from '../../src/operations/draft/start-draft.js';
import { postSystemMessage } from '../../src/chat/system-messages.js';
import { FixedClock } from '@fantasy/core';
import { advanceSeason } from '../../src/jobs/season.js';
import { describe, expect, it, vi } from 'vitest';
import { createHarness } from '../support/harness.js';
import { as } from '../support/league-client.js';
import { ALICE, BOB, seedLeague } from '../support/leagues.js';
import { seedSeasonLeague as seedWaivers } from '../support/waivers.js';
import { MONDAY_KICKOFF, seedNflSchedule, seedSeasonLeague } from '../support/season.js';
import { registry } from '../../src/operations/index.js';
import { advanceLeague } from '../../src/season/cycle.js';
import type { League } from '../../src/repos/types.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('audit regression reproductions', () => {
  it.each(['memory', 'dynamo'] as const)(
    'preserves a later waiver reorder and deduplicates republished recaps (%s)',
    async (backend) => {
      const h = await createHarness({ backend, registry });
      try {
        const deps = {
          repos: h.repos,
          reference: h.services.data.reference,
          events: h.events,
          log: h.services.log
        };
        await seedNflSchedule(deps.reference);
        const seeded = await seedSeasonLeague(deps, { id: 'priority-retry', owners: [ALICE] });
        const league = await h.repos.leagues.update({
          ...seeded.league,
          settings: {
            ...seeded.league.settings,
            waivers: { ...seeded.league.settings.waivers, priorityOrder: 'reverse_standings_weekly' }
          }
        });
        const now = new Date(Date.parse(MONDAY_KICKOFF) + 5 * 3_600_000);
        const updateTeam = h.repos.teams.update.bind(h.repos.teams);
        let priorityRaced = false;
        vi.spyOn(h.repos.teams, 'update').mockImplementation(async (team) => {
          if (team.waiverPriorityResetKey && !priorityRaced) {
            priorityRaced = true;
            throw new ApiError('CONFLICT', 'Concurrent team edit', { fix: 'Retry.' });
          }
          return updateTeam(team);
        });
        vi.spyOn(h.events, 'scheduleAt').mockRejectedValueOnce(new Error('timer unavailable'));
        await expect(advanceLeague(deps, league, now)).rejects.toThrow('timer unavailable');
        const first = h.events.events.find((e) => e.detailType === 'Week Provisionally Final')!;
        const delivered = (id: string, time: string) => ({
          ...first,
          id,
          'detail-type': first.detailType,
          time
        });
        expect(await postSystemMessage(h.services, delivered('delivery-1', now.toISOString()))).toMatchObject(
          { status: 'posted' }
        );
        const teams = await h.repos.teams.list(league.id);
        for (const team of teams)
          await h.repos.teams.update({ ...team, waiverPriority: 5 - team.waiverPriority });
        const before = (await h.repos.teams.list(league.id)).map((t) => t.waiverPriority);
        const update = h.repos.leagues.update.bind(h.repos.leagues);
        let raced = false;
        vi.spyOn(h.repos.leagues, 'update').mockImplementation(async (next) => {
          if (!raced && next.pendingRollover === null) {
            raced = true;
            await update({ ...(await h.repos.leagues.get(league.id))!, name: 'Changed during recovery' });
          }
          return update(next);
        });
        await advanceLeague(deps, (await h.repos.leagues.get(league.id))!, now);
        expect((await h.repos.teams.list(league.id)).map((t) => t.waiverPriority)).toEqual(before);
        expect(await h.repos.leagues.get(league.id)).toMatchObject({
          pendingRollover: null,
          name: 'Changed during recovery'
        });
        const replay = h.events.events.filter((e) => e.detailType === 'Week Provisionally Final').at(-1)!;
        expect(replay.detail.eventKey).toBe(first.detail.eventKey);
        expect(
          await postSystemMessage(h.services, {
            ...delivered('delivery-2', new Date(now.getTime() + 1000).toISOString()),
            detail: replay.detail
          })
        ).toMatchObject({ status: 'duplicate' });
        expect(h.events.events.filter((e) => e.detailType === 'Week Provisionally Final')).toHaveLength(2);
      } finally {
        await h.close();
      }
    }
  );

  it('keeps the season job and another request out of a running draft startup', async () => {
    const h = await createHarness({ registry });
    const reached = deferred<void>();
    const resume = deferred<void>();
    try {
      await seedLeague(h.repos, { id: 'start-race', owners: [ALICE], teamCount: 4 });
      const publish = h.events.publish.bind(h.events);
      vi.spyOn(h.events, 'publish').mockImplementation(async (type, detail) => {
        if (type === 'Draft Turn Started') {
          reached.resolve();
          await resume.promise;
        }
        return publish(type, detail);
      });
      const first = as(h, ALICE).post('/leagues/start-race/draft/start', {});
      await reached.promise;
      const deps = {
        repos: h.repos,
        reference: h.services.data.reference,
        events: h.events,
        log: h.services.log
      };
      expect(await advanceSeason(deps, h.clock)).toMatchObject({ status: 'skipped' });
      expect((await as(h, ALICE).post('/leagues/start-race/draft/start', {})).status).toBe(409);
      const update = h.repos.leagues.update.bind(h.repos.leagues);
      let raced = false;
      vi.spyOn(h.repos.leagues, 'update').mockImplementation(async (next) => {
        if (!raced && next.draftStartup === null) {
          raced = true;
          await update({ ...(await h.repos.leagues.get(next.id))!, name: 'Renamed' });
        }
        return update(next);
      });
      resume.resolve();
      expect((await first).status).toBe(200);
      await resumeDraftStartup(h.services, (await h.repos.leagues.get('start-race'))!);
      expect(h.events.events.filter((e) => e.detailType === 'Draft Turn Started')).toHaveLength(1);
      expect(await h.repos.leagues.get('start-race')).toMatchObject({ name: 'Renamed', draftStartup: null });
    } finally {
      resume.resolve();
      await h.close();
    }
  });

  it('explains how to repair a missing draft record', async () => {
    const h = await createHarness({ registry });
    try {
      await seedLeague(h.repos, {
        id: 'missing-draft',
        owners: [ALICE],
        teamCount: 4,
        overrides: { phase: 'drafting', draftStartup: { by: 'system' } }
      });
      const result = await as(h, ALICE).post('/leagues/missing-draft/draft/start', {});
      expect(result.status).toBe(409);
      expect(result.body).toMatchObject({
        error: { fix: expect.stringContaining('restore the draft record') }
      });
    } finally {
      await h.close();
    }
  });

  it('does not steal an in-flight ownership lock from another team', async () => {
    const h = await createHarness({ backend: 'dynamo', registry });
    try {
      await seedWaivers(h.repos, { id: 'audit-lock', owners: [ALICE, BOB], rosters: {} });
      const reached = deferred<void>();
      const resume = deferred<void>();
      const update = h.repos.teams.update.bind(h.repos.teams);
      vi.spyOn(h.repos.teams, 'update').mockImplementation(async (team) => {
        if (team.id === 'team-1') {
          reached.resolve();
          await resume.promise;
        }
        return update(team);
      });
      const first = as(h, ALICE).post('/leagues/audit-lock/waivers/claims', { playerId: 'fx-bijan' });
      await reached.promise;
      const second = await as(h, BOB).post('/leagues/audit-lock/waivers/claims', { playerId: 'fx-bijan' });
      resume.resolve();
      const initial = await first;
      expect([initial.status, second.status].sort()).toEqual([200, 409]);
      expect(
        (await h.repos.teams.list('audit-lock')).filter((t) => t.roster.includes('fx-bijan'))
      ).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it('rechecks roster capacity after a concurrent addition', async () => {
    const h = await createHarness({ backend: 'dynamo', registry });
    try {
      await seedWaivers(h.repos, {
        id: 'audit-capacity',
        owners: [ALICE],
        rosters: { 'team-1': ['fx-jallen', 'fx-cmc'] }
      });
      const reached = deferred<void>();
      const resume = deferred<void>();
      const update = h.repos.teams.update.bind(h.repos.teams);
      let held = false;
      vi.spyOn(h.repos.teams, 'update').mockImplementation(async (team) => {
        if (!held && team.roster.includes('fx-bijan')) {
          held = true;
          reached.resolve();
          await resume.promise;
        }
        return update(team);
      });
      const alice = as(h, ALICE);
      const first = alice.post('/leagues/audit-capacity/waivers/claims', { playerId: 'fx-bijan' });
      await reached.promise;
      const second = await alice.post('/leagues/audit-capacity/waivers/claims', { playerId: 'fx-chase' });
      resume.resolve();
      const initial = await first;
      expect(second.status).toBe(200);
      expect.soft(initial.status).toBe(409);
      expect((await h.repos.teams.get('audit-capacity', 'team-1'))?.roster).toHaveLength(3);
    } finally {
      await h.close();
    }
  });

  it('atomically reclaims multiple stale locks without stealing a rostered player', async () => {
    const h = await createHarness({ backend: 'dynamo', registry });
    try {
      const id = 'recover-locks';
      await seedWaivers(h.repos, { id, owners: [ALICE, BOB], rosters: {} });
      await h.repos.waivers.acquirePlayer(id, 'fx-bijan', 'team-2');
      await h.repos.waivers.acquirePlayer(id, 'fx-chase', 'team-2');
      const first = (await h.repos.teams.get(id, 'team-1'))!;
      const acquired = await h.repos.teams.update({ ...first, roster: ['fx-bijan', 'fx-chase'] });
      expect(await h.repos.waivers.playerOwner(id, 'fx-bijan')).toBe('team-1');
      expect(await h.repos.waivers.playerOwner(id, 'fx-chase')).toBe('team-1');
      const second = (await h.repos.teams.get(id, 'team-2'))!;
      await expect(h.repos.teams.update({ ...second, roster: ['fx-bijan'] })).rejects.toMatchObject({
        code: 'PLAYER_NOT_AVAILABLE'
      });
      expect((await h.repos.teams.get(id, 'team-2'))?.roster).toEqual([]);
      await h.repos.teams.update({ ...acquired, roster: [] });
      expect(await h.repos.waivers.playerOwner(id, 'fx-bijan')).toBeNull();
    } finally {
      await h.close();
    }
  });

  it('the season job recovers draft startup without another commissioner request', async () => {
    const h = await createHarness({ registry });
    try {
      await seedLeague(h.repos, { id: 'recover-draft', owners: [ALICE], teamCount: 4 });
      vi.spyOn(h.events, 'scheduleAt').mockRejectedValueOnce(new Error('scheduler unavailable'));
      expect((await as(h, ALICE).post('/leagues/recover-draft/draft/start', {})).status).toBe(500);
      const deps = {
        repos: h.repos,
        reference: h.services.data.reference,
        events: h.events,
        log: h.services.log
      };
      const pending = (await h.repos.leagues.get('recover-draft'))!;
      // Simulate a worker that crashed while holding its lease.
      await h.repos.leagues.update({
        ...pending,
        draftStartup: {
          ...pending.draftStartup!,
          owner: 'crashed',
          leaseUntil: new Date(h.clock.now().getTime() + 120_000).toISOString()
        }
      });
      expect(await advanceSeason(deps, h.clock)).toMatchObject({ status: 'skipped' });
      h.clock.advance(120_001);
      expect(await advanceSeason(deps, h.clock)).toMatchObject({ draft_recovered: 1 });
      expect((await h.repos.leagues.get('recover-draft'))?.draftStartup).toBeNull();
      expect(
        h.events.events.some(
          (e) =>
            e.detailType === 'Schedule Event' &&
            (e.detail.event as { detailType: string }).detailType === 'Draft Pick Deadline'
        )
      ).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('the season job recovers completion events for a league already marked complete', async () => {
    const h = await createHarness({ registry });
    try {
      const deps = {
        repos: h.repos,
        reference: h.services.data.reference,
        events: h.events,
        log: h.services.log
      };
      await seedNflSchedule(deps.reference);
      const { league } = await seedSeasonLeague(deps, {
        id: 'recover-complete',
        owners: [ALICE],
        overrides: { phase: 'playoffs', week: 17 }
      });
      const now = new Date(Date.parse(MONDAY_KICKOFF) + 16 * 7 * 86_400_000 + 5 * 3_600_000);
      vi.spyOn(h.events, 'publish').mockRejectedValueOnce(new Error('event outage'));
      await expect(advanceLeague(deps, league, now)).rejects.toThrow('event outage');
      expect((await h.repos.leagues.get(league.id))?.phase).toBe('complete');
      expect(await advanceSeason(deps, new FixedClock(now))).toMatchObject({ completed: 1 });
      expect((await h.repos.leagues.get(league.id))?.pendingRollover).toBeNull();
      expect(h.events.events.some((e) => e.detailType === 'Season Completed')).toBe(true);
    } finally {
      await h.close();
    }
  });

  it.each(['publish', 'scheduleAt'] as const)('recovers draft startup after %s fails', async (method) => {
    const h = await createHarness({ registry });
    try {
      await seedLeague(h.repos, { id: 'audit-start', owners: [ALICE], teamCount: 4 });
      vi.spyOn(h.events, method).mockRejectedValueOnce(new Error('temporary event outage'));
      const alice = as(h, ALICE);
      const first = await alice.post('/leagues/audit-start/draft/start', {}, 'audit-start-key');
      expect(first.status).toBe(500);
      expect((await h.repos.leagues.get('audit-start'))?.phase).toBe('drafting');
      const retry = await alice.post('/leagues/audit-start/draft/start', {}, 'audit-start-key');
      expect(retry.status).toBe(200);
      expect(h.events.events.some((e) => e.detailType === 'Draft Turn Started')).toBe(true);
    } finally {
      await h.close();
    }
  });

  it.each(['publish', 'scheduleAt'] as const)(
    'recovers rollover events and timers after %s fails',
    async (method) => {
      const h = await createHarness({ registry });
      try {
        const deps = {
          repos: h.repos,
          reference: h.services.data.reference,
          events: h.events,
          log: h.services.log
        };
        await seedNflSchedule(deps.reference);
        const { league } = await seedSeasonLeague(deps, { id: 'audit-cycle', owners: [ALICE] });
        const now = new Date(Date.parse(MONDAY_KICKOFF) + 5 * 3_600_000);
        vi.spyOn(h.events, method).mockRejectedValueOnce(new Error('temporary event outage'));
        await expect(advanceLeague(deps, league, now)).rejects.toThrow('temporary event outage');
        const next = (await h.repos.leagues.get(league.id)) as League;
        expect(next.week).toBe(2);
        await advanceSeason(deps, new FixedClock(now));
        expect((await h.repos.leagues.get(league.id))?.pendingRollover).toBeNull();
        expect(h.events.events.some((e) => e.detailType === 'Week Rolled Over')).toBe(true);
      } finally {
        await h.close();
      }
    }
  );
});
