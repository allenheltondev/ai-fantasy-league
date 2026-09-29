import {
  DIFFICULTY_TIERS,
  STRATEGY_ARCHETYPES,
  checkInTradeChance,
  responseDelay,
  seededRandom,
  yahooDefaultSettings,
  type AgentSeatConfig
} from '@fantasy/core';
import { createContext, createRegistry, executeOperation, operations, type Player } from '@fantasy/server';
import { describe, expect, it } from 'vitest';
import { AgentActionRequestedSchema, type AgentActionRequested, type BusEvent } from '../src/events.js';
import { ScriptedModelClient } from '../src/fake-model.js';
import { cooldownSlot, routeEvent } from '../src/router.js';
import { runAgentAction } from '../src/runner.js';
import {
  CHECK_IN_PROBES,
  checkInReasons,
  nothingToDoLine,
  unavailableStarters,
  type CheckInLook
} from '../src/tasks/check-in.js';
import { NO_SOCIAL } from '../src/tasks/check-in-social.js';
import { defaultTaskKinds } from '../src/tasks/index.js';
import type { LineupPrep } from '../src/tasks/lineup.js';
import { HAPPY, market } from './market.js';
import { AGENT_TEAM, LEAGUE_ID, SF_KICKOFF, START, setup, type Setup } from './support.js';

/**
 * Manager check-ins (#195): the task's deterministic look and pre-check, its decision (fake model),
 * its fallback, and how the router fans a check-in out to the agents.
 */

const AGENT_ID = `${LEAGUE_ID}.${AGENT_TEAM}`;
const STEADY = { personalityId: 'stats-nerd', difficulty: 'pro', archetype: 'balanced' } as const;
const HAWK = { personalityId: 'stats-nerd', difficulty: 'pro', archetype: 'waiver_hawk' } as const;
const CAUTIOUS = { personalityId: 'stats-nerd', difficulty: 'pro', archetype: 'analytics_only' } as const;

function checkIn(
  eventId: string,
  payload: Record<string, unknown> = { slot: 'afternoon' }
): AgentActionRequested {
  return {
    taskId: `check_in.${eventId}`,
    leagueId: LEAGUE_ID,
    teamId: AGENT_TEAM,
    agentId: AGENT_ID,
    kind: 'check_in',
    trigger: { detailType: 'Manager Check-In', eventId, urgent: false },
    payload,
    requestedAt: START
  };
}

/** An event id whose trade-appetite roll for the agent passes (or fails) for this archetype. */
function rolled(archetype: keyof typeof STRATEGY_ARCHETYPES, pass: boolean, nth = 0): string {
  const chance = checkInTradeChance(STRATEGY_ARCHETYPES[archetype].tradeFrequency);
  let seen = 0;
  for (let i = 0; i < 5000; i++) {
    const id = `evt-${archetype}-${i}`;
    if (seededRandom(`check-in-trade:${id}:${AGENT_TEAM}`)() < chance === pass && seen++ === nth) return id;
  }
  throw new Error('no such roll');
}

/** Puts players in the directory (a free agent unless a team rosters him). */
async function players(
  s: Setup,
  list: { id: string; position: Player['position']; team?: string; injury?: string }[]
) {
  await s.repos.players.putMany(
    list.map((p) => ({
      id: p.id,
      name: p.id.toUpperCase(),
      firstName: p.id,
      lastName: p.id,
      team: p.team ?? 'SF',
      position: p.position,
      status: 'active' as const,
      injuryStatus: p.injury ?? null,
      aliases: [],
      rank: null,
      updatedAt: START
    }))
  );
}

async function trending(s: Setup, playerId: string) {
  await s.services.data.reference.trending.put({
    type: 'add',
    capturedAt: '2026-10-04T14:00:00.000Z',
    lookbacks: { '72': [{ playerId, count: 900 }] }
  });
}

async function project(s: Setup, lines: { playerId: string; stats: Record<string, number> }[]) {
  await s.services.data.reference.projections.putSnapshot(
    {
      season: 2026,
      week: 5,
      capturedAt: '2026-10-03T12:00:00.000Z',
      hash: `p-${lines.length}`,
      count: lines.length
    },
    lines.map((l) => ({ ...l, season: 2026, week: 5 }))
  );
}

async function league(config: AgentSeatConfig) {
  const s = await setup();
  await s.seat(AGENT_TEAM, config);
  return s;
}

