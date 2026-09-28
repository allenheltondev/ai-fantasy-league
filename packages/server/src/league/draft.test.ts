import {
  createDraft,
  currentPick,
  FixedClock,
  makePick,
  type DraftState,
  type Position
} from '@fantasy/core';
import { describe, expect, it, vi } from 'vitest';
import { START } from '../../test/support/harness.js';
import { ALICE, BOB, seedLeague } from '../../test/support/leagues.js';
import { as, data, errorCode } from '../../test/support/league-client.js';
import { createHarness } from '../../test/support/harness.js';
import { handleLeagueEvent, isBusEvent } from '../events/handlers.js';
import { InMemoryEventPublisher } from '../events/publisher.js';
import { createLogger, silentLogger } from '../log.js';
import { registry } from '../operations/index.js';
import { fixtureDraftPool } from '../players/fixtures.js';
import type { Player } from '../players/model.js';
import { staleDraft, staleLeague, staleTeam } from '../repos/errors.js';
import { createInMemoryRepos } from '../repos/memory.js';
import type { DraftRecord } from '../repos/types.js';
import { createServices } from '../services.js';
import { currentNflWeek, type NflStateSnapshot } from './calendar.js';
import { announceTurn, handleDraftDeadline, recordPick, secondsLeft } from './draft.js';

const L = 'lg-unit';
const player = (id: string) => fixtureDraftPool.find((p) => p.id === id) as Player;
const ofPosition = (position: Position) => fixtureDraftPool.filter((p) => p.position === position);

async function setup(options: { players?: readonly Player[]; phase?: 'setup' | 'drafting' } = {}) {
  const repos = createInMemoryRepos({ players: options.players ?? fixtureDraftPool });
  const clock = new FixedClock(START);
  const events = new InMemoryEventPublisher();
  const services = createServices({ clock, repos, events, log: silentLogger });
  const { teams } = await seedLeague(repos, {
    id: L,
    owners: [{ sub: 'alice', name: 'Alice' }],
    teamCount: 4,
    overrides: { phase: options.phase ?? 'drafting' }
  });
  const league = (await repos.leagues.get(L))!;
  return { repos, clock, events, services, teams, league };
}

/** A 4-team draft with `players` already picked in snake order. */
function draftWith(players: readonly Player[], config: Partial<DraftState> = {}): DraftState {
  const created = createDraft({
    teamIds: ['team-1', 'team-2', 'team-3', 'team-4'],
    rounds: 16,
    pickSeconds: 90
  });
  if (!created.ok) throw new Error('bad draft');
  let s: DraftState = { ...created.value, ...config };
  for (const p of players) {
    const made = makePick(s, currentPick(s)!.teamId, p.id, { positions: [p.position], now: START });
    if (!made.ok) throw new Error(JSON.stringify(made.issues));
    s = made.value.draft;
  }
  return s;
}

function record(s: DraftState, overrides: Partial<DraftRecord> = {}): DraftRecord {
  return {
    leagueId: L,
    state: s,
    status: 'in_progress',
    startedAt: START,
    deadline: '2026-09-10T12:01:30.000Z',
    pausedRemainingSeconds: null,
    completedAt: null,
    updatedAt: START,
    version: 1,
    ...overrides
  };
}

const deadline = (pick: number) => ({
  id: `evt-${pick}`,
  source: 'fantasy',
  'detail-type': 'Draft Pick Deadline',
  detail: { leagueId: L, pick }
});

