import { AGENT_CHAT_BUDGETS } from '../../src/chat/model.js';
import { matchupRoomId, yahooDefaultSettings } from '@fantasy/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentPrincipal } from '../../src/auth/principal.js';
import type { ChatContextPack } from '../../src/chat/context.js';
import { registry } from '../../src/operations/index.js';
import { fixtureDraftPool } from '../../src/players/fixtures.js';
import { invokeTool } from '../../src/registry/invoke.js';
import { recordStandings } from '../../src/season/scoring.js';
import { createHarness, START, type Harness } from '../support/harness.js';
import { as, data, errorCode, type Caller } from '../support/league-client.js';
import { ALICE, BOB, CAROL, seedLeague } from '../support/leagues.js';
import { redZoneGame, seedNflSchedule, seedSeasonLeague } from '../support/season.js';
import { seedTrade } from '../support/trades.js';

/**
 * Room context packs (#153) through the REST adapter: one pack per room kind, the same guards as
 * get_chat (members only, a DM for its two teams, a new occupant's DM tenure), and privacy: no
 * waiver bids, no other teams' pending offers, no private offer terms in a room everyone reads.
 */

const LG = 'lg-ctx';
const L = `/leagues/${LG}`;
const OUTSIDER = { sub: 'olive', name: 'Olive', email: 'olive@example.com' };

let h: Harness;
let alice: Caller;
let bob: Caller;
let carol: Caller;

interface Context {
  roomId: string;
  roomKind: string;
  pack: ChatContextPack;
}
type Pack<K extends ChatContextPack['kind']> = Extract<ChatContextPack, { kind: K }>;

