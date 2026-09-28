import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { agentPrincipal } from '../../src/auth/principal.js';
import { postSystemMessage } from '../../src/chat/system-messages.js';
import { handleLeagueEvent } from '../../src/events/handlers.js';
import { processWaivers } from '../../src/jobs/process-waivers.js';
import { silentLogger } from '../../src/log.js';
import { registry } from '../../src/operations/index.js';
import { invokeTool } from '../../src/registry/invoke.js';
import type { League } from '../../src/repos/types.js';
import { reviewEndName, tradeDeadlineName } from '../../src/trades/lifecycle.js';
import { createHarness, START, type Harness } from '../support/harness.js';
import { as, data, errorCode, type Caller } from '../support/league-client.js';
import { ALICE, BOB, CAROL } from '../support/leagues.js';
import { seedTrade } from '../support/trades.js';
import { seedSeasonLeague } from '../support/waivers.js';

/**
 * Trade integrity (#121) over the REST adapter and DynamoDB Local: moving the deadline in season, offers
 * that can no longer work (a player moved), players held while their trade processes, a no-review
 * trade that fails partway, review into the playoffs, the offer limit, withdrawals, private notes,
 * and the commissioner's own trade. Rosters are 3 active spots (QB, RB, BN).
 */

let h: Harness;
let alice: Caller;
let bob: Caller;
let carol: Caller;

const eventsOf = (type: string) => h.events.events.filter((e) => e.detailType === type);
let eventSeq = 0;
const timer = (detailType: string, detail: Record<string, unknown>) =>
  handleLeagueEvent(h.services, {
    id: `evt-i-${++eventSeq}`,
    'detail-type': detailType,
    source: 'fantasy',
    detail
  });
const roster = async (leagueId: string, teamId: string) =>
  (await h.repos.teams.get(leagueId, teamId))?.roster;
const waiverJob = () =>
  processWaivers(
    { repos: h.repos, reference: h.services.data.reference, events: h.events, log: silentLogger },
    h.clock
  );

interface View {
  id: string;
  status: string;
  message: string | null;
  reply: string | null;
  yourActions: string[];
  reviewEndsAt: string | null;
  voidReason: { code: string; message: string; fix: string } | null;
}
const trade = (res: Awaited<ReturnType<Caller['get']>>) => data<{ trade: View }>(res).trade;
async function propose(c: Caller, leagueId: string, body: Record<string, unknown>): Promise<View> {
  const res = await c.post(`/leagues/${leagueId}/trades`, body);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return trade(res);
}
async function view(c: Caller, leagueId: string, tradeId: string): Promise<View> {
  const [found] = data<{ trades: View[] }>(
    await c.get(`/leagues/${leagueId}/trades?tradeId=${tradeId}`)
  ).trades;
  if (found === undefined) throw new Error(`trade ${tradeId} not visible`);
  return found;
}
async function patchLeague(id: string, patch: (league: League) => Partial<League>): Promise<League> {
  const league = await h.repos.leagues.get(id);
  if (league === null) throw new Error(id);
  return h.repos.leagues.update({ ...league, ...patch(league) });
}
async function reviewMode(id: string, review: 'none' | 'commissioner' | 'league_vote') {
  await patchLeague(id, (l) => ({
    settings: { ...l.settings, trades: { ...l.settings.trades, review } }
  }));
}
/** Marks a seeded trade as accepted and mid-processing (stamped, players not moved yet). */
async function processing(
  leagueId: string,
  id: string,
  from: string,
  to: string,
  sends: [string[], string[]]
) {
  const record = await seedTrade(h.repos, {
    leagueId,
    id,
    from,
    to,
    fromSends: sends[0],
    toSends: sends[1],
    status: 'accepted'
  });
  return h.repos.trades.update({ ...record, processingAt: START });
}

beforeAll(async () => {
  h = await createHarness({ backend: 'dynamo', registry });
  alice = as(h, ALICE);
  bob = as(h, BOB);
  carol = as(h, CAROL);
});
afterAll(() => h.close());