describe('recordPick rules', () => {
  it('refuses a pick that leaves too few picks for the empty starting slots', async () => {
    const t = await setup();
    // 28 QBs: every team has 7 and 9 empty starting slots for 9 picks, so an eighth QB is refused.
    const qbs = ofPosition('QB');
    const r = record(draftWith(qbs.slice(0, 28)));
    const pick = recordPick(t.services, {
      league: t.league,
      teams: t.teams,
      record: r,
      teamId: 'team-4',
      player: { ...qbs[0]!, id: 'extra-qb' },
      auto: false
    });
    await expect(pick).rejects.toMatchObject({
      code: 'ROSTER_WOULD_BE_INVALID',
      details: { picksLeftAfter: 8 }
    });
  });

  it('enforces position limits, a paused clock, the end of the draft, and teams with no picks left', async () => {
    const t = await setup();
    const base = { league: t.league, teams: t.teams, auto: false };
    const ks = ofPosition('K');
    const wrs = ofPosition('WR');
    // team-1 took a K; six picks later it is on the clock again.
    const limited = record(draftWith([ks[0]!, ...wrs.slice(0, 6)], { positionLimits: { K: 1 } }));
    await expect(
      recordPick(t.services, { ...base, record: limited, teamId: 'team-1', player: ks[1]! })
    ).rejects.toMatchObject({ code: 'ROSTER_POSITION_LIMIT', details: { position: 'K', limit: 1 } });
    await expect(
      recordPick(t.services, {
        ...base,
        record: record(draftWith([]), { status: 'paused' }),
        teamId: 'team-1',
        player: wrs[0]!
      })
    ).rejects.toMatchObject({ code: 'DRAFT_PAUSED' });
    const oneRound = draftWith(wrs.slice(0, 1), { rounds: 1 });
    await expect(
      recordPick(t.services, { ...base, record: record(oneRound), teamId: 'team-1', player: wrs[5]! })
    ).rejects.toMatchObject({ code: 'NOT_YOUR_TURN', fix: 'You have no picks left in this draft.' });
    const done = draftWith(wrs.slice(0, 4), { rounds: 1 });
    await expect(
      recordPick(t.services, {
        ...base,
        record: record(done, { status: 'complete' }),
        teamId: 'team-1',
        player: wrs[5]!
      })
    ).rejects.toMatchObject({ code: 'DRAFT_COMPLETE' });
  });

  it('retries a roster write that loses a race, and surfaces other failures', async () => {
    const t = await setup();
    await t.repos.drafts.create(record(draftWith([])));
    const update = t.repos.teams.update.bind(t.repos.teams);
    const spy = vi
      .spyOn(t.repos.teams, 'update')
      .mockRejectedValueOnce(staleTeam('team-1'))
      .mockImplementation(update);
    const r = (await t.repos.drafts.get(L))!;
    await recordPick(t.services, {
      league: t.league,
      teams: t.teams,
      record: r,
      teamId: 'team-1',
      player: player('fx-cmc'),
      auto: false
    });
    expect(spy).toHaveBeenCalledTimes(2);
    expect((await t.repos.teams.get(L, 'team-1'))?.roster).toEqual(['fx-cmc']);

    spy.mockReset().mockRejectedValue(new Error('dynamo down'));
    const next = (await t.repos.drafts.get(L))!;
    await expect(
      recordPick(t.services, {
        league: t.league,
        teams: t.teams,
        record: next,
        teamId: 'team-2',
        player: player('fx-chase'),
        auto: false
      })
    ).rejects.toThrow('dynamo down');
  });
});

describe('handleDraftDeadline', () => {
  it('ignores leagues without a live draft', async () => {
    const t = await setup({ phase: 'setup' });
    expect(await handleDraftDeadline(t.services, { leagueId: 'nope', pick: 1 })).toBe('ignored');
    expect(await handleDraftDeadline(t.services, { leagueId: L, pick: 1 })).toBe('ignored');
    await t.repos.drafts.create(record(draftWith([])));
    expect(await handleDraftDeadline(t.services, { leagueId: L, pick: 1 })).toBe('ignored');
  });

  it('finishes a complete draft whose league is still drafting, once', async () => {
    const t = await setup();
    const s = draftWith(fixtureDraftPool.slice(0, 4), { rounds: 1 });
    await t.repos.drafts.create(record(s, { status: 'complete', deadline: null, completedAt: START }));
    const update = t.repos.leagues.update.bind(t.repos.leagues);
    vi.spyOn(t.repos.leagues, 'update').mockRejectedValueOnce(staleLeague(L)).mockImplementation(update);
    expect(await handleDraftDeadline(t.services, { leagueId: L, pick: 4 })).toBe('completed');
    expect(await t.repos.leagues.get(L)).toMatchObject({ phase: 'regular_season', week: 1 });
    expect((await t.repos.teams.get(L, 'team-3'))?.roster).toEqual([fixtureDraftPool[2]!.id]);
    expect(t.events.events.filter((e) => e.detailType === 'Draft Completed')).toHaveLength(1);
    expect(await handleDraftDeadline(t.services, { leagueId: L, pick: 4 })).toBe('ignored');
  });

  it('reports a lost race, logs an empty pool, and rethrows real failures', async () => {
    const t = await setup();
    await t.repos.drafts.create(record(draftWith([])));
    t.clock.set('2026-09-10T12:05:00.000Z');
    const spy = vi.spyOn(t.repos.drafts, 'update').mockRejectedValueOnce(staleDraft(L));
    expect(await handleDraftDeadline(t.services, { leagueId: L, pick: 1 })).toBe('raced');
    spy.mockRejectedValueOnce(new Error('boom'));
    await expect(handleDraftDeadline(t.services, { leagueId: L, pick: 1 })).rejects.toThrow('boom');

    const empty = await setup({ players: [] });
    await empty.repos.drafts.create(record(draftWith([])));
    empty.clock.set('2026-09-10T12:05:00.000Z');
    expect(await handleDraftDeadline(empty.services, { leagueId: L, pick: 1 })).toBe('ignored');
  });
});

