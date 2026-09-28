import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentPrincipal } from '../../src/auth/principal.js';
import { handleLeagueEvent } from '../../src/events/handlers.js';
import { registry } from '../../src/operations/index.js';
import { invokeTool } from '../../src/registry/invoke.js';
import { createHarness, START, type Harness } from '../support/harness.js';
import { as, data, errorCode, type Caller } from '../support/league-client.js';
import { ALICE, BOB, CAROL } from '../support/leagues.js';
import { seedSeasonLeague } from '../support/waivers.js';

/**
 * Trades end to end over the REST adapter and dynalite: preview, propose, counter, accept, league
 * review with veto votes, processing (rosters, locks, transactions, lineups), expiry, withdraw,
 * reject, the deadline, commissioner review, voiding, the lock wait, and the lopsided guard.
 * Rosters are 3 active spots (QB, RB, BN).
 */

const L = '/leagues/lg-t';
let h: Harness;
let alice: Caller;
let bob: Caller;
let carol: Caller;

const agent4 = agentPrincipal({ agentId: 'agent-4', teamId: 'team-4', leagueId: 'lg-t' });
const agent5 = agentPrincipal({ agentId: 'agent-5', teamId: 'team-5', leagueId: 'lg-t' });
const asAgent = async (principal: typeof agent4, name: string, args: Record<string, unknown>) =>
  (await invokeTool({ registry, services: h.services, principal, name, args: { leagueId: 'lg-t', ...args } }))
    .body;
const eventsOf = (type: string) => h.events.events.filter((e) => e.detailType === type);
let eventSeq = 0;
const timer = (detailType: string, detail: Record<string, unknown>) =>
  handleLeagueEvent(h.services, {
    id: `evt-${++eventSeq}`,
    'detail-type': detailType,
    source: 'fantasy',
    detail
  });
const roster = async (teamId: string, leagueId = 'lg-t') =>
  (await h.repos.teams.get(leagueId, teamId))?.roster;

interface View {
  id: string;
  status: string;
  direction: string;
  yourActions: string[];
  round: number;
  expiresAt: string;
  reviewEndsAt: string | null;
  vetoVotes: number;
}
const trade = (res: Awaited<ReturnType<Caller['get']>>) => data<{ trade: View }>(res).trade;
const listIds = async (c: Caller, query = '') =>
  data<{ trades: View[] }>(await c.get(`${L}/trades${query}`)).trades.map((t) => t.id);

async function propose(c: Caller, body: Record<string, unknown>): Promise<View> {
  const res = await c.post(`${L}/trades`, body);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return trade(res);
}

beforeAll(async () => {
  h = await createHarness({ backend: 'dynamo', registry });
  alice = as(h, ALICE);
  bob = as(h, BOB);
  carol = as(h, CAROL);
  await seedSeasonLeague(h.repos, {
    id: 'lg-t',
    teamCount: 5,
    owners: [ALICE, BOB, CAROL, null, null],
    rosters: {
      'team-1': ['fx-jallen', 'fx-cmc'],
      'team-2': ['fx-mahomes', 'fx-bijan', 'fx-chase'],
      'team-3': ['fx-hurts'],
      'team-4': ['fx-lamar', 'fx-jtaylor'],
      'team-5': ['fx-tucker', 'fx-swift']
    }
  });
});
afterAll(() => h.close());