describe('the trade deadline', () => {
  const game = (week: number, kickoff: string) => ({
    gameId: `2026_${week}_BAL_KC`,
    season: 2026,
    seasonType: 'regular' as const,
    week,
    kickoff,
    homeTeam: 'KC',
    awayTeam: 'BAL',
    status: 'scheduled' as const
  });
  const WEEK_11 = '2026-11-20T01:15:00.000Z';
  const WEEK_12 = '2026-11-27T01:15:00.000Z';

  it('moves with trades.deadlineWeek in season; the old deadline event does nothing', async () => {
    await h.services.data.reference.schedule.putSeason(
      2026,
      [game(11, WEEK_11), game(12, WEEK_12)],
      {},
      new Date(START)
    );
    await seedSeasonLeague(h.repos, {
      id: 'lg-dl',
      owners: [ALICE, BOB],
      rosters: { 'team-1': ['fx-jallen'], 'team-2': ['fx-mahomes'] }
    });
    await patchLeague('lg-dl', (l) => ({ deadlines: { ...l.deadlines, tradeDeadlineAt: WEEK_11 } }));

    const res = await alice.patch('/leagues/lg-dl/settings', { changes: { trades: { deadlineWeek: 12 } } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await h.repos.leagues.get('lg-dl'))?.deadlines.tradeDeadlineAt).toBe(WEEK_12);
    expect(eventsOf('Schedule Event').at(-1)?.detail).toMatchObject({
      at: WEEK_12,
      name: tradeDeadlineName('lg-dl'),
      event: { detailType: 'Trade Deadline Passed', detail: { deadlineWeek: 12, deadlineAt: WEEK_12 } }
    });

    const offer = await propose(alice, 'lg-dl', { withTeamId: 'team-2', send: ['fx-jallen'] });
    h.clock.set(WEEK_11);
    expect((await timer('Trade Deadline Passed', { leagueId: 'lg-dl' })).outcome).toBe('early');
    expect((await h.repos.trades.get('lg-dl', offer.id))?.trade.status).toBe('proposed');
    const announce = (id: string) =>
      postSystemMessage(h.services, {
        id,
        'detail-type': 'Trade Deadline Passed',
        source: 'fantasy',
        detail: { leagueId: 'lg-dl', deadlineWeek: 11, deadlineAt: WEEK_11 }
      });
    expect(await announce('old-deadline-1')).toEqual({ status: 'skipped', reason: 'stale' });
    h.clock.set(WEEK_12);
    expect((await timer('Trade Deadline Passed', { leagueId: 'lg-dl' })).outcome).toEqual({ expired: 1 });
    expect((await announce('deadline-2')).status).toBe('posted');
    h.clock.set(START);
  });

  it('keeps the deadline as is when other settings change, or before the season', async () => {
    await seedSeasonLeague(h.repos, {
      id: 'lg-dl2',
      owners: [ALICE],
      rosters: {},
      overrides: { phase: 'drafting', week: null }
    });
    const scheduled = eventsOf('Schedule Event').length;
    const res = await alice.patch('/leagues/lg-dl2/settings', { changes: { trades: { deadlineWeek: 12 } } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await h.repos.leagues.get('lg-dl2'))?.deadlines.tradeDeadlineAt).toBeNull();
    expect(eventsOf('Schedule Event')).toHaveLength(scheduled);
  });
});

