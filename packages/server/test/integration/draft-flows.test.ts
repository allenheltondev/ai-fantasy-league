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
 * The draft end to end over HTTP (DynamoDB Local): start it, pick by name and id, the errors a model has
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
  order: { teamId: string; manager: { name: string } | null }[];
  picks: {
    overall: number;
    teamId: string;
    player: { id: string };
    auto: boolean;
    adp: number | null;
    reason: string | null;
  }[];
  recap: {
    steals: { overall: number }[];
    reaches: { overall: number }[];
    agentPicks: { teamId: string; overall: number; teamName: string; player: { id: string } }[];
  } | null;
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

describe('draft over HTTP (DynamoDB Local)', () => {
  it('has no board before the draft starts', async () => {
    const res = await alice.get(`/leagues/${L}/draft`);
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe('DRAFT_NOT_STARTED');
  });

  it('keeps each team a private draft queue, before the draft too', async () => {
    const Q = `/leagues/${L}/draft/queue`;
    expect(data(await bob.get(Q))).toEqual({ teamId: 'team-2', maxSize: 50, updatedAt: null, players: [] });
    const set = await bob.put(Q, { playerIds: ['fx-bijan', 'fx-kelce', 'fx-bijan'] });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(data(set)).toMatchObject({
      teamId: 'team-2',
      updatedAt: h.clock.now().toISOString(),
      players: [
        { player: { id: 'fx-bijan' }, available: true, rank: 5 },
        { player: { id: 'fx-kelce' }, available: true }
      ]
    });
    expect((set.body as { warnings: { code: string }[] }).warnings.map((w) => w.code)).toEqual([
      'DUPLICATES_REMOVED'
    ]);
    // The same list again changes nothing (idempotent), and the queue is what get returns.
    const first = data<{ updatedAt: string }>(set).updatedAt;
    h.clock.advance(1000);
    expect(data(await bob.put(Q, { playerIds: ['fx-bijan', 'fx-kelce'] }))).toMatchObject({
      updatedAt: first
    });
    h.clock.set(new Date(first));
    expect(data(await bob.get(Q))).toMatchObject({ updatedAt: first, players: [{}, {}] });
    expect((await h.repos.drafts.getQueue(L, 'team-2'))?.playerIds).toEqual(['fx-bijan', 'fx-kelce']);

    // Owner only: the commissioner cannot read or set someone else's queue; outsiders see nothing.
    expect(errorCode(await alice.get(`${Q}?teamId=team-2`))).toBe('FORBIDDEN');
    expect(errorCode(await alice.put(Q, { teamId: 'team-2', playerIds: [] }))).toBe('FORBIDDEN');
    expect(errorCode(await carol.get(Q))).toBe('FORBIDDEN');
    expect(errorCode(await carol.put(Q, { playerIds: [] }))).toBe('FORBIDDEN');
    const unknown = await bob.put(Q, { playerIds: ['fx-cmc', 'nobody'] });
    expect(unknown.body).toMatchObject({
      error: { code: 'PLAYER_NOT_FOUND', details: { unknownPlayerIds: ['nobody'] } }
    });
    const tooMany = await bob.put(Q, { playerIds: Array.from({ length: 51 }, (_, i) => `p${i}`) });
    expect(tooMany.status).toBe(400);
    expect((await h.repos.drafts.getQueue(L, 'team-2'))?.playerIds).toEqual(['fx-bijan', 'fx-kelce']);
    // Clearing it is an empty list; Alice's own queue is hers alone.
    expect(data(await alice.put(Q, { playerIds: ['fx-chase'] }))).toMatchObject({ teamId: 'team-1' });
    expect(data(await alice.put(Q, { playerIds: [] }))).toMatchObject({ players: [] });
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
    // AI teams show their manager (#159); people's teams show none.
    expect(started.order[0]?.manager).toBeNull();
    const agentNames = started.order.slice(2).map((o) => o.manager?.name);
    expect(agentNames.every((n) => typeof n === 'string' && n.length > 0)).toBe(true);
    expect(new Set(agentNames).size).toBe(agentNames.length);
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
    const reason = 'The best back on the board.';
    const res = await bob.post(
      `/leagues/${L}/draft/picks`,
      { player: 'CMC', pick: 1, reason },
      'bob-pick-0001'
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(data(res)).toMatchObject({
      pick: { overall: 1, round: 1, pick: 1, teamId: 'team-2', player: { id: 'fx-cmc', position: 'RB' } },
      draftComplete: false,
      onTheClock: { overall: 2, teamId: 'team-1', secondsLeft: 90 }
    });
    const replay = await bob.post(
      `/leagues/${L}/draft/picks`,
      { player: 'CMC', pick: 1, reason },
      'bob-pick-0001'
    );
    expect(replay.body).toEqual(res.body);
    const stored = (await h.repos.drafts.get(L))?.state.picks;
    expect(stored).toHaveLength(1);
    expect(stored?.[0]).toMatchObject({ reason, adp: expect.any(Number) });
    expect((await h.repos.teams.get(L, 'team-2'))?.roster).toEqual(['fx-cmc']);
    // A human's first-round pick at his ADP is not notable; the reason still goes with it.
    expect(events('Draft Pick Made')).toEqual([
      expect.objectContaining({
        detail: expect.objectContaining({
          playerId: 'fx-cmc',
          overall: 1,
          auto: false,
          notable: null,
          reason
        })
      })
    ]);
    const shown = await board(alice);
    expect(shown.picks[0]).toMatchObject({ reason, adp: stored?.[0]?.adp });
    expect(shown.recap).toBeNull();
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
    // Boards hear about the pause at once (pausing a paused draft says nothing more).
    expect(events('Draft Paused').map((e) => e.detail)).toEqual([
      { leagueId: L, pick: 3, secondsLeft: 70, pausedAt: h.clock.now().toISOString() }
    ]);
    expect((await agentPick('team-3', { playerId: 'fx-jjefferson' })).body).toMatchObject({
      error: { code: 'DRAFT_PAUSED' }
    });
    h.clock.advance(10 * 60_000);
    expect(await expire(3)).toEqual({ handled: true, outcome: 'paused' });
    const resumed = await alice.post(`/leagues/${L}/draft/resume`);
    expect(data(resumed)).toMatchObject({ status: 'in_progress', secondsLeft: 70 });
    expect(events('Draft Resumed').map((e) => e.detail)).toEqual([
      {
        leagueId: L,
        pick: 3,
        deadline: (data(resumed) as { deadline: string }).deadline,
        secondsLeft: 70,
        resumedAt: h.clock.now().toISOString()
      }
    ]);
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
    // The agent's queue leads with a drafted player; autopick takes the first one still available.
    const queued = await invokeTool({
      registry,
      services: h.services,
      principal: agent('team-3'),
      name: 'set_draft_queue',
      args: { leagueId: L, playerIds: ['fx-cmc', 'fx-kelce'], idempotencyKey: 'agent-queue-0001' }
    });
    expect(queued.body).toMatchObject({
      data: { players: [{ available: false }, { player: { id: 'fx-kelce' }, available: true }] }
    });
    expect(await expire(3)).toEqual({ handled: true, outcome: 'autopicked' });
    const draft = await h.repos.drafts.get(L);
    expect(draft?.state.picks[2]).toMatchObject({ teamId: 'team-3', auto: true, playerId: 'fx-kelce' });
    // A queued pick is still judged by ADP: Kelce (rank 45) at pick 3 is a reach.
    expect(events('Draft Pick Made').at(-1)?.detail).toMatchObject({
      teamId: 'team-3',
      auto: true,
      notable: 'reach',
      reason: null
    });
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
    const completed = events('Draft Completed')[0]?.detail as {
      recap: { agentPicks: { teamId: string }[] };
      recapText: string;
    };
    expect(completed.recap.agentPicks.map((e) => e.teamId)).toEqual([
      'team-3',
      'team-4',
      'team-5',
      'team-6',
      'team-7',
      'team-8'
    ]);
    expect(completed.recapText).toMatch(/^Draft recap: 128 picks\./);
    const done = await board(alice);
    expect(done).toMatchObject({ status: 'complete', onTheClock: null, yourNextPick: null, yourNeeds: [] });
    expect(done.recap?.agentPicks[0]).toMatchObject({
      teamId: 'team-3',
      overall: 3,
      player: { id: expect.any(String) }
    });
    expect(done.recap?.agentPicks).toHaveLength(6);
    expect(errorCode(await alice.post(`/leagues/${L}/draft/picks`, { playerId: 'fx-def-nyj' }))).toBe(
      'PHASE_NOT_ALLOWED'
    );
    expect(await expire(129)).toEqual({ handled: true, outcome: 'ignored' });
  });
});
