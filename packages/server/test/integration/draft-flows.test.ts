import { activeRosterSize, unfilledStarterSlots, type Position } from '@fantasy/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentPrincipal } from '../../src/auth/principal.js';
import { handleLeagueEvent } from '../../src/events/handlers.js';
import { deadlineScheduleName } from '../../src/league/draft.js';
import { registry } from '../../src/operations/index.js';
import { fixtureDraftPool } from '../../src/players/fixtures.js';
import { invokeTool } from '../../src/registry/invoke.js';
import { createHarness, type Harness } from '../support/harness.js';
import { as, data, errorCode, type Caller } from '../support/league-client.js';
import { ALICE, BOB, CAROL, seedLeague } from '../support/leagues.js';

/**
 * The draft end to end over HTTP (dynalite): start it, pick by name and id, the errors a model has
 * to act on, idempotent replays, racing picks, pause and resume, the pick clock's autopick, and the
 * move to the regular season when the last pick lands.
 */

const L = 'lg-draft';
let h: Harness;
let alice: Caller;
let bob: Caller;
let carol: Caller;

interface Board {
  status: string;
  onTheClock: { overall: number; teamId: string; teamName: string; deadline: string | null } | null;
  yourNextPick: { picksAway: number } | null;
  yourNeeds: string[];
  order: { teamId: string }[];
  picks: { overall: number; teamId: string; player: { id: string }; auto: boolean }[];
  rosters: { teamId: string; players: { id: string }[] }[];
  bestAvailable: { player: { id: string; position: string }; rank: number | null }[];
}

const board = async (caller: Caller, query = '') =>
  data<Board>(await caller.get(`/leagues/${L}/draft${query}`));
const events = (type: string) => h.events.events.filter((e) => e.detailType === type);
const agent = (teamId: string) => agentPrincipal({ agentId: `${L}.${teamId}`, teamId, leagueId: L });
let agentKeys = 0;
const agentPick = (teamId: string, args: Record<string, unknown>) =>
  invokeTool({
    registry,
    services: h.services,
    principal: agent(teamId),
    name: 'make_draft_pick',
    args: { leagueId: L, idempotencyKey: `agent-key-${++agentKeys}-000`, ...args }
  });

async function expire(pick: number) {
  const draft = await h.repos.drafts.get(L);
  h.clock.set(new Date(new Date(draft?.deadline ?? h.clock.now()).getTime() + 1000));
  return handleLeagueEvent(h.services, {
    id: `deadline-${pick}`,
    source: 'fantasy',
    'detail-type': 'Draft Pick Deadline',
    detail: { leagueId: L, pick }
  });
}

beforeAll(async () => {
  h = await createHarness({ backend: 'dynamo', registry, players: fixtureDraftPool });
  alice = as(h, ALICE);
  bob = as(h, BOB);
  carol = as(h, CAROL);
  await seedLeague(h.repos, { id: L, owners: [ALICE, BOB] });
});
afterAll(() => h.close());