describe('offers', () => {
  it('previews a trade: legality, both sides’ impact, and fairness', async () => {
    const preview = data(await alice.get(`${L}/trades/preview?withTeamId=team-2&send=fx-cmc&receive=bijan`));
    expect(preview).toMatchObject({
      valid: true,
      issues: [],
      sides: [
        { team: { id: 'team-1' }, sends: [{ id: 'fx-cmc' }], receives: [{ id: 'fx-bijan' }], activeAfter: 2 },
        { team: { id: 'team-2' }, activeBefore: 3, activeAfter: 3, dropsNeeded: 0 }
      ],
      fairness: { lopsided: false, fromWeek: 2, toWeek: 5 }
    });
    const over = data(await alice.get(`${L}/trades/preview?withTeamId=team-2&send=fx-cmc&send=fx-jallen`));
    expect(over).toMatchObject({
      valid: true,
      warnings: [{ code: 'RESPONDER_MUST_DROP' }],
      sides: [{}, { dropsNeeded: 2, dropCandidates: [{}, {}, {}] }]
    });
    const bad = data(await alice.get(`${L}/trades/preview?withTeamId=team-2&send=fx-lamar`));
    expect(bad).toMatchObject({ valid: false, issues: [{ code: 'PLAYER_NOT_ON_ROSTER' }] });
    expect(errorCode(await alice.get(`${L}/trades/preview`))).toBe('INVALID_INPUT');
  });

  it('proposes, keeps the offer private to the two teams, and schedules its expiry', async () => {
    const offer = await propose(alice, {
      withTeamId: 'team-2',
      send: ['fx-cmc'],
      receive: ['fx-bijan'],
      message: 'RB swap?'
    });
    expect(offer).toMatchObject({
      status: 'proposed',
      direction: 'outgoing',
      yourActions: ['withdraw'],
      round: 0,
      expiresAt: '2026-09-12T12:00:00.000Z'
    });
    expect(eventsOf('Trade Proposed').at(-1)?.detail).toMatchObject({
      leagueId: 'lg-t',
      tradeId: offer.id,
      fromTeamId: 'team-1',
      toTeamId: 'team-2',
      teamIds: ['team-1', 'team-2'],
      fromPlayers: [{ id: 'fx-cmc', name: 'Christian McCaffrey' }],
      toPlayers: [{ id: 'fx-bijan' }]
    });
    expect(eventsOf('Schedule Event').at(-1)?.detail).toMatchObject({
      at: offer.expiresAt,
      event: { detailType: 'Trade Offer Deadline', detail: { leagueId: 'lg-t', tradeId: offer.id } }
    });
    const incoming = data<{ trades: View[] }>(await bob.get(`${L}/trades?status=open`)).trades[0];
    expect(incoming).toMatchObject({
      id: offer.id,
      direction: 'incoming',
      yourActions: ['accept', 'reject', 'counter']
    });
    expect(await listIds(carol)).not.toContain(offer.id);
    expect(errorCode(await carol.get(`${L}/trades/preview?tradeId=${offer.id}`))).toBe('TRADE_NOT_FOUND');
    expect(errorCode(await carol.post(`${L}/trades/${offer.id}/respond`, { response: 'accept' }))).toBe(
      'TRADE_NOT_FOUND'
    );
  });

  it('refuses illegal offers with a fix', async () => {
    const byName = await alice.post(`${L}/trades`, { withTeamId: 'team-2', receive: ['Lamar Jackson'] });
    expect(byName.body).toMatchObject({ error: { code: 'PLAYER_NOT_ON_ROSTER' } });
    const notOnRoster = await alice.post(`${L}/trades`, { withTeamId: 'team-2', send: ['fx-lamar'] });
    expect(notOnRoster.body).toMatchObject({
      error: { code: 'PLAYER_NOT_ON_ROSTER', fix: expect.any(String) }
    });
    const full = await alice.post(`${L}/trades`, { withTeamId: 'team-2', receive: ['fx-bijan', 'fx-chase'] });
    expect(full.body).toMatchObject({
      error: {
        code: 'ROSTER_LIMIT_EXCEEDED',
        fix: expect.stringContaining('Add 1 more drop(s) for team team-1')
      }
    });
    expect(errorCode(await alice.post(`${L}/trades`, { withTeamId: 'team-1', send: ['fx-cmc'] }))).toBe(
      'TRADE_INVALID'
    );
    expect(errorCode(await alice.post(`${L}/trades`, { withTeamId: 'team-9', send: ['fx-cmc'] }))).toBe(
      'TEAM_NOT_FOUND'
    );
  });

  it('counters back and forth; only the team an offer was made to can answer it', async () => {
    const offer = await propose(alice, {
      withTeamId: 'team-2',
      send: ['fx-jallen'],
      receive: ['fx-mahomes']
    });
    const res = await bob.post(`${L}/trades/${offer.id}/counter`, {
      send: ['mahomes'],
      receive: ['fx-jallen', 'fx-cmc'],
      drops: ['fx-chase']
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const { trade: counter, countered } = data<{ trade: View; countered: View }>(res);
    expect(countered).toMatchObject({ id: offer.id, status: 'countered' });
    expect(counter).toMatchObject({ status: 'proposed', round: 1, direction: 'outgoing' });
    expect(eventsOf('Trade Countered').at(-1)?.detail).toMatchObject({
      tradeId: counter.id,
      fromTeamId: 'team-2',
      toTeamId: 'team-1',
      counterOf: offer.id
    });
    expect(errorCode(await bob.post(`${L}/trades/${offer.id}/counter`, { send: ['fx-bijan'] }))).toBe(
      'ILLEGAL_TRADE_TRANSITION'
    );
    expect(errorCode(await bob.post(`${L}/trades/${counter.id}/respond`, { response: 'accept' }))).toBe(
      'NOT_YOUR_TRADE_ACTION'
    );
    const rejected = trade(await alice.post(`${L}/trades/${counter.id}/respond`, { response: 'reject' }));
    expect(rejected.status).toBe('rejected');
    expect(eventsOf('Trade Rejected').at(-1)?.detail).toMatchObject({
      tradeId: counter.id,
      toTeamId: 'team-1'
    });
  });

  it('never lets an offer outlive the trade deadline; the responder drops to accept', async () => {
    const league = await h.repos.leagues.get('lg-t');
    if (league === null) throw new Error('league');
    const deadlines = league.deadlines;
    await h.repos.leagues.update({
      ...league,
      deadlines: { ...deadlines, tradeDeadlineAt: '2026-09-11T00:00:00.000Z' }
    });
    const res = await carol.post(`${L}/trades`, { withTeamId: 'team-2', send: ['fx-hurts'] });
    expect((res.body as { warnings: { code: string }[] }).warnings.map((w) => w.code)).toEqual([
      'RESPONDER_MUST_DROP'
    ]);
    const offer = trade(res);
    expect(offer.expiresAt).toBe('2026-09-11T00:00:00.000Z');
    expect(errorCode(await bob.post(`${L}/trades/${offer.id}/respond`, { response: 'accept' }))).toBe(
      'ROSTER_LIMIT_EXCEEDED'
    );
    const accepted = trade(
      await bob.post(`${L}/trades/${offer.id}/respond`, { response: 'accept', drops: ['fx-chase'] })
    );
    expect(accepted.status).toBe('in_review');
    // Keep the rest of the suite's rosters: the league vetoes it.
    await alice.post(`${L}/trades/${offer.id}/votes`, { decision: 'veto' });
    await asAgent(agent4, 'vote_trade', { tradeId: offer.id, idempotencyKey: 'agent-4-veto-deadline' });
    const current = await h.repos.leagues.get('lg-t');
    if (current === null) throw new Error('league');
    await h.repos.leagues.update({ ...current, deadlines });
  });

  it('withdraws an offer; a withdrawn offer cannot be answered', async () => {
    const offer = await propose(alice, { withTeamId: 'team-3', send: ['fx-jallen'], receive: ['fx-hurts'] });
    expect(errorCode(await carol.post(`${L}/trades/${offer.id}/withdraw`))).toBe('NOT_YOUR_TRADE_ACTION');
    expect(trade(await alice.post(`${L}/trades/${offer.id}/withdraw`)).status).toBe('withdrawn');
    expect(errorCode(await carol.post(`${L}/trades/${offer.id}/respond`, { response: 'accept' }))).toBe(
      'ILLEGAL_TRADE_TRANSITION'
    );
  });

  it('expires an unanswered offer through its scheduled deadline; stale timers do nothing', async () => {
    const offer = await propose(alice, { withTeamId: 'team-3', send: ['fx-jallen'], receive: ['fx-hurts'] });
    expect(await timer('Trade Offer Deadline', { leagueId: 'lg-t', tradeId: offer.id })).toMatchObject({
      handled: true,
      outcome: 'early'
    });
    h.clock.set(offer.expiresAt);
    expect((await timer('Trade Offer Deadline', { leagueId: 'lg-t', tradeId: offer.id })).outcome).toBe(
      'expired'
    );
    expect(eventsOf('Trade Expired').at(-1)?.detail).toMatchObject({ tradeId: offer.id, status: 'expired' });
    expect((await timer('Trade Offer Deadline', { leagueId: 'lg-t', tradeId: offer.id })).outcome).toBe(
      'stale'
    );
    expect(await timer('Trade Offer Deadline', { leagueId: 'lg-t', tradeId: 'nope' })).toEqual({
      handled: false,
      outcome: 'ignored'
    });
    expect((await timer('Trade Offer Deadline', { nope: true })).handled).toBe(false);
    h.clock.set(START);
  });
});

describe('acceptance, league review, and processing', () => {
  let accepted: View;

  it('accepts into league review, visible to the whole league', async () => {
    const offers = data<{ trades: View[] }>(await bob.get(`${L}/trades?status=open`)).trades;
    const offer = offers.find((t) => t.direction === 'incoming') as View;
    accepted = trade(await bob.post(`${L}/trades/${offer.id}/respond`, { response: 'accept' }));
    expect(accepted).toMatchObject({ status: 'in_review', reviewEndsAt: '2026-09-12T12:00:00.000Z' });
    expect(eventsOf('Trade Accepted').at(-1)?.detail).toMatchObject({
      tradeId: offer.id,
      review: 'league_vote'
    });
    expect(eventsOf('Schedule Event').at(-1)?.detail).toMatchObject({
      event: { detailType: 'Trade Review Ended', detail: { tradeId: offer.id } }
    });
    const seen = data<{ trades: View[] }>(await carol.get(`${L}/trades?status=review`)).trades;
    expect(seen.map((t) => [t.id, t.direction, t.yourActions])).toEqual([[offer.id, 'league', ['vote']]]);
  });

  it('previews an accepted trade against the current rosters', async () => {
    const preview = data(await carol.get(`${L}/trades/preview?tradeId=${accepted.id}`));
    expect(preview).toMatchObject({
      valid: true,
      sides: [{ team: { id: 'team-1' } }, { team: { id: 'team-2' } }]
    });
  });

  it('takes veto votes from teams outside the trade, once each', async () => {
    const voted = trade(await carol.post(`${L}/trades/${accepted.id}/votes`, { decision: 'veto' }));
    expect(voted).toMatchObject({ status: 'in_review', vetoVotes: 1, yourActions: [] });
    expect(errorCode(await carol.post(`${L}/trades/${accepted.id}/votes`, {}))).toBe('VOTE_NOT_ALLOWED');
    expect(errorCode(await alice.post(`${L}/trades/${accepted.id}/votes`, {}))).toBe('VOTE_NOT_ALLOWED');
    expect(errorCode(await carol.post(`${L}/trades/${accepted.id}/votes`, { decision: 'approve' }))).toBe(
      'VOTE_NOT_ALLOWED'
    );
  });

  it('processes when review ends: rosters, locks, transactions, events; again is a no-op', async () => {
    expect((await timer('Trade Review Ended', { leagueId: 'lg-t', tradeId: accepted.id })).outcome).toBe(
      'not_ready'
    );
    h.clock.set(accepted.reviewEndsAt as string);
    expect((await timer('Trade Review Ended', { leagueId: 'lg-t', tradeId: accepted.id })).outcome).toBe(
      'processed'
    );
    expect(await roster('team-1')).toEqual(['fx-jallen', 'fx-bijan']);
    expect(await roster('team-2')).toEqual(['fx-mahomes', 'fx-chase', 'fx-cmc']);
    expect(await h.repos.waivers.playerOwner('lg-t', 'fx-bijan')).toBe('team-1');
    expect(await h.repos.waivers.playerOwner('lg-t', 'fx-cmc')).toBe('team-2');
    expect(eventsOf('Trade Processed').at(-1)?.detail).toMatchObject({
      tradeId: accepted.id,
      status: 'processed'
    });
    const log = data<{ transactions: { type: string; teamId: string; added: { id: string } }[] }>(
      await carol.get(`${L}/transactions`)
    );
    expect(log.transactions.map((t) => [t.type, t.teamId, t.added.id]).sort()).toEqual([
      ['trade', 'team-1', 'fx-bijan'],
      ['trade', 'team-2', 'fx-cmc']
    ]);
    expect((await timer('Trade Review Ended', { leagueId: 'lg-t', tradeId: accepted.id })).outcome).toBe(
      'stale'
    );
    h.clock.set(START);
  });

  it('vetoes a trade once enough teams vote against it', async () => {
    const offer = await propose(carol, { withTeamId: 'team-1', send: ['fx-hurts'], receive: ['fx-jallen'] });
    expect(trade(await alice.post(`${L}/trades/${offer.id}/respond`, { response: 'accept' })).status).toBe(
      'in_review'
    );
    await bob.post(`${L}/trades/${offer.id}/votes`, { decision: 'veto' });
    const vote = await asAgent(agent4, 'vote_trade', { tradeId: offer.id, idempotencyKey: 'agent-4-veto-1' });
    expect(vote).toMatchObject({ data: { trade: { status: 'vetoed', vetoVotes: 2 } } });
    expect(eventsOf('Trade Vetoed').at(-1)?.detail).toMatchObject({
      tradeId: offer.id,
      fromTeamId: 'team-3'
    });
    expect(await roster('team-3')).toEqual(['fx-hurts']);
  });

  it('voids a trade that no longer works when review ends', async () => {
    const offer = await propose(carol, { withTeamId: 'team-1', send: ['fx-hurts'], receive: ['fx-jallen'] });
    const inReview = trade(await alice.post(`${L}/trades/${offer.id}/respond`, { response: 'accept' }));
    expect((await carol.post(`${L}/drops`, { playerId: 'fx-hurts' })).status).toBe(200);
    h.clock.set(inReview.reviewEndsAt as string);
    expect((await timer('Trade Review Ended', { leagueId: 'lg-t', tradeId: offer.id })).outcome).toBe(
      'voided'
    );
    expect(eventsOf('Trade Vetoed').at(-1)?.detail).toMatchObject({
      tradeId: offer.id,
      voided: true,
      reasonCode: 'PLAYER_NOT_ON_ROSTER'
    });
    const [view] = data<{ trades: { voidReason: { code: string } }[] }>(
      await alice.get(`${L}/trades?tradeId=${offer.id}`)
    ).trades;
    expect(view?.voidReason.code).toBe('PLAYER_NOT_ON_ROSTER');
    h.clock.set(START);
  });
});

describe('persistence', () => {
  it('refuses a duplicate trade id and a stale write', async () => {
    const [record] = await h.repos.trades.list('lg-t');
    if (record === undefined) throw new Error('no trades');
    await expect(h.repos.trades.create(record)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(h.repos.trades.update({ ...record, version: 0 })).rejects.toMatchObject({
      code: 'CONFLICT',
      fix: expect.stringContaining('list_trades')
    });
  });
});

describe('agents, the lopsided guard, and the deadline', () => {
  it('refuses a lopsided trade between two AI teams', async () => {
    await h.services.data.reference.projections.putSnapshot(
      { season: 2026, week: 2, capturedAt: '2026-09-09T12:00:00.000Z', hash: 'trade-test', count: 1 },
      [{ playerId: 'fx-jtaylor', season: 2026, week: 2, stats: { rush_yd: 300 } }]
    );
    const lopsided = await asAgent(agent4, 'propose_trade', {
      withTeamId: 'team-5',
      send: ['fx-jtaylor'],
      receive: ['fx-swift'],
      idempotencyKey: 'agent-4-lopsided'
    });
    expect(lopsided).toMatchObject({ error: { code: 'TRADE_LOPSIDED' } });
    const fair = await asAgent(agent4, 'propose_trade', {
      withTeamId: 'team-5',
      send: ['fx-lamar'],
      receive: ['fx-tucker'],
      idempotencyKey: 'agent-4-fair'
    });
    expect(fair).toMatchObject({ data: { trade: { status: 'proposed' } } });
    const other = await asAgent(agent5, 'list_trades', { status: 'open' });
    expect(other).toMatchObject({ data: { trades: [{ direction: 'incoming' }] } });
  });

  it('closes trading after the deadline and expires every open offer', async () => {
    const offer = await propose(alice, { withTeamId: 'team-3', send: ['fx-jallen'] });
    const league = await h.repos.leagues.get('lg-t');
    if (league === null) throw new Error('league');
    await h.repos.leagues.update({ ...league, week: 12 });
    const blocked = data(await alice.get(`${L}/trades/preview?withTeamId=team-3&send=fx-jallen`));
    expect(blocked.valid).toBe(false);
    expect((blocked.issues as { code: string }[]).map((x) => x.code)).toEqual([
      'TRADE_DEADLINE_PASSED',
      'TRADE_DEADLINE_PASSED'
    ]);
    const res = await alice.post(`${L}/trades`, { withTeamId: 'team-3', send: ['fx-jallen'] });
    expect(res.body).toMatchObject({
      error: { code: 'TRADE_DEADLINE_PASSED', fix: expect.stringContaining('waivers') }
    });
    const outcome = await timer('Trade Deadline Passed', { leagueId: 'lg-t' });
    expect(outcome.outcome).toEqual({ expired: 2 });
    expect(
      data<{ trades: View[] }>(await alice.get(`${L}/trades?tradeId=${offer.id}`)).trades[0]?.status
    ).toBe('expired');
    expect((await timer('Trade Deadline Passed', { leagueId: 'nope' })).handled).toBe(false);
  });
});

describe('trades accepted before the deadline', () => {
  it('still complete when their review ends after the deadline (Yahoo)', async () => {
    await seedSeasonLeague(h.repos, {
      id: 'lg-td',
      owners: [ALICE, BOB, CAROL],
      rosters: { 'team-1': ['fx-jallen'], 'team-2': ['fx-mahomes'], 'team-3': ['fx-hurts'] },
      overrides: { week: 11 }
    });
    const offer = trade(
      await alice.post('/leagues/lg-td/trades', {
        withTeamId: 'team-2',
        send: ['fx-jallen'],
        receive: ['fx-mahomes']
      })
    );
    const accepted = trade(
      await bob.post(`/leagues/lg-td/trades/${offer.id}/respond`, { response: 'accept' })
    );
    expect(accepted.status).toBe('in_review');
    const league = await h.repos.leagues.get('lg-td');
    if (league === null) throw new Error('league');
    await h.repos.leagues.update({ ...league, week: 12 });
    expect(
      errorCode(await alice.post('/leagues/lg-td/trades', { withTeamId: 'team-3', send: ['fx-jallen'] }))
    ).toBe('TRADE_DEADLINE_PASSED');
    expect(await timer('Trade Deadline Passed', { leagueId: 'lg-td' })).toMatchObject({
      outcome: { expired: 0 }
    });
    h.clock.set(accepted.reviewEndsAt as string);
    expect((await timer('Trade Review Ended', { leagueId: 'lg-td', tradeId: offer.id })).outcome).toBe(
      'processed'
    );
    expect(await roster('team-1', 'lg-td')).toEqual(['fx-mahomes']);
    h.clock.set(START);
  });
});

describe('review settings and locks', () => {
  async function reviewLeague(id: string, review: 'none' | 'commissioner') {
    await seedSeasonLeague(h.repos, {
      id,
      owners: [ALICE, BOB, CAROL],
      rosters: { 'team-1': ['fx-jallen'], 'team-2': ['fx-mahomes'], 'team-3': ['fx-hurts'] }
    });
    const league = await h.repos.leagues.get(id);
    if (league === null) throw new Error(id);
    await h.repos.leagues.update({
      ...league,
      settings: { ...league.settings, trades: { ...league.settings.trades, review } }
    });
  }

  it('processes at once in a league without review', async () => {
    await reviewLeague('lg-tn', 'none');
    const offer = trade(
      await alice.post('/leagues/lg-tn/trades', {
        withTeamId: 'team-2',
        send: ['fx-jallen'],
        receive: ['fx-mahomes']
      })
    );
    const done = trade(await bob.post(`/leagues/lg-tn/trades/${offer.id}/respond`, { response: 'accept' }));
    expect(done.status).toBe('processed');
    expect(await roster('team-1', 'lg-tn')).toEqual(['fx-mahomes']);
  });

  it('lets only the commissioner approve or veto in commissioner mode', async () => {
    await reviewLeague('lg-tc', 'commissioner');
    const one = trade(
      await bob.post('/leagues/lg-tc/trades', {
        withTeamId: 'team-3',
        send: ['fx-mahomes'],
        receive: ['fx-hurts']
      })
    );
    await carol.post(`/leagues/lg-tc/trades/${one.id}/respond`, { response: 'accept' });
    expect(errorCode(await carol.post(`/leagues/lg-tc/trades/${one.id}/votes`, {}))).toBe('FORBIDDEN');
    const approved = trade(
      await alice.post(`/leagues/lg-tc/trades/${one.id}/votes`, { decision: 'approve' })
    );
    expect(approved.status).toBe('processed');
    const two = trade(
      await bob.post('/leagues/lg-tc/trades', {
        withTeamId: 'team-3',
        send: ['fx-hurts'],
        receive: ['fx-mahomes']
      })
    );
    await carol.post(`/leagues/lg-tc/trades/${two.id}/respond`, { response: 'accept' });
    expect(
      trade(await alice.post(`/leagues/lg-tc/trades/${two.id}/votes`, { decision: 'veto' })).status
    ).toBe('vetoed');
    expect(errorCode(await alice.post(`/leagues/lg-tc/trades/${two.id}/votes`, { decision: 'veto' }))).toBe(
      'TRADE_NOT_IN_REVIEW'
    );
  });

  it('waits for the week’s locks to release before processing a trade with a locked player', async () => {
    await reviewLeague('lg-tl', 'commissioner');
    const offer = trade(
      await bob.post('/leagues/lg-tl/trades', {
        withTeamId: 'team-3',
        send: ['fx-mahomes'],
        receive: ['fx-hurts']
      })
    );
    await carol.post(`/leagues/lg-tl/trades/${offer.id}/respond`, { response: 'accept' });
    // KC (Mahomes) kicks off before the commissioner approves.
    await h.services.data.reference.schedule.putSeason(
      2026,
      [
        {
          gameId: '2026_02_BAL_KC',
          season: 2026,
          seasonType: 'regular',
          week: 2,
          kickoff: '2026-09-11T00:20:00.000Z',
          homeTeam: 'KC',
          awayTeam: 'BAL',
          status: 'scheduled'
        }
      ],
      {},
      new Date(START)
    );
    h.clock.set('2026-09-11T01:00:00.000Z');
    const approved = trade(
      await alice.post(`/leagues/lg-tl/trades/${offer.id}/votes`, { decision: 'approve' })
    );
    expect(approved.status).toBe('in_review');
    expect(eventsOf('Schedule Event').at(-1)?.detail).toMatchObject({
      at: '2026-09-11T04:50:00.000Z',
      event: { detailType: 'Trade Review Ended', detail: { tradeId: offer.id } }
    });
    expect(await roster('team-2', 'lg-tl')).toEqual(['fx-mahomes']);
    // The next week: nobody is locked any more.
    const league = await h.repos.leagues.get('lg-tl');
    if (league === null) throw new Error('league');
    await h.repos.leagues.update({ ...league, week: 3 });
    expect((await timer('Trade Review Ended', { leagueId: 'lg-tl', tradeId: offer.id })).outcome).toBe(
      'processed'
    );
    expect(await roster('team-2', 'lg-tl')).toEqual(['fx-hurts']);
    h.clock.set(START);
  });
});