const startersOf = async (s: Setup) =>
  new Map(((await s.savedLineups())[0]?.lineup ?? []).map((e) => [e.playerId, e.slot]));

describe('check-in pre-check', () => {
  it('logs nothing_to_do without a model call when nothing is worth a look', async () => {
    const s = await market(HAPPY);
    const model = new ScriptedModelClient();
    const record = await runAgentAction(s.deps(model), checkIn(rolled('trade_happy', false)));
    expect(record).toMatchObject({
      status: 'skipped',
      fallbackReason: 'nothing_to_do',
      finalAction: 'none',
      reasoningSummary:
        'Lineup is set. Looked at waivers; nobody beats my bench. Not shopping for trades today.',
      costUsd: 0
    });
    expect(model.transcript).toEqual([]);
    expect(record.toolsCalled.map((c) => c.name)).toContain('get_trending_players');
  });

  it('thinks it over at the first check-in of the day, and may change nothing', async () => {
    const s = await market({ ...HAPPY, personalityId: 'zen-master' });
    await s.repos.schedule.putMatchups([
      {
        id: 'W05-M1',
        leagueId: LEAGUE_ID,
        week: 5,
        kind: 'regular',
        homeTeamId: 'team-3',
        awayTeamId: AGENT_TEAM,
        homeScore: null,
        awayScore: null,
        status: 'scheduled'
      }
    ]);
    const model = new ScriptedModelClient();
    const record = await runAgentAction(
      s.deps(model),
      checkIn(rolled('trade_happy', false, 1), { slot: 'morning' })
    );
    expect(record).toMatchObject({
      status: 'completed',
      finalAction: 'none',
      reasoningSummary: 'Morning check on my team. Changed nothing.'
    });
    const prompt = model.transcript[0]?.systemPrompt ?? '';
    expect(prompt).toContain('Your morning check-in on your team.');
    expect(prompt).toContain('The optimizer would start: QB1 to QB');
    expect(prompt).toContain('No pickups worth making.');
    expect(prompt).toContain('This week you play Team 3.');
    expect(prompt).toContain('No trade offers to send this time.');
    expect(model.transcript[0]?.toolNames).not.toContain('claim_waiver');
  });

  it('reads the reasons from its probes, and says why it did nothing', () => {
    const look: CheckInLook = {
      payload: { slot: 'evening', firstLook: false },
      lineup: null,
      unavailable: [],
      waivers: { open: false, faabRemaining: 0, pickups: [], holes: [] },
      trade: { shopping: true, offersLeft: 1, prep: null },
      offers: [],
      social: NO_SOCIAL
    };
    expect(checkInReasons(look)).toEqual([]);
    expect(nothingToDoLine(look)).toBe(
      "Couldn't read my roster. Waivers are closed. No trade worth offering."
    );
    const extra = () => ({ code: 'rename', line: 'My name is stale.' });
    expect(checkInReasons(look, [...CHECK_IN_PROBES, extra])).toEqual([
      { code: 'rename', line: 'My name is stale.' }
    ]);
  });

  it('finds starters who are out or on bye, but not those already locked', () => {
    const prep = {
      roster: [
        { playerId: 'a', name: 'A', positions: ['RB'], status: 'out', nflTeam: 'SF' },
        { playerId: 'b', positions: ['WR'], status: 'active', nflTeam: 'KC' },
        { playerId: 'c', name: 'C', positions: ['WR'], status: 'active', nflTeam: null },
        { playerId: 'd', name: 'D', positions: ['TE'], status: 'out', nflTeam: 'LAR' },
        { playerId: 'e', name: 'E', positions: ['QB'], status: 'active', nflTeam: 'SF' }
      ],
      current: [
        { playerId: 'a', slot: 'RB' },
        { playerId: 'b', slot: 'WR' },
        { playerId: 'c', slot: 'BN' },
        { playerId: 'd', slot: 'TE' },
        { playerId: 'e', slot: 'QB' }
      ],
      context: {
        games: { SF: { kickoff: SF_KICKOFF }, LAR: { kickoff: '2026-10-04T13:00:00.000Z' } },
        now: new Date(START)
      }
    } as unknown as LineupPrep;
    const { unavailable, bye } = unavailableStarters(prep);
    expect(unavailable).toEqual([
      { id: 'a', name: 'A', slot: 'RB', why: 'out' },
      { id: 'b', name: 'b', slot: 'WR', why: 'bye' }
    ]);
    expect([...bye]).toEqual(['b', 'c']);
    // Without the week's games there are no byes.
    expect(unavailableStarters({ ...prep, context: {} } as LineupPrep).bye.size).toBe(0);
  });
});