describe('draft over HTTP (dynalite)', () => {
  it('has no board before the draft starts', async () => {
    const res = await alice.get(`/leagues/${L}/draft`);
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe('DRAFT_NOT_STARTED');
  });

  it('only the commissioner starts it, with a valid order, and every human seat taken', async () => {
    expect(errorCode(await bob.post(`/leagues/${L}/draft/start`, {}))).toBe('FORBIDDEN');
    expect(errorCode(await carol.post(`/leagues/${L}/draft/start`, {}))).toBe('FORBIDDEN');
    const bad = await alice.post(`/leagues/${L}/draft/start`, { order: ['team-1', 'team-1'] });
    expect(bad.status).toBe(400);
    expect((bad.body as { error: { fix: string } }).error.fix).toContain('team-8');

    const team = await h.repos.teams.get(L, 'team-3');
    await h.repos.teams.update({ ...team!, seatType: 'human' });
    const open = await alice.post(`/leagues/${L}/draft/start`, {});
    expect(errorCode(open)).toBe('SEATS_NOT_FILLED');
    const reverted = await h.repos.teams.get(L, 'team-3');
    await h.repos.teams.update({ ...reverted!, seatType: 'agent' });
  });

  it('starts: drafting phase, schedule, agents, order, and the first turn on the clock', async () => {
    const order = ['team-2', 'team-1', 'team-3', 'team-4', 'team-5', 'team-6', 'team-7', 'team-8'];
    const res = await alice.post(`/leagues/${L}/draft/start`, { order });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const started = data<Board>(res);
    expect(started.order.map((o) => o.teamId)).toEqual(order);
    expect(started.onTheClock).toMatchObject({ overall: 1, teamId: 'team-2', teamName: "Bob's Team" });
    expect(started.yourNextPick).toMatchObject({ overall: 2, picksAway: 1 });
    expect(started.bestAvailable[0]?.player.id).toBe('fx-chase');
    expect((res.body as { warnings: { code: string }[] }).warnings.map((w) => w.code)).toEqual([
      'AGENT_SEATS_FILLED'
    ]);
    expect((res.body as { league: { phase: string } }).league.phase).toBe('drafting');

    expect((await h.repos.leagues.get(L))?.phase).toBe('drafting');
    expect((await h.repos.schedule.listMatchups(L)).length).toBeGreaterThan(0);
    expect(await h.repos.agents.listSeats(L)).toHaveLength(6);
    expect((await h.repos.teams.get(L, 'team-2'))?.draftSlot).toBe(1);
    expect(events('Draft Turn Started')[0]?.detail).toMatchObject({
      leagueId: L,
      teamId: 'team-2',
      pick: 1,
      round: 1
    });
    expect(events('Schedule Event')[0]?.detail).toMatchObject({
      name: deadlineScheduleName(L, 1),
      whenPast: 'send',
      at: '2026-09-10T12:01:30.000Z',
      event: { detailType: 'Draft Pick Deadline', detail: { leagueId: L, pick: 1 } }
    });

    const again = await alice.post(`/leagues/${L}/draft/start`, {});
    expect(errorCode(again)).toBe('PHASE_NOT_ALLOWED');
  });

  it('refuses a pick out of turn with how long to wait', async () => {
    const res = await alice.post(`/leagues/${L}/draft/picks`, { playerId: 'fx-chase' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: { code: 'NOT_YOUR_TURN', details: { onTheClock: 'team-2', picksUntilYourTurn: 1 } }
    });
    expect((res.body as { error: { message: string } }).error.message).toContain("Bob's Team");
    expect(errorCode(await carol.get(`/leagues/${L}/draft`))).toBe('FORBIDDEN');
    expect(
      errorCode(await bob.post(`/leagues/${L}/draft/picks`, { teamId: 'team-1', playerId: 'fx-chase' }))
    ).toBe('FORBIDDEN');
  });

  it('takes a pick by name, replays it for the same key, and puts the next team on the clock', async () => {
    const ambiguous = await bob.post(`/leagues/${L}/draft/picks`, { player: 'williams' });
    expect(errorCode(ambiguous)).toBe('AMBIGUOUS_PLAYER');
    const res = await bob.post(`/leagues/${L}/draft/picks`, { player: 'CMC', pick: 1 }, 'bob-pick-0001');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(data(res)).toMatchObject({
      pick: { overall: 1, round: 1, pick: 1, teamId: 'team-2', player: { id: 'fx-cmc', position: 'RB' } },
      draftComplete: false,
      onTheClock: { overall: 2, teamId: 'team-1', secondsLeft: 90 }
    });
    const replay = await bob.post(`/leagues/${L}/draft/picks`, { player: 'CMC', pick: 1 }, 'bob-pick-0001');
    expect(replay.body).toEqual(res.body);
    expect((await h.repos.drafts.get(L))?.state.picks).toHaveLength(1);
    expect((await h.repos.teams.get(L, 'team-2'))?.roster).toEqual(['fx-cmc']);
    expect(events('Draft Pick Made')).toEqual([
      expect.objectContaining({
        detail: expect.objectContaining({ playerId: 'fx-cmc', overall: 1, auto: false })
      })
    ]);
    expect(events('Draft Turn Started').at(-1)?.detail).toMatchObject({ teamId: 'team-1', pick: 2 });
  });

  it('names who took a drafted player, and refuses a stale pick number', async () => {
    const taken = await alice.post(`/leagues/${L}/draft/picks`, { playerId: 'fx-cmc' });
    expect(taken.body).toMatchObject({
      error: { code: 'PLAYER_ALREADY_DRAFTED', details: { draftedBy: 'team-2', round: 1, pick: 1 } }
    });
    expect((taken.body as { error: { message: string } }).error.message).toContain("Bob's Team");
    const stale = await alice.post(`/leagues/${L}/draft/picks`, { playerId: 'fx-chase', pick: 1 });
    expect(stale.body).toMatchObject({ error: { code: 'NOT_YOUR_TURN', details: { currentPick: 2 } } });
    const early = await alice.post(`/leagues/${L}/draft/picks`, { playerId: 'fx-chase', pick: 9 });
    expect((early.body as { error: { message: string } }).error.message).toContain('not up yet');
  });

  it('shows the board to members with filters, rosters, and needs', async () => {
    const b = await board(alice, '?position=K&limit=3');
    expect(b.onTheClock).toMatchObject({ overall: 2, teamId: 'team-1' });
    expect(b.yourNextPick).toMatchObject({ picksAway: 0 });
    expect(b.yourNeeds).toContain('QB');
    expect(b.bestAvailable.map((a) => a.player.position)).toEqual(['K', 'K', 'K']);
    expect(b.rosters.find((r) => r.teamId === 'team-2')?.players.map((p) => p.id)).toEqual(['fx-cmc']);
    expect((await board(alice, '?q=jefferson')).bestAvailable[0]?.player.id).toBe('fx-jjefferson');
    expect((await board(alice, '?detail=true')).bestAvailable).toHaveLength(50);
    const agentBoard = await invokeTool({
      registry,
      services: h.services,
      principal: agent('team-3'),
      name: 'get_draft_board',
      args: { leagueId: L }
    });
    expect(agentBoard.body).toMatchObject({ data: { yourTeamId: 'team-3', yourNextPick: { picksAway: 1 } } });
  });

  it('lets exactly one of two racing picks land', async () => {
    const [a, b] = await Promise.all([
      alice.post(`/leagues/${L}/draft/picks`, { playerId: 'fx-chase' }),
      alice.post(`/leagues/${L}/draft/picks`, { playerId: 'fx-jjefferson' })
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const draft = await h.repos.drafts.get(L);
    expect(draft?.state.picks).toHaveLength(2);
    expect((await h.repos.teams.get(L, 'team-1'))?.roster).toHaveLength(1);
  });

  it('pauses and resumes the clock (commissioner only)', async () => {
    expect(errorCode(await bob.post(`/leagues/${L}/draft/pause`))).toBe('FORBIDDEN');
    expect(errorCode(await alice.post(`/leagues/${L}/draft/resume`))).toBe('CONFLICT');
    h.clock.advance(20_000);
    const paused = await alice.post(`/leagues/${L}/draft/pause`);
    expect(data(paused)).toEqual({ status: 'paused', deadline: null, secondsLeft: 70 });
    expect(data(await alice.post(`/leagues/${L}/draft/pause`))).toMatchObject({ status: 'paused' });
    expect((await agentPick('team-3', { playerId: 'fx-jjefferson' })).body).toMatchObject({
      error: { code: 'DRAFT_PAUSED' }
    });
    h.clock.advance(10 * 60_000);
    expect(await expire(3)).toEqual({ handled: true, outcome: 'paused' });
    const resumed = await alice.post(`/leagues/${L}/draft/resume`);
    expect(data(resumed)).toMatchObject({ status: 'in_progress', secondsLeft: 70 });
    expect(events('Draft Turn Started').at(-1)?.detail).toMatchObject({ teamId: 'team-3', pick: 3 });
  });

  it('autopicks when the clock runs out, and treats stale and early deadlines as no-ops', async () => {
    const early = await handleLeagueEvent(h.services, {
      id: 'early-3',
      source: 'fantasy',
      'detail-type': 'Draft Pick Deadline',
      detail: { leagueId: L, pick: 3 }
    });
    expect(early).toEqual({ handled: true, outcome: 'early' });
    expect(await expire(3)).toEqual({ handled: true, outcome: 'autopicked' });
    const draft = await h.repos.drafts.get(L);
    expect(draft?.state.picks[2]).toMatchObject({ teamId: 'team-3', auto: true });
    expect(events('Draft Pick Made').at(-1)?.detail).toMatchObject({ teamId: 'team-3', auto: true });
    const stale = await handleLeagueEvent(h.services, {
      id: 'stale-2',
      source: 'fantasy',
      'detail-type': 'Draft Pick Deadline',
      detail: { leagueId: L, pick: 2 }
    });
    expect(stale).toEqual({ handled: true, outcome: 'stale' });
    expect((await h.repos.drafts.get(L))?.state.picks).toHaveLength(3);
  });

  it('runs the clock to the end: valid rosters, nobody twice, and the regular season begins', async () => {
    for (let guard = 0; guard < 200; guard++) {
      const draft = await h.repos.drafts.get(L);
      if (draft?.status === 'complete') break;
      await expire(draft!.state.picks.length + 1);
    }
    const draft = await h.repos.drafts.get(L);
    const league = await h.repos.leagues.get(L);
    expect(draft?.status).toBe('complete');
    expect(league).toMatchObject({ phase: 'regular_season', week: 1 });
    const ids = draft!.state.picks.map((p) => p.playerId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const team of await h.repos.teams.list(L)) {
      expect(team.roster).toHaveLength(activeRosterSize(league!.settings));
      const positions = team.roster.map((id) => [
        fixtureDraftPool.find((p) => p.id === id)!.position as Position
      ]);
      expect(unfilledStarterSlots(league!.settings, positions)).toEqual([]);
    }
    expect(events('Draft Completed')).toEqual([
      expect.objectContaining({ detail: expect.objectContaining({ leagueId: L, picks: 128, week: 1 }) })
    ]);
    const done = await board(alice);
    expect(done).toMatchObject({ status: 'complete', onTheClock: null, yourNextPick: null, yourNeeds: [] });
    expect(errorCode(await alice.post(`/leagues/${L}/draft/picks`, { playerId: 'fx-def-nyj' }))).toBe(
      'PHASE_NOT_ALLOWED'
    );
    expect(await expire(129)).toEqual({ handled: true, outcome: 'ignored' });
  });
});