describe('offers that can no longer work', () => {
  beforeAll(async () => {
    await seedSeasonLeague(h.repos, {
      id: 'lg-so',
      owners: [ALICE, BOB, CAROL],
      rosters: {
        'team-1': ['fx-jallen', 'fx-cmc'],
        'team-2': ['fx-mahomes', 'fx-bijan'],
        'team-3': ['fx-hurts', 'fx-chase']
      }
    });
  });

  it('voids an open offer when one of its players is dropped', async () => {
    const offer = await propose(alice, 'lg-so', {
      withTeamId: 'team-2',
      send: ['fx-cmc'],
      receive: ['fx-bijan']
    });
    const other = await propose(alice, 'lg-so', { withTeamId: 'team-3', send: ['fx-jallen'] });
    expect((await bob.post('/leagues/lg-so/drops', { playerId: 'fx-bijan' })).status).toBe(200);
    const voided = await view(alice, 'lg-so', offer.id);
    expect(voided).toMatchObject({ status: 'expired', voidReason: { code: 'PLAYER_MOVED' } });
    expect(voided.voidReason?.message).toContain('Bijan Robinson');
    expect(eventsOf('Trade Expired').at(-1)?.detail).toMatchObject({
      tradeId: offer.id,
      voided: true,
      reasonCode: 'PLAYER_MOVED',
      teamIds: ['team-1', 'team-2']
    });
    expect((await view(alice, 'lg-so', other.id)).status).toBe('proposed');
    expect(
      errorCode(await bob.post(`/leagues/lg-so/trades/${offer.id}/respond`, { response: 'accept' }))
    ).toBe('ILLEGAL_TRADE_TRANSITION');
    await alice.post(`/leagues/lg-so/trades/${other.id}/withdraw`);
  });

  it('voids an open offer when its player is dropped for a free agent', async () => {
    const offer = await propose(carol, 'lg-so', { withTeamId: 'team-1', send: ['fx-chase'] });
    const res = await carol.post('/leagues/lg-so/waivers/claims', {
      playerId: 'fx-lamb',
      dropPlayerId: 'fx-chase'
    });
    expect(data(res)).toMatchObject({ outcome: 'added' });
    expect((await view(carol, 'lg-so', offer.id)).voidReason?.code).toBe('PLAYER_MOVED');
  });

  it('voids an open offer when a waiver award drops its player', async () => {
    // Bijan (dropped above) is on waivers; Alice claims him, dropping Allen, who is in an offer.
    const claim = await alice.post('/leagues/lg-so/waivers/claims', {
      playerId: 'fx-bijan',
      dropPlayerId: 'fx-jallen',
      bid: 1
    });
    expect(data(claim)).toMatchObject({ outcome: 'claim_pending' });
    const offer = await propose(alice, 'lg-so', {
      withTeamId: 'team-3',
      send: ['fx-jallen'],
      receive: ['fx-hurts']
    });
    h.clock.set('2026-09-13T08:00:00.000Z');
    await waiverJob();
    expect(await roster('lg-so', 'team-1')).toContain('fx-bijan');
    expect((await view(alice, 'lg-so', offer.id)).voidReason?.code).toBe('PLAYER_MOVED');
    h.clock.set(START);
  });
});

describe('players in a trade that is processing', () => {
  beforeAll(async () => {
    await seedSeasonLeague(h.repos, {
      id: 'lg-pt',
      owners: [ALICE, BOB, CAROL],
      rosters: {
        'team-1': ['fx-jallen', 'fx-cmc'],
        'team-2': ['fx-mahomes', 'fx-bijan'],
        'team-3': ['fx-hurts']
      }
    });
    await processing('lg-pt', 'mid-trade', 'team-1', 'team-2', [['fx-cmc'], ['fx-bijan']]);
  });

  it('cannot be dropped, or dropped for a free agent', async () => {
    const drop = await alice.post('/leagues/lg-pt/drops', { playerId: 'fx-cmc' });
    expect(drop.body).toMatchObject({
      error: {
        code: 'PLAYER_IN_TRADE',
        fix: expect.stringContaining('Wait'),
        details: { tradeId: 'mid-trade' }
      }
    });
    expect(
      errorCode(
        await bob.post('/leagues/lg-pt/waivers/claims', { playerId: 'fx-lamb', dropPlayerId: 'fx-bijan' })
      )
    ).toBe('PLAYER_IN_TRADE');
    expect(await roster('lg-pt', 'team-1')).toEqual(['fx-jallen', 'fx-cmc']);
  });

  it('fails a pending waiver claim that would drop one of them', async () => {
    // The claim was made before the trade started processing.
    await h.repos.waivers.putWireEntry({
      leagueId: 'lg-pt',
      playerId: 'fx-chase',
      droppedByTeamId: 'team-3',
      droppedAt: START,
      clearsAt: '2026-09-12T08:00:00.000Z'
    });
    await h.repos.waivers.createClaim({
      id: 'claim-in-trade',
      leagueId: 'lg-pt',
      teamId: 'team-2',
      addPlayerId: 'fx-chase',
      dropPlayerId: 'fx-bijan',
      bid: 1,
      priority: 1,
      status: 'pending',
      week: 2,
      processesAt: '2026-09-13T08:00:00.000Z',
      createdAt: START,
      createdBy: 'user#bob',
      resolvedAt: null,
      cost: null,
      failure: null,
      awardingRunId: null,
      version: 1
    });
    h.clock.set('2026-09-13T08:00:00.000Z');
    await waiverJob();
    expect(await h.repos.waivers.getClaim('lg-pt', 'claim-in-trade')).toMatchObject({
      status: 'failed',
      failure: { code: 'PLAYER_IN_TRADE' }
    });
    expect(await roster('lg-pt', 'team-2')).toEqual(['fx-mahomes', 'fx-bijan']);
    h.clock.set(START);
  });
});