describe('check-in decisions', () => {
  it('benches a starter who is out or on bye', async () => {
    const s = await league(STEADY);
    await players(s, [
      { id: 'rb1', position: 'RB', injury: 'Out' },
      { id: 'wr1', position: 'WR', team: 'KC' }
    ]);
    const model = new ScriptedModelClient();
    const record = await runAgentAction(s.deps(model), checkIn(rolled('balanced', false)));
    expect(record).toMatchObject({ status: 'completed', finalAction: 'set_lineup' });
    expect(record.reasoningSummary).toMatch(
      /^Starters who will not play: WR1 \(bye\), RB1 \(out\)\. Set my lineup/
    );
    const slots = await startersOf(s);
    expect(slots.get('rb1')).toBe('BN');
    expect(slots.get('wr1')).toBe('BN');
  });

  it('claims a better player off waivers with a bid, sealed until the claim resolves', async () => {
    const s = await league(HAWK);
    await players(s, [{ id: 'fa-rb', position: 'RB' }]);
    await project(s, [
      { playerId: 'rb3', stats: { rush_yd: 300 } },
      { playerId: 'fa-rb', stats: { rush_yd: 400 } }
    ]);
    await s.repos.waivers.putWireEntry({
      leagueId: LEAGUE_ID,
      playerId: 'fa-rb',
      droppedByTeamId: 'team-4',
      droppedAt: START,
      clearsAt: '2026-10-06T15:00:00.000Z'
    });
    await trending(s, 'fa-rb');
    const model = new ScriptedModelClient();
    const record = await runAgentAction(s.deps(model), checkIn(rolled('waiver_hawk', false)));
    expect(record).toMatchObject({ status: 'completed', finalAction: 'claim_waiver' });
    expect(model.transcript[0]?.systemPrompt).toMatch(
      /1\. FA-RB \(RB; on waivers: claim, suggested bid \$\d+; \+40 projected pts\)\./
    );
    const [claim] = await s.repos.waivers.listClaims(LEAGUE_ID, 'pending');
    expect(claim).toMatchObject({ teamId: AGENT_TEAM, addPlayerId: 'fa-rb' });
    expect(claim?.dropPlayerId).toBeNull();
    expect(claim?.bid).toBeGreaterThan(0);
    expect(record.sealed).toEqual({
      summary:
        'Checked in and made 1 waiver claim(s) and 0 trade offer(s); they stay hidden until they resolve.',
      trades: [],
      waiverClaims: [claim?.id]
    });
    // The claim is pending: the next check-in does not claim him again.
    const next = await runAgentAction(
      s.deps(new ScriptedModelClient()),
      checkIn(rolled('waiver_hawk', false, 1))
    );
    expect(next).toMatchObject({ status: 'skipped', fallbackReason: 'nothing_to_do' });
    expect(await s.repos.waivers.listClaims(LEAGUE_ID, 'pending')).toHaveLength(1);
  });

  it('passes on a claim whose drop would be locked by the time it runs', async () => {
    const settings = yahooDefaultSettings(4);
    settings.waivers.type = 'faab';
    settings.roster.slots = { QB: 1, RB: 1, BN: 1 };
    const s = await setup({ league: { settings } });
    await s.seat(AGENT_TEAM, HAWK);
    const team = await s.repos.teams.get(LEAGUE_ID, AGENT_TEAM);
    await s.repos.teams.update({ ...team!, roster: ['qb2', 'rb2', 'te2'] });
    await players(s, [{ id: 'fa-rb', position: 'RB' }]);
    await project(s, [{ playerId: 'fa-rb', stats: { rush_yd: 400 } }]);
    // The week ends with Monday night's game; his claim runs Monday morning, after every rostered
    // player (SF) has kicked off on Sunday.
    const game = (id: string, kickoff: string, home: string, away: string) => ({
      gameId: id,
      season: 2026,
      seasonType: 'regular' as const,
      week: 5,
      kickoff,
      homeTeam: home,
      awayTeam: away,
      status: 'scheduled' as const
    });
    await s.services.data.reference.schedule.putSeason(
      2026,
      [
        game('2026_05_LAR_SF', SF_KICKOFF, 'SF', 'LAR'),
        game('2026_05_KC_DEN', '2026-10-06T00:15:00.000Z', 'DEN', 'KC')
      ],
      {},
      new Date(START)
    );
    await s.repos.waivers.putWireEntry({
      leagueId: LEAGUE_ID,
      playerId: 'fa-rb',
      droppedByTeamId: 'team-4',
      droppedAt: START,
      clearsAt: '2026-10-04T18:00:00.000Z'
    });
    await trending(s, 'fa-rb');
    const record = await runAgentAction(
      s.deps(new ScriptedModelClient()),
      checkIn(rolled('waiver_hawk', false))
    );
    expect(record).toMatchObject({ status: 'skipped', fallbackReason: 'nothing_to_do' });
    expect(await s.repos.waivers.listClaims(LEAGUE_ID, 'pending')).toEqual([]);
  });

  it('adds a free agent now and starts him', async () => {
    const s = await league(HAWK);
    await players(s, [{ id: 'fa-rb', position: 'RB' }]);
    await project(s, [
      { playerId: 'rb3', stats: { rush_yd: 300 } },
      { playerId: 'fa-rb', stats: { rush_yd: 400 } }
    ]);
    await trending(s, 'fa-rb');
    const record = await runAgentAction(
      s.deps(new ScriptedModelClient()),
      checkIn(rolled('waiver_hawk', false))
    );
    expect(record).toMatchObject({ status: 'completed', finalAction: 'claim_waiver+set_lineup' });
    expect(record.reasoningSummary).toContain('Claimed: FA-RB (RB) ($0).');
    expect((await s.repos.teams.get(LEAGUE_ID, AGENT_TEAM))?.roster).toContain('fa-rb');
    expect((await startersOf(s)).get('fa-rb')).toBe('RB');
  });

  it('offers a vetted trade when its appetite roll passes, one per check-in and partner', async () => {
    const s = await market(HAPPY);
    const model = new ScriptedModelClient();
    const record = await runAgentAction(s.deps(model), checkIn(rolled('trade_happy', true)));
    expect(record).toMatchObject({ status: 'completed', finalAction: 'propose_trade' });
    expect(model.transcript[0]?.systemPrompt).toContain('Trade ideas (propose_trade, at most 1):');
    const offers = (await s.repos.trades.list(LEAGUE_ID)).filter(
      (t) => t.trade.sides[0].teamId === AGENT_TEAM
    );
    expect(offers.map((t) => t.trade.sides.map((side) => side.sends))).toEqual([[['qb1'], ['rb3']]]);
    expect(record.sealed?.trades).toEqual([{ tradeId: offers[0]?.trade.tradeId, until: 'public' }]);
    const memory = await s.repos.agents.getMemory(LEAGUE_ID, AGENT_ID);
    expect(memory.trades).toEqual([expect.objectContaining({ outcome: 'proposed', teamId: 'team-3' })]);

    // Team 3 already has its offer: nothing else is worth a look.
    const again = await runAgentAction(
      s.deps(new ScriptedModelClient()),
      checkIn(rolled('trade_happy', true, 1))
    );
    expect(again).toMatchObject({
      status: 'skipped',
      reasoningSummary: expect.stringContaining('No trade worth offering.')
    });
  });

  it('keeps to its weekly offer count, shared with the rollover trade look', async () => {
    const s = await market(CAUTIOUS);
    const first = await runAgentAction(
      s.deps(new ScriptedModelClient()),
      checkIn(rolled('analytics_only', true))
    );
    expect(first.finalAction).toBe('propose_trade');
    // One offer a week for this archetype: the next roll that passes does not shop.
    const later = await runAgentAction(
      s.deps(new ScriptedModelClient()),
      checkIn(rolled('analytics_only', true, 1))
    );
    expect(later).toMatchObject({
      status: 'skipped',
      reasoningSummary:
        'Lineup is set. Looked at waivers; nobody beats my bench. Not shopping for trades today.'
    });
  });

  it('never takes more actions than the difficulty allows', async () => {
    const s = await market({ ...HAPPY, advanced: { levers: { actionsPerTrigger: 1 } } });
    await players(s, [{ id: 'fa-wr', position: 'WR' }]);
    await project(s, [
      { playerId: 'qb1', stats: { pass_yd: 750 } },
      { playerId: 'rb3', stats: { rush_yd: 300 } },
      { playerId: 'fa-wr', stats: { rec_yd: 500 } }
    ]);
    await trending(s, 'fa-wr');
    const model = new ScriptedModelClient({
      script: () => ({
        steps: [],
        decision: {
          summary: 'Doing it all.',
          actions: [
            { type: 'add_drop', pickup: 1 },
            { type: 'add_drop', pickup: 1 },
            { type: 'add_drop', pickup: 9 },
            { type: 'propose_trade', candidate: 1 },
            { type: 'none' }
          ]
        }
      })
    });
    const record = await runAgentAction(s.deps(model), checkIn(rolled('trade_happy', true)));
    expect(record.finalAction).toBe('claim_waiver+set_lineup');
    expect(await s.repos.trades.list(LEAGUE_ID)).toEqual([]);
  });

  it('answers an offer that has waited a while, through trade_response', async () => {
    const s = await market(HAPPY);
    // Allen (team-1, a person) offers his back for the agent's rb4.
    await players(s, [{ id: 'h-rb', position: 'RB' }]);
    const allen = await s.repos.teams.get(LEAGUE_ID, 'team-1');
    await s.repos.teams.update({ ...allen!, roster: ['h-rb'] });
    const offered = await executeOperation({
      registry: s.registry,
      operation: s.registry.get('propose_trade')!,
      ctx: createContext(s.services, { type: 'user', sub: 'user-123', email: null, name: 'Allen' }),
      input: { leagueId: LEAGUE_ID, withTeamId: AGENT_TEAM, send: ['h-rb'], receive: ['rb4'] },
      idempotencyKey: 'offer-to-agent-1'
    });
    const body = offered.body as { data?: { trade: { id: string } }; error?: unknown };
    if (body.data === undefined) throw new Error(JSON.stringify(body.error));
    const tradeId = body.data.trade.id;
    s.clock.advance(3 * 3_600_000);
    const model = new ScriptedModelClient();
    const record = await runAgentAction(s.deps(model), checkIn(rolled('trade_happy', false)));
    expect(record.status).toBe('completed');
    expect(model.transcript[0]?.systemPrompt).toContain("Offer waiting on me from Allen's Team.");
    const followUps = s.events.events
      .filter((e) => e.detailType === 'Agent Action Requested')
      .map((e) => AgentActionRequestedSchema.parse(e.detail));
    expect(followUps).toEqual([
      expect.objectContaining({
        kind: 'trade_response',
        teamId: AGENT_TEAM,
        payload: { tradeId, fromTeamId: 'team-1' }
      })
    ]);
  });

  it('takes the kickoff steps on its first look since the draft: lineup, holes, and a trade look', async () => {
    const s = await market(HAPPY);
    const model = new ScriptedModelClient();
    const record = await runAgentAction(
      s.deps(model),
      checkIn('evt-first', { slot: 'afternoon', firstLook: true })
    );
    expect(record).toMatchObject({ status: 'completed', finalAction: 'set_lineup+propose_trade+send_dm' });
    expect(model.transcript[0]?.systemPrompt).toContain('Your first real look at your team since the draft');
    expect((await startersOf(s)).get('qb1')).toBe('QB');
    // A cautious archetype does not shop on its first look.
    const cautious = await market(CAUTIOUS);
    const quiet = await runAgentAction(
      cautious.deps(new ScriptedModelClient()),
      checkIn('evt-first', { slot: 'afternoon', firstLook: true })
    );
    expect(quiet.finalAction).toBe('set_lineup');
  });
});