describe('clock helpers', () => {
  it('counts seconds left, frozen while paused', () => {
    const now = new Date('2026-09-10T12:01:00.000Z');
    expect(secondsLeft(record(draftWith([])), now)).toBe(30);
    expect(secondsLeft(record(draftWith([])), new Date('2026-09-10T13:00:00.000Z'))).toBe(0);
    expect(
      secondsLeft(
        record(draftWith([]), { status: 'paused', deadline: null, pausedRemainingSeconds: 42 }),
        now
      )
    ).toBe(42);
    expect(secondsLeft(record(draftWith([]), { status: 'complete', deadline: null }), now)).toBeNull();
  });

  it('announces nothing once the draft is complete', async () => {
    const t = await setup();
    await announceTurn(t.services, record(draftWith([]), { status: 'complete', deadline: null }));
    expect(t.events.events).toEqual([]);
  });

  it('reads the current NFL week from the NFL state, or the clock', async () => {
    const at = new Date('2026-10-01T12:00:00Z');
    const source = (s: Omit<NflStateSnapshot, 'season'>) => ({
      getNflState: async () => ({ season: 2026, ...s })
    });
    expect((await currentNflWeek(source({ seasonType: 'regular', week: 4 }), at, silentLogger)).week).toBe(4);
    expect((await currentNflWeek(source({ seasonType: 'pre', week: 0 }), at, silentLogger)).week).toBe(1);
    expect((await currentNflWeek(source({ seasonType: 'post', week: 20 }), at, silentLogger)).week).toBe(18);
    expect(await currentNflWeek(undefined, at, silentLogger)).toEqual({
      season: 2026,
      week: 3,
      source: 'clock'
    });
    expect((await currentNflWeek(undefined, new Date('2026-08-01T00:00:00Z'), silentLogger)).week).toBe(1);
    const lines: string[] = [];
    const failing = { getNflState: vi.fn().mockRejectedValue(new Error('down')) };
    const logged = await currentNflWeek(failing, at, createLogger({ sink: (l) => lines.push(l) }));
    expect(logged.source).toBe('clock');
    expect(lines.some((l) => l.includes('NFL state unavailable'))).toBe(true);
  });
});

describe('league event handler', () => {
  it('handles only well-formed draft deadlines', async () => {
    const t = await setup();
    expect(isBusEvent(deadline(1))).toBe(true);
    expect(isBusEvent({ rawPath: '/api' })).toBe(false);
    expect(
      await handleLeagueEvent(t.services, { ...deadline(1), 'detail-type': 'Draft Turn Started' })
    ).toEqual({ handled: false });
    expect(await handleLeagueEvent(t.services, { ...deadline(1), source: 'other' })).toEqual({
      handled: false
    });
    expect(await handleLeagueEvent(t.services, { ...deadline(1), detail: { leagueId: L } })).toEqual({
      handled: false
    });
    expect(await handleLeagueEvent(t.services, deadline(1))).toEqual({ handled: true, outcome: 'ignored' });
  });
});