describe('a no-review trade that fails partway', () => {
  it('is finished by the review timer scheduled before processing', async () => {
    await seedSeasonLeague(h.repos, {
      id: 'lg-nr',
      owners: [ALICE, BOB, CAROL],
      rosters: {
        'team-1': ['fx-jallen', 'fx-cmc'],
        'team-2': ['fx-mahomes', 'fx-bijan'],
        'team-3': ['fx-hurts']
      }
    });
    await reviewMode('lg-nr', 'none');
    const offer = await propose(alice, 'lg-nr', {
      withTeamId: 'team-2',
      send: ['fx-cmc'],
      receive: ['fx-bijan']
    });
    const stale = await propose(carol, 'lg-nr', {
      withTeamId: 'team-1',
      send: ['fx-hurts'],
      receive: ['fx-cmc']
    });
    vi.spyOn(h.repos.waivers, 'addTransactions').mockRejectedValueOnce(new Error('table down'));
    const failed = await bob.post(`/leagues/lg-nr/trades/${offer.id}/respond`, { response: 'accept' });
    expect(failed.status).toBe(500);
    expect(eventsOf('Schedule Event').at(-1)?.detail).toMatchObject({
      at: START,
      name: reviewEndName('lg-nr', offer.id),
      event: { detailType: 'Trade Review Ended', detail: { tradeId: offer.id } }
    });
    const stuck = await h.repos.trades.get('lg-nr', offer.id);
    expect(stuck).toMatchObject({ processingAt: START, trade: { status: 'accepted' } });

    expect((await timer('Trade Review Ended', { leagueId: 'lg-nr', tradeId: offer.id })).outcome).toBe(
      'processed'
    );
    expect(await roster('lg-nr', 'team-1')).toEqual(['fx-jallen', 'fx-bijan']);
    expect(await roster('lg-nr', 'team-2')).toEqual(['fx-mahomes', 'fx-cmc']);
    // Carol's offer asked for McCaffrey, who has moved.
    expect((await view(carol, 'lg-nr', stale.id)).voidReason?.code).toBe('PLAYER_MOVED');
  });
});

describe('review', () => {
  beforeAll(async () => {
    await seedSeasonLeague(h.repos, {
      id: 'lg-rv',
      owners: [ALICE, BOB, CAROL, null],
      rosters: {
        'team-1': ['fx-jallen'],
        'team-2': ['fx-mahomes'],
        'team-3': ['fx-hurts'],
        'team-4': ['fx-lamar']
      }
    });
    await reviewMode('lg-rv', 'commissioner');
  });

  it('goes on into the playoffs, where the commissioner can still approve', async () => {
    const offer = await propose(bob, 'lg-rv', {
      withTeamId: 'team-3',
      send: ['fx-mahomes'],
      receive: ['fx-hurts']
    });
    await carol.post(`/leagues/lg-rv/trades/${offer.id}/respond`, { response: 'accept' });
    await patchLeague('lg-rv', () => ({ phase: 'playoffs', week: 15 }));
    const approved = trade(
      await alice.post(`/leagues/lg-rv/trades/${offer.id}/votes`, { decision: 'approve' })
    );
    expect(approved.status).toBe('processed');
    expect(await roster('lg-rv', 'team-2')).toEqual(['fx-hurts']);
    await patchLeague('lg-rv', () => ({ phase: 'regular_season', week: 2 }));
  });

  it('sends the commissioner’s own trade to a league vote', async () => {
    const offer = await propose(alice, 'lg-rv', {
      withTeamId: 'team-2',
      send: ['fx-jallen'],
      receive: ['fx-hurts']
    });
    const accepted = trade(
      await bob.post(`/leagues/lg-rv/trades/${offer.id}/respond`, { response: 'accept' })
    );
    expect(accepted.status).toBe('in_review');
    expect(eventsOf('Trade Accepted').at(-1)?.detail).toMatchObject({
      tradeId: offer.id,
      review: 'league_vote'
    });
    expect((await view(alice, 'lg-rv', offer.id)).yourActions).toEqual([]);
    expect((await view(carol, 'lg-rv', offer.id)).yourActions).toEqual(['vote']);

    const self = await alice.post(`/leagues/lg-rv/trades/${offer.id}/votes`, { decision: 'approve' });
    expect(self.body).toMatchObject({
      error: { code: 'VOTE_NOT_ALLOWED', message: expect.stringContaining('league reviews it by vote') }
    });
    expect(errorCode(await alice.post(`/leagues/lg-rv/trades/${offer.id}/votes`, { decision: 'veto' }))).toBe(
      'VOTE_NOT_ALLOWED'
    );
    expect(
      errorCode(await carol.post(`/leagues/lg-rv/trades/${offer.id}/votes`, { decision: 'approve' }))
    ).toBe('VOTE_NOT_ALLOWED');
    expect(
      trade(await carol.post(`/leagues/lg-rv/trades/${offer.id}/votes`, { decision: 'veto' }))
    ).toMatchObject({ status: 'in_review' });

    h.clock.set(accepted.reviewEndsAt as string);
    expect((await timer('Trade Review Ended', { leagueId: 'lg-rv', tradeId: offer.id })).outcome).toBe(
      'processed'
    );
    expect(await roster('lg-rv', 'team-1')).toEqual(['fx-hurts']);
    h.clock.set(START);
  });
});