describe('check-in fallback', () => {
  async function hurting(config: AgentSeatConfig = STEADY) {
    const s = await league(config);
    await players(s, [
      { id: 'rb1', position: 'RB', injury: 'Out' },
      { id: 'k1', position: 'K', injury: 'IR' },
      { id: 'fa-k', position: 'K' }
    ]);
    return s;
  }

  it('sets the lineup and fills holes from free agents with the kill switch on, and nothing else', async () => {
    const s = await hurting(HAPPY);
    const model = new ScriptedModelClient();
    const record = await runAgentAction(
      s.deps(model, { killSwitch: { engaged: async () => true } }),
      checkIn(rolled('trade_happy', true))
    );
    expect(record).toMatchObject({ status: 'fallback', fallbackReason: 'kill_switch' });
    expect(record.reasoningSummary).toMatch(
      /^Autopilot check-in\. Claimed: FA-K \(K\) for the K hole .* Set my lineup/
    );
    expect(model.transcript).toEqual([]);
    const roster = (await s.repos.teams.get(LEAGUE_ID, AGENT_TEAM))?.roster ?? [];
    expect(roster).toContain('fa-k');
    expect(roster).toContain('rb1');
    expect(roster).toContain('k1');
    const slots = await startersOf(s);
    expect(slots.get('fa-k')).toBe('K');
    expect(slots.get('rb1')).toBe('BN');
    expect(await s.repos.trades.list(LEAGUE_ID)).toEqual([]);
  });

  it('does the same once the league is over its weekly budget', async () => {
    const s = await hurting();
    await s.repos.agents.addUsage({
      leagueId: LEAGUE_ID,
      week: 5,
      agentId: AGENT_ID,
      modelKey: 'claude-haiku',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 1000,
      tasks: 1
    });
    const record = await runAgentAction(
      s.deps(new ScriptedModelClient()),
      checkIn(rolled('balanced', false))
    );
    expect(record).toMatchObject({ status: 'fallback', fallbackReason: 'budget_exceeded' });
    expect((await startersOf(s)).get('rb1')).toBe('BN');
  });

  it('makes do with what it can read, and leaves the lineup alone without a roster', async () => {
    const s = await league(STEADY);
    const without = (...names: string[]) =>
      createRegistry(operations.filter((op) => !names.includes(op.name)));
    expect(
      await runAgentAction(
        { ...s.deps(new ScriptedModelClient()), registry: without('get_league_state') },
        checkIn(rolled('balanced', false))
      )
    ).toMatchObject({
      status: 'skipped',
      fallbackReason: 'nothing_to_do',
      reasoningSummary: 'Lineup is set. Waivers are closed. Not shopping for trades today.'
    });
    // No research at all: it still checks in, on what it knows.
    const research = [
      'get_trending_players',
      'search_players',
      'list_trades',
      'get_standings',
      'get_matchup'
    ];
    const quiet = new ScriptedModelClient();
    expect(
      await runAgentAction(
        { ...s.deps(quiet), registry: without(...research) },
        checkIn('evt-z', { slot: 'morning' })
      )
    ).toMatchObject({ status: 'completed', finalAction: 'none' });
    expect(quiet.transcript[0]?.systemPrompt).not.toContain('This week you play');
    const model = new ScriptedModelClient();
    const blind = await runAgentAction(
      { ...s.deps(model), registry: without('get_roster') },
      checkIn('evt-y', { slot: 'morning', firstLook: true })
    );
    expect(blind).toMatchObject({ status: 'completed', finalAction: 'none' });
    expect(model.transcript[0]?.systemPrompt).toContain('Your roster could not be read');
  });
});