describe('start_draft for a mid-season league', () => {
  it('moves a start week that already kicked off to the next open week, or refuses when too late', async () => {
    const h = await createHarness({ registry, players: fixtureDraftPool });
    await seedLeague(h.repos, { id: 'lg-mid', owners: [ALICE, BOB], teamCount: 4 });
    await seedLeague(h.repos, { id: 'lg-late', owners: [ALICE], teamCount: 4 });
    const alice = as(h, ALICE);
    // 2026 week 4 kicks off Thursday, October 1; on Wednesday, week 4 is the first open week.
    h.clock.set('2026-09-30T12:00:00Z');
    const res = await alice.post('/leagues/lg-mid/draft/start', { randomizeOrder: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((res.body as { warnings: { code: string }[] }).warnings.map((w) => w.code)).toContain(
      'START_WEEK_MOVED'
    );
    expect((await h.repos.leagues.get('lg-mid'))?.settings.schedule.startWeek).toBe(4);
    expect(new Set(data<{ order: { teamId: string }[] }>(res).order.map((o) => o.teamId)).size).toBe(4);

    h.clock.set('2026-11-20T12:00:00Z');
    const late = await alice.post('/leagues/lg-late/draft/start', {});
    expect(errorCode(late)).toBe('INVALID_SETTINGS');
    await h.close();
  });

  it('finishes a start that was interrupted after the draft item was written', async () => {
    const h = await createHarness({ registry, players: fixtureDraftPool });
    await seedLeague(h.repos, { id: L, owners: [ALICE], teamCount: 4 });
    await h.repos.drafts.create(record(draftWith([]), { startedAt: '2026-09-01T00:00:00.000Z' }));
    const res = await as(h, ALICE).post(`/leagues/${L}/draft/start`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await h.repos.drafts.get(L)).toMatchObject({
      startedAt: START,
      deadline: '2026-09-10T12:01:30.000Z',
      version: 2
    });
    await h.close();
  });

  it('refuses when the seats do not match teamCount', async () => {
    const h = await createHarness({ registry, players: fixtureDraftPool });
    await seedLeague(h.repos, { id: 'lg-odd', owners: [ALICE], teamCount: 4 });
    const league = (await h.repos.leagues.get('lg-odd'))!;
    await h.repos.leagues.update({ ...league, settings: { ...league.settings, teamCount: 6 } });
    expect(errorCode(await as(h, ALICE).post('/leagues/lg-odd/draft/start', {}))).toBe('CONFLICT');
    await h.close();
  });
});

describe('draft repositories', () => {
  it('create once, then version-checked updates (in memory and DynamoDB)', async () => {
    for (const backend of ['memory', 'dynamo'] as const) {
      const h = await createHarness({ backend });
      expect(await h.repos.drafts.get(L)).toBeNull();
      await h.repos.drafts.create(record(draftWith([])));
      await expect(h.repos.drafts.create(record(draftWith([])))).rejects.toMatchObject({ code: 'CONFLICT' });
      const saved = await h.repos.drafts.update(record(draftWith([]), { status: 'paused' }));
      expect(saved.version).toBe(2);
      expect(await h.repos.drafts.get(L)).toMatchObject({ status: 'paused', version: 2 });
      await expect(h.repos.drafts.update(record(draftWith([])))).rejects.toMatchObject({ code: 'CONFLICT' });
      await h.close();
    }
  });
});

describe('get_draft_board', () => {
  it('still shows a drafted player who left the player index', async () => {
    const h = await createHarness({ registry, players: fixtureDraftPool });
    await seedLeague(h.repos, { id: L, owners: [ALICE], teamCount: 4, overrides: { phase: 'drafting' } });
    await h.repos.drafts.create(record(draftWith([{ ...player('fx-cmc'), id: 'ghost' }])));
    const board = data<{ picks: { player: unknown }[] }>(await as(h, ALICE).get(`/leagues/${L}/draft`));
    expect(board.picks[0]?.player).toEqual({ id: 'ghost', name: 'ghost', team: null, position: 'RB' });
    await h.close();
  });
});