async function context<K extends ChatContextPack['kind']>(
  caller: Caller,
  roomId: string,
  kind: K,
  query = ''
): Promise<Pack<K>> {
  const res = await caller.get(`${L}/chat/rooms/${roomId}/context${query}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const body = data<Context>(res);
  expect(body.roomId).toBe(roomId);
  expect(body.pack.kind).toBe(kind);
  return body.pack as Pack<K>;
}

beforeAll(async () => {
  h = await createHarness({ backend: 'memory', registry, players: fixtureDraftPool });
  alice = as(h, ALICE);
  bob = as(h, BOB);
  carol = as(h, CAROL);
  const faabSettings = () => {
    const settings = yahooDefaultSettings(4);
    settings.roster.slots = { QB: 1, RB: 1, BN: 1 };
    settings.waivers.type = 'faab';
    return settings;
  };
  const deps = { repos: h.repos, reference: h.services.data.reference };
  await seedNflSchedule(deps.reference);
  // team-1 Alice, team-2 Bob, team-3 an agent, team-4 Carol; week 3, weeks 1-2 final.
  await seedSeasonLeague(deps, {
    id: LG,
    owners: [ALICE, BOB, null, CAROL],
    overrides: { week: 3, settings: faabSettings() }
  });
  const played = (await h.repos.schedule.listMatchups(LG)).filter((m) => m.week <= 2);
  await h.repos.schedule.putMatchups(
    played.map((m, i) => ({ ...m, status: 'final' as const, homeScore: 100 + i * 10, awayScore: 95 + i }))
  );
  const league = await h.repos.leagues.get(LG);
  await recordStandings({ repos: h.repos }, league!, 2, new Date(START));
});
afterAll(() => h.close());

describe('get_chat_context', () => {
  it('league rooms: standings, last week, power rankings, and a head-to-head on request', async () => {
    const week1 = (await h.repos.schedule.listMatchups(LG, 1)).find(
      (m) => m.homeTeamId === 'team-1' || m.awayTeamId === 'team-1'
    )!;
    const rival = week1.homeTeamId === 'team-1' ? week1.awayTeamId : week1.homeTeamId;
    const pack = await context(alice, 'trash-talk', 'league', `?aboutTeamId=${rival}`);
    expect(pack.throughWeek).toBe(2);
    expect(pack.standings).toHaveLength(4);
    expect(pack.standings[0]).toMatchObject({ rank: 1, record: expect.stringMatching(/^\d-\d/) });
    expect(pack.lastWeek).toHaveLength(2);
    expect(pack.powerTop.map((p) => p.rank)).toEqual([1, 2, 3]);
    expect(pack.headToHead).toMatchObject({ teamId: rival });
    const series = pack.headToHead!;
    expect(series.wins + series.losses + series.ties).toBeGreaterThanOrEqual(1);
    // The same room without a target, or about yourself: no head-to-head.
    expect((await context(alice, 'league', 'league')).headToHead).toBeNull();
    expect((await context(alice, 'league', 'league', '?aboutTeamId=team-1')).headToHead).toBeNull();
  });

  it('a matchup room: both lineups with points, projections, win chances, the red zone, and the series', async () => {
    const game = (await h.repos.schedule.listMatchups(LG, 3)).find(
      (m) => m.homeTeamId === 'team-1' || m.awayTeamId === 'team-1'
    )!;
    const roomId = matchupRoomId(2026, 3, game.id);
    await h.services.data.reference.nflGames.put({
      season: 2026,
      week: 3,
      games: [redZoneGame('2026_03_MIA_BUF')],
      updatedAt: h.clock.now().toISOString()
    });
    const pack = await context(bob, roomId, 'matchup');
    expect(pack.week).toBe(3);
    expect(pack.sides.map((s) => s.teamId)).toEqual([game.homeTeamId, game.awayTeamId]);
    const team1 = pack.sides.find((s) => s.teamId === 'team-1')!;
    expect(team1.starters.length).toBeGreaterThan(5);
    expect(team1.starters.every((s) => s.slot !== 'BN' && s.slot !== 'IR')).toBe(true);
    for (const side of pack.sides) {
      expect(side.winProbability).toBeGreaterThanOrEqual(0);
      expect(side.winProbability).toBeLessThanOrEqual(1);
    }
    expect(pack.series).not.toBeUndefined();
    // Only starters on the team with the ball inside the 20 are flagged.
    expect(team1.starters.find((s) => s.name === 'Josh Allen')).toMatchObject({ slot: 'QB', redZone: true });
    for (const s of pack.sides.flatMap((x) => x.starters)) expect(s.redZone).toBe(s.nflTeam === 'BUF');
  });

  it('the trades room: recent public trades and your own, never an open offer’s terms', async () => {
    const recentAt = new Date(h.clock.now().getTime() - 2 * 86_400_000).toISOString();
    const processed = await seedTrade(h.repos, {
      leagueId: LG,
      id: 'tr-done',
      from: 'team-1',
      to: 'team-2',
      fromSends: ['fx-mahomes'],
      toSends: ['fx-hurts'],
      status: 'processed'
    });
    await h.repos.trades.update({
      ...processed,
      trade: { ...processed.trade, history: [{ status: 'processed', at: recentAt, byTeamId: null }] }
    });
    await seedTrade(h.repos, {
      leagueId: LG,
      id: 'tr-private',
      from: 'team-2',
      to: 'team-4',
      fromSends: ['fx-lamar'],
      toSends: []
    });
    await seedTrade(h.repos, {
      leagueId: LG,
      id: 'tr-mine-open',
      from: 'team-1',
      to: 'team-3',
      fromSends: ['fx-kelce'],
      toSends: []
    });
    const pack = await context(alice, 'trades', 'trades');
    expect(pack.recent.map((t) => t.tradeId)).toEqual(['tr-done']);
    expect(pack.recent[0]).toMatchObject({ fromSends: ['Patrick Mahomes'], toSends: ['Jalen Hurts'] });
    expect(pack.yours.map((t) => t.tradeId)).toEqual(['tr-done']);
    expect(pack.yourOpenOffers).toBe(1);
    expect(pack.deadline).toMatchObject({ week: expect.any(Number), passed: false });
    const text = JSON.stringify(pack);
    expect(text).not.toContain('tr-private');
    expect(text).not.toContain('Lamar');
    expect(text).not.toContain('tr-mine-open');
    expect(text).not.toContain('Kelce');
  });

  it('waivers-news: the last run’s awards, FAAB, and trending adds; never a sealed bid', async () => {
    await h.repos.waivers.addTransactions([
      {
        id: 'tx-1',
        leagueId: LG,
        at: '2026-09-10T10:00:00.000Z',
        week: 2,
        type: 'waiver_claim',
        teamId: 'team-4',
        addPlayerId: 'fx-rb-1',
        dropPlayerId: null,
        cost: 17,
        claimId: 'c-1'
      }
    ]);
    await h.repos.waivers.createClaim({
      id: 'c-sealed',
      leagueId: LG,
      teamId: 'team-2',
      addPlayerId: 'fx-wr-2',
      dropPlayerId: null,
      bid: 77,
      priority: 1,
      status: 'pending',
      week: 3,
      processesAt: '2026-09-17T10:00:00.000Z',
      createdAt: START,
      createdBy: 'user#bob',
      resolvedAt: null,
      failure: null,
      cost: null,
      awardingRunId: null,
      version: 1
    });
    const pack = await context(alice, 'waivers-news', 'waivers');
    expect(pack.lastRun).toMatchObject({
      week: 2,
      awards: [{ teamId: 'team-4', player: { name: 'Reserve RB1' }, cost: 17 }]
    });
    expect(pack.faab).toHaveLength(4);
    expect(pack.trending).toEqual([]);
    const text = JSON.stringify(pack);
    expect(text).not.toContain('77');
    expect(text).not.toContain('WR2');
  });

  it('a DM: the two teams’ trades and offers, the other team’s needs, and head-to-head', async () => {
    await seedTrade(h.repos, {
      leagueId: LG,
      id: 'tr-dm-offer',
      from: 'team-2',
      to: 'team-1',
      fromSends: ['fx-tucker'],
      toSends: ['fx-butker']
    });
    const pack = await context(alice, 'dm-team-1-team-2', 'dm');
    expect(pack.other).toEqual({ teamId: 'team-2', teamName: "Bob's Team" });
    expect(pack.trades.map((t) => t.tradeId).sort()).toEqual(['tr-dm-offer', 'tr-done']);
    expect(Array.isArray(pack.otherNeeds)).toBe(true);
    expect(JSON.stringify(pack)).not.toContain('tr-private');
    // Bob sees the same relationship from his side.
    expect((await context(bob, 'dm-team-1-team-2', 'dm')).other.teamId).toBe('team-1');

    // A new occupant of team-1 does not inherit the previous one's private offers.
    const team = await h.repos.teams.get(LG, 'team-1');
    const updated = await h.repos.teams.update({ ...team!, occupiedSince: '2026-09-11T00:00:00.000Z' });
    const after = await context(alice, 'dm-team-1-team-2', 'dm');
    expect(after.trades.map((t) => t.tradeId)).toEqual(['tr-done']);
    await h.repos.teams.update({ ...updated, occupiedSince: team!.createdAt });
  });

  it('is guarded like get_chat', async () => {
    expect(errorCode(await carol.get(`${L}/chat/rooms/dm-team-1-team-2/context`))).toBe('FORBIDDEN');
    expect(errorCode(await as(h, OUTSIDER).get(`${L}/chat/rooms/league/context`))).toBe('FORBIDDEN');
    expect(errorCode(await alice.get(`${L}/chat/rooms/general/context`))).toBe('ROOM_NOT_FOUND');
    expect(errorCode(await alice.get(`${L}/chat/rooms/m-2026-W09-W09-1/context`))).toBe('ROOM_NOT_FOUND');
    // The agent playing team-3 reads its own rooms through the same pipeline.
    const agentRead = await invokeTool({
      registry,
      services: h.services,
      principal: agentPrincipal({ agentId: `${LG}.team-3`, teamId: 'team-3', leagueId: LG }),
      name: 'get_chat_context',
      args: { leagueId: LG, roomId: 'dm-team-1-team-3' }
    });
    expect(agentRead.status).toBe(200);
    expect((agentRead.body as { data: Context }).data.pack).toMatchObject({
      kind: 'dm',
      other: { teamId: 'team-1' }
    });
  });
});

describe('get_chat_context: the draft room', () => {
  const D = 'lg-ctx-draft';
  it('shows the latest picks and yours, before and during the draft', async () => {
    await seedLeague(h.repos, { id: D, owners: [ALICE, BOB], teamCount: 4 });
    const read = async () =>
      data<Context>(await alice.get(`/leagues/${D}/chat/rooms/draft/context`)).pack as Pack<'draft'>;
    expect(await read()).toMatchObject({ status: 'not_started', picksMade: 0, recentPicks: [] });
    const started = await alice.post(`/leagues/${D}/draft/start`, {
      order: ['team-1', 'team-2', 'team-3', 'team-4']
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const first = await alice.post(`/leagues/${D}/draft/picks`, { playerId: 'fx-cmc' });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect((await bob.post(`/leagues/${D}/draft/picks`, { playerId: 'fx-chase' })).status).toBe(200);
    const pack = await read();
    expect(pack).toMatchObject({ status: 'in_progress', picksMade: 2, steals: [], reaches: [] });
    expect(pack.yourPicks.map((p) => p.name)).toEqual(['Christian McCaffrey']);
    expect(pack.recentPicks.map((p) => [p.overall, p.teamId])).toEqual([
      [1, 'team-1'],
      [2, 'team-2']
    ]);
  });
});

describe('post_message: replies and agent-to-agent retorts', () => {
  const B = 'lg-banter';
  let seq = 0;
  const agentCall = (teamId: string, name: string, args: Record<string, unknown>) =>
    invokeTool({
      registry,
      services: h.services,
      principal: agentPrincipal({ agentId: `${B}.${teamId}`, teamId, leagueId: B }),
      name,
      args: {
        leagueId: B,
        ...args,
        ...(name === 'post_message' ? { idempotencyKey: `banter-${++seq}-key` } : {})
      }
    });
  const posted = (res: { body: unknown }) =>
    (res.body as { data: { message: { id: string; replyToId?: string; replyToAgentDepth?: number } } }).data
      .message;
  const lastMention = () => h.events.events.filter((e) => e.detailType === 'Chat Mention').at(-1)?.detail;

  it('marks an agent’s answer to an agent as a retort, and counts retorts against a daily budget', async () => {
    await seedLeague(h.repos, {
      id: B,
      owners: [ALICE],
      teamCount: 4,
      overrides: { phase: 'regular_season', week: 3 }
    });
    const jab = posted(
      await agentCall('team-2', 'post_message', { roomId: 'trash-talk', text: 'Nice bench, @team-3' })
    );
    expect(jab.replyToAgentDepth).toBeUndefined();
    expect(lastMention()).toMatchObject({
      authorType: 'agent',
      mentionedTeamIds: ['team-3'],
      replyToAgentDepth: 0
    });

    const retort = posted(
      await agentCall('team-3', 'post_message', {
        roomId: 'trash-talk',
        text: 'Says @team-2',
        replyToId: jab.id
      })
    );
    expect(retort).toMatchObject({ replyToId: jab.id, replyToAgentDepth: 1 });
    expect(lastMention()).toMatchObject({ mentionedTeamIds: ['team-2'], replyToAgentDepth: 1 });

    // A person answering an agent starts over at depth 0.
    const human = data<{ message: { replyToId: string; replyToAgentDepth?: number } }>(
      await as(h, ALICE).post(`/leagues/${B}/chat/messages`, {
        roomId: 'trash-talk',
        text: 'Both of you, hush @team-2',
        replyToId: retort.id
      })
    ).message;
    expect(human.replyToId).toBe(retort.id);
    expect(human.replyToAgentDepth).toBeUndefined();
    expect(lastMention()).toMatchObject({ authorType: 'user', replyToAgentDepth: 0 });

    // A reply must name a recent message of the same room.
    const stray = await agentCall('team-3', 'post_message', {
      roomId: 'league',
      text: 'hm',
      replyToId: jab.id
    });
    expect(stray.status).toBe(400);
    expect(stray.body).toMatchObject({ error: { code: 'INVALID_INPUT' } });

    const budget = async () =>
      (
        (await agentCall('team-4', 'list_chat_rooms', {})).body as {
          data: { postingBudget: { banterRemaining: number } };
        }
      ).data.postingBudget.banterRemaining;
    // One retort so far today.
    const left = AGENT_CHAT_BUDGETS.banterPerDay - 1;
    expect(await budget()).toBe(left);
    for (let i = 0; i < left; i++) {
      h.clock.advance(61_000);
      const res = await agentCall(`team-${2 + (i % 3)}`, 'post_message', {
        roomId: 'trash-talk',
        text: `retort ${i}`,
        replyToId: jab.id
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
    expect(await budget()).toBe(0);
    h.clock.advance(61_000);
    const refused = await agentCall('team-4', 'post_message', {
      roomId: 'trash-talk',
      text: 'one more',
      replyToId: jab.id
    });
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ error: { code: 'RATE_LIMITED', details: { banterRemaining: 0 } } });
    // Plain posts still go through: the banter budget only limits retorts.
    expect((await agentCall('team-4', 'post_message', { roomId: 'trash-talk', text: 'plain' })).status).toBe(
      200
    );
  });
});