describe('check-in routing', () => {
  const HOF = { personalityId: 'hype-man', difficulty: 'hall_of_famer', archetype: 'win_now' } as const;
  const detail = (slot: string, date = '2026-10-04', nextAt = '2026-10-05T00:00:00.000Z') => ({
    leagueId: LEAGUE_ID,
    slot,
    date,
    at: START,
    nextAt,
    week: 5
  });
  const event = (id: string, d: Record<string, unknown>): BusEvent => ({
    id,
    'detail-type': 'Manager Check-In',
    source: 'fantasy',
    detail: d
  });

  async function seated() {
    const s = await setup();
    await s.seat('team-2', STEADY);
    await s.seat('team-3', HOF);
    const route = (e: BusEvent, responseDelays = false) =>
      routeEvent({ services: s.services, kinds: defaultTaskKinds, responseDelays }, e);
    const requested = () =>
      s.events.events
        .filter((e) => e.detailType === 'Agent Action Requested')
        .map((e) => AgentActionRequestedSchema.parse(e.detail));
    return { ...s, route, requested };
  }

  it('fans out to every agent once per date and slot, with a first look for agents that never had one', async () => {
    const s = await seated();
    // team-3 had its post-draft kickoff; team-2's league was drafted before there was one.
    await s.repos.agents.putTriggerState({
      leagueId: LEAGUE_ID,
      agentId: cooldownSlot(`${LEAGUE_ID}.team-3`, { kind: 'post_draft' }),
      lastTriggeredAt: START
    });
    const first = await s.route(event('evt-c1', detail('afternoon')));
    expect(first.map((d) => [d.teamId, d.kind, d.decision])).toEqual([
      ['team-2', 'check_in', 'requested'],
      ['team-3', 'check_in', 'requested']
    ]);
    // Both still have placeholder names (#196): the check-in may name them.
    expect(s.requested().map((r) => [r.teamId, r.payload])).toEqual([
      ['team-2', { slot: 'afternoon', date: '2026-10-04', week: 5, firstLook: true, naming: 'placeholder' }],
      ['team-3', { slot: 'afternoon', date: '2026-10-04', week: 5, firstLook: false, naming: 'placeholder' }]
    ]);
    // A replayed event (same date and slot) is ignored.
    expect((await s.route(event('evt-c1-again', detail('afternoon')))).map((d) => d.decision)).toEqual([
      'repeat',
      'repeat'
    ]);
    // Nothing to key it by: not a check-in the router can dedupe, so it is refused as a repeat-proof no-op.
    s.clock.advance(6 * 3_600_000);
    const evening = await s.route(event('evt-c2', detail('evening')));
    expect(evening.map((d) => d.decision)).toEqual(['requested', 'requested']);
    expect(s.requested().at(-1)?.payload).toMatchObject({ firstLook: false });
  });

  it('keeps its own cooldown slot, so a check-in never holds up (or is held up by) other work', async () => {
    const s = await seated();
    await s.route({
      id: 'evt-w',
      'detail-type': 'Waiver Window Opened',
      source: 'fantasy',
      detail: { leagueId: LEAGUE_ID, week: 5 }
    });
    const checkIns = await s.route(event('evt-c1', detail('afternoon')));
    expect(checkIns.map((d) => d.decision)).toEqual(['requested', 'requested']);
    // Another slot within the difficulty's cooldown (pro: 60 minutes) waits; the HOF (15) does not.
    s.clock.advance(30 * 60_000);
    const soon = await s.route(event('evt-c2', detail('evening')));
    expect(soon.map((d) => [d.teamId, d.decision])).toEqual([
      ['team-2', 'cooldown'],
      ['team-3', 'requested']
    ]);
    expect(await s.repos.agents.getTriggerState(LEAGUE_ID, `${LEAGUE_ID}.team-2#check_in`)).not.toBeNull();
  });

  it('wanders in after a human-like delay, before the next check-in and the next lineup lock', async () => {
    const s = await seated();
    const lever = DIFFICULTY_TIERS.pro.levers.responseDelay;
    // The next check-in two hours out bounds the delay to an hour; the SF kickoff is 5h25m away.
    const nextAt = new Date(Date.parse(START) + 2 * 3_600_000).toISOString();
    let id = '';
    for (let i = 0; i < 1000 && id === ''; i++) {
      const candidate = `evt-delay-${i}`;
      const roll = responseDelay({
        eventClass: 'roster',
        seed: `${candidate}:team-2`,
        lever,
        now: new Date(START),
        deadline: nextAt
      });
      if (roll.reason === 'deadline') id = candidate;
    }
    const decisions = await s.route(event(id, detail('afternoon', '2026-10-04', nextAt)), true);
    const mine = decisions.find((d) => d.teamId === 'team-2');
    expect(mine?.decision).toBe('requested');
    expect(mine?.decision === 'requested' && mine.delayMs).toBe(3_600_000);
    for (const d of decisions) expect(d.decision === 'requested' && d.delayMs <= 3_600_000).toBe(true);
    // Delayed tasks are scheduled, not published.
    expect(s.events.events.some((e) => e.detailType === 'Schedule Event')).toBe(true);
    // With the next check-in far off, the next lineup lock bounds it instead.
    const other = await seated();
    const far = await other.route(
      event(id, detail('evening', '2026-10-04', '2026-10-06T00:00:00.000Z')),
      true
    );
    const lockLimit = (Date.parse(SF_KICKOFF) - Date.parse(START)) / 2;
    expect(far.map((d) => d.decision)).toEqual(['requested', 'requested']);
    for (const d of far) expect(d.decision === 'requested' && d.delayMs <= lockLimit).toBe(true);
  });

  it('routes nothing without a league, and never fires twice for an event with no slot', async () => {
    const s = await seated();
    expect(await s.route(event('evt-none', { slot: 'morning' }))).toEqual([]);
    const unkeyed = await s.route(event('evt-u1', { leagueId: LEAGUE_ID }));
    expect(unkeyed.map((d) => d.decision)).toEqual(['requested', 'requested']);
    expect(s.requested().at(-1)?.payload).toEqual({ firstLook: true, naming: 'placeholder' });
  });
});