describe('offers', () => {
  beforeAll(async () => {
    await seedSeasonLeague(h.repos, {
      id: 'lg-of',
      owners: [ALICE, BOB, CAROL, null],
      rosters: {
        'team-1': ['fx-jallen', 'fx-cmc'],
        'team-2': ['fx-mahomes', 'fx-bijan'],
        'team-3': ['fx-hurts'],
        'team-4': ['fx-lamar', 'fx-jtaylor']
      }
    });
  });

  it('limits open offers from one team to another, with a fix', async () => {
    const first = await propose(alice, 'lg-of', {
      withTeamId: 'team-2',
      send: ['fx-cmc'],
      receive: ['fx-bijan']
    });
    await propose(alice, 'lg-of', { withTeamId: 'team-2', send: ['fx-jallen'], receive: ['fx-mahomes'] });
    const third = await alice.post('/leagues/lg-of/trades', { withTeamId: 'team-2', send: ['fx-cmc'] });
    expect(third.body).toMatchObject({
      error: {
        code: 'TOO_MANY_OPEN_OFFERS',
        fix: expect.stringMatching(new RegExp(`withdraw_trade with tradeId .*${first.id}`)),
        details: { limit: 2 }
      }
    });
    // Other teams, and the other direction, are separate.
    await propose(alice, 'lg-of', { withTeamId: 'team-3', send: ['fx-cmc'] });
    await propose(bob, 'lg-of', { withTeamId: 'team-1', send: ['fx-bijan'] });
    const agent = await invokeTool({
      registry,
      services: h.services,
      principal: agentPrincipal({ agentId: 'agent-4', teamId: 'team-4', leagueId: 'lg-of' }),
      name: 'propose_trade',
      args: { leagueId: 'lg-of', withTeamId: 'team-1', send: ['fx-lamar'], idempotencyKey: 'of-agent-1' }
    });
    expect(agent.status).toBe(200);

    // Withdrawing makes room, and the two teams hear about it.
    const withdrawn = trade(await alice.post(`/leagues/lg-of/trades/${first.id}/withdraw`));
    expect(withdrawn.status).toBe('withdrawn');
    expect(eventsOf('Trade Withdrawn').at(-1)?.detail).toMatchObject({
      tradeId: first.id,
      status: 'withdrawn',
      teamIds: ['team-1', 'team-2']
    });
    await propose(alice, 'lg-of', { withTeamId: 'team-2', send: ['fx-cmc'] });
  });

  it('keeps notes between the two teams, and the reply apart from the offer’s note', async () => {
    const offer = await propose(bob, 'lg-of', {
      withTeamId: 'team-3',
      send: ['fx-mahomes'],
      receive: ['fx-hurts'],
      message: 'QB swap?'
    });
    const accepted = trade(
      await carol.post(`/leagues/lg-of/trades/${offer.id}/respond`, { response: 'accept', message: 'Deal.' })
    );
    expect(accepted).toMatchObject({ status: 'in_review', message: 'QB swap?', reply: 'Deal.' });
    expect(await view(bob, 'lg-of', offer.id)).toMatchObject({ message: 'QB swap?', reply: 'Deal.' });
    // Alice sees the accepted trade (to review it) but not the notes.
    expect(await view(alice, 'lg-of', offer.id)).toMatchObject({
      status: 'in_review',
      message: null,
      reply: null
    });

    const rejected = await propose(alice, 'lg-of', {
      withTeamId: 'team-3',
      send: ['fx-jallen'],
      message: 'Hi'
    });
    const answer = trade(
      await carol.post(`/leagues/lg-of/trades/${rejected.id}/respond`, {
        response: 'reject',
        message: 'No thanks.'
      })
    );
    expect(answer).toMatchObject({ status: 'rejected', message: 'Hi', reply: 'No thanks.' });
  });
});
