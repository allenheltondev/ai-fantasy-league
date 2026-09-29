import {
  FixedClock,
  emptyAgenda,
  emptyAttachments,
  reconcileAgenda,
  recordAcquisition,
  resolveAgentConfig,
  type Acquisition,
  type AgentSeatConfig,
  type DraftPick
} from '@fantasy/core';
import {
  agentPrincipal,
  createContext,
  executeOperation,
  seatTenureStart,
  type UserPrincipal
} from '@fantasy/server';
import { describe, expect, it, vi } from 'vitest';
import { ATTACHMENT_KINDS, recordAttachments, refreshAttachments } from '../src/attachments.js';
import type { BusEvent } from '../src/events.js';
import { ScriptedModelClient } from '../src/fake-model.js';
import { ingestLeagueEvent } from '../src/ingest.js';
import { runAgentAction } from '../src/runner.js';
import type { TaskContext } from '../src/tasks/kinds.js';
import { tradeProposalTask } from '../src/tasks/trade-proposal.js';
import { tradeResponseTask } from '../src/tasks/trades.js';
import { ToolBox } from '../src/tools.js';
import { AGENT_TEAM, LEAGUE_ID, START, roster, setup, type Setup } from './support.js';

/**
 * Player attachments in the runtime (#216): created from real picks and trades, revised from
 * authoritative results, and turned into a capped trade-bar premium that a pressing agenda need can
 * outweigh but nothing can push below the hard floor.
 */

const AGENT_ID = `${LEAGUE_ID}.${AGENT_TEAM}`;
// No valuation noise, a balanced trade appetite (bar 1): the numbers below are exact.
const EXACT: AgentSeatConfig = {
  personalityId: 'stats-nerd',
  difficulty: 'hall_of_famer',
  archetype: 'balanced'
};
const ALLEN: UserPrincipal = { type: 'user', sub: 'user-123', email: null, name: 'Allen' };
const LATER = '2026-10-06T15:00:00.000Z';

const busEvent = (detailType: string, detail: unknown, time?: string): BusEvent => ({
  id: `${detailType}-${Math.random()}`,
  'detail-type': detailType,
  source: 'fantasy',
  ...(time === undefined ? {} : { time }),
  detail
});

const pick = (
  overall: number,
  teamId: string,
  playerId: string,
  extra: Partial<DraftPick> = {}
): DraftPick => ({
  overall,
  round: Math.ceil(overall / 4),
  pick: ((overall - 1) % 4) + 1,
  teamId,
  playerId,
  positions: ['RB'],
  madeAt: START,
  auto: false,
  ...extra
});

async function draftLeague(picks: DraftPick[]): Promise<Setup> {
  const s = await setup();
  await s.seat(AGENT_TEAM, EXACT);
  await s.repos.drafts.create({
    leagueId: LEAGUE_ID,
    state: {
      teamIds: ['team-1', 'team-2', 'team-3', 'team-4'],
      rounds: 15,
      pickSeconds: 60,
      positionLimits: {},
      tradedPicks: [],
      picks
    },
    status: 'complete',
    startedAt: START,
    deadline: null,
    pausedRemainingSeconds: null,
    completedAt: START,
    updatedAt: START,
    version: 1
  });
  return s;
}

const draftCompleted = () =>
  busEvent('Draft Completed', {
    leagueId: LEAGUE_ID,
    picks: 60,
    rounds: 15,
    week: 5,
    completedAt: START
  });

async function tenure(s: Setup, teamId = AGENT_TEAM) {
  return seatTenureStart((await s.repos.teams.get(LEAGUE_ID, teamId))!);
}
const stored = async (s: Setup, teamId = AGENT_TEAM) =>
  s.repos.agents.getAttachments(LEAGUE_ID, `${LEAGUE_ID}.${teamId}`, await tenure(s, teamId));

async function context(s: Setup, config: AgentSeatConfig = EXACT): Promise<TaskContext> {
  await s.seat(AGENT_TEAM, config);
  const principal = agentPrincipal({ agentId: AGENT_ID, teamId: AGENT_TEAM, leagueId: LEAGUE_ID });
  return {
    taskId: 'attachments-test',
    principal,
    seat: (await s.repos.agents.getSeat(LEAGUE_ID, AGENT_TEAM))!,
    config: resolveAgentConfig(config),
    league: (await s.repos.leagues.get(LEAGUE_ID))!,
    clock: s.clock,
    log: s.services.log,
    trigger: { detailType: 'Trade Proposed', eventId: 'event' },
    claimLimit: async () => true,
    tools: new ToolBox({
      registry: s.registry,
      services: s.services,
      principal,
      research: { news: true, projections: true, trending: true, matchupOutlook: true },
      actionsPerTrigger: 10,
      idempotencyPrefix: 'attachments-test'
    })
  };
}

const acquisition = (playerId: string, position: Acquisition['position'], round = 1): Acquisition => ({
  sourceId: `draft:${LEAGUE_ID}:${playerId}`,
  kind: 'drafted',
  playerId,
  name: playerId.toUpperCase(),
  position,
  at: START,
  round
});

describe('attachment creation from league records', () => {
  it('attaches an agent to its own real picks once, and to nothing else', async () => {
    const s = await draftLeague([
      pick(1, 'team-1', 'team-1-rb1'),
      pick(2, AGENT_TEAM, 'rb1'),
      // An autopick is not the manager's choice.
      pick(6, AGENT_TEAM, 'wr1', { auto: true, positions: ['WR'] }),
      // A pick it no longer rosters.
      pick(10, AGENT_TEAM, 'gone'),
      // A pick with no known position.
      pick(14, AGENT_TEAM, 'mystery', { positions: [] }),
      pick(18, AGENT_TEAM, 'wr2', { positions: ['WR'], madeAt: null }),
      pick(3, 'team-3', 'team-3-wr1', { positions: ['WR'] })
    ]);
    const team = (await s.repos.teams.get(LEAGUE_ID, AGENT_TEAM))!;
    await s.repos.teams.update({ ...team, roster: [...team.roster, 'mystery'] });
    expect(await recordAttachments(s.services, draftCompleted())).toBe(1);
    const first = await stored(s);
    expect(first.preferences).toEqual([
      expect.objectContaining({
        playerId: 'rb1',
        name: 'RB1',
        position: 'RB',
        status: 'held',
        sources: [{ id: `draft:${LEAGUE_ID}:2`, kind: 'drafted', at: START, round: 1 }]
      })
    ]);
    // A redelivered event strengthens nothing.
    await recordAttachments(s.services, draftCompleted());
    expect(await stored(s)).toEqual(first);
    // Team 3's agent has no seat record here, and a person's team never gets one.
    expect(await stored(s, 'team-3')).toEqual(emptyAttachments());
    expect(await stored(s, 'team-1')).toEqual(emptyAttachments());
  });

  it('gives a new seat occupant nothing from the previous occupant (no fabricated affection)', async () => {
    const s = await draftLeague([pick(2, AGENT_TEAM, 'rb1')]);
    const team = (await s.repos.teams.get(LEAGUE_ID, AGENT_TEAM))!;
    await s.repos.teams.update({ ...team, occupiedSince: LATER });
    await recordAttachments(s.services, draftCompleted());
    expect(await stored(s)).toEqual(emptyAttachments());
    // And its trade prompt names no favorite.
    s.clock.set(LATER);
    const ctx = await context(s);
    expect(await refreshAttachments(s.services, ctx)).toEqual(emptyAttachments());
  });

  it('attaches to players received in a processed trade and ends the ones sent away', async () => {
    const s = await setup();
    await s.seat(AGENT_TEAM, EXACT);
    const id = await tenure(s);
    await s.repos.agents.updateAttachments(LEAGUE_ID, AGENT_ID, id, (a) =>
      recordAcquisition(a, acquisition('rb1', 'RB'))
    );
    const team = (await s.repos.teams.get(LEAGUE_ID, AGENT_TEAM))!;
    await s.repos.teams.update({ ...team, roster: [...team.roster.filter((p) => p !== 'rb1'), 'rb9'] });
    const ref = (pid: string) => ({ id: pid, name: pid.toUpperCase(), team: 'SF', position: 'RB' as const });
    const detail = {
      leagueId: LEAGUE_ID,
      tradeId: 't1',
      status: 'processed',
      fromTeamId: 'team-1',
      toTeamId: AGENT_TEAM,
      teamIds: ['team-1', AGENT_TEAM],
      fromPlayers: [ref('rb9'), ref('elsewhere')],
      toPlayers: [ref('rb1')],
      fromDrops: [],
      toDrops: [],
      counterOf: null,
      expiresAt: LATER,
      reviewEndsAt: null,
      review: 'none'
    };
    expect(await recordAttachments(s.services, busEvent('Trade Processed', detail, LATER))).toBe(1);
    const after = await stored(s);
    expect(after.preferences.find((p) => p.playerId === 'rb1')).toMatchObject({
      status: 'departed',
      departedAt: LATER,
      revisions: [expect.objectContaining({ reason: 'Traded away (t1).' })]
    });
    expect(after.preferences.find((p) => p.playerId === 'rb9')).toMatchObject({
      status: 'held',
      sources: [{ id: 'trade:t1:rb9', kind: 'traded_for', at: LATER }]
    });
    // A player it no longer holds by the time the event lands is not picked up.
    expect(after.preferences.some((p) => p.playerId === 'elsewhere')).toBe(false);
    // A trade from before the seat's tenure (delivered late to a new occupant) changes nothing.
    await s.repos.teams.update({
      ...(await s.repos.teams.get(LEAGUE_ID, AGENT_TEAM))!,
      occupiedSince: LATER
    });
    expect(
      await recordAttachments(s.services, busEvent('Trade Processed', { ...detail, tradeId: 't0' }, START))
    ).toBe(0);
    // Without an event time the clock stands in.
    expect(
      await recordAttachments(s.services, busEvent('Trade Processed', { ...detail, tradeId: 't2' }))
    ).toBe(0);
  });

  it('ignores other sources, other events, unreadable details, and leagues without a draft', async () => {
    const s = await setup();
    expect(await recordAttachments(s.services, { ...draftCompleted(), source: 'other' })).toBe(0);
    expect(await recordAttachments(s.services, busEvent('Week Rolled Over', {}))).toBe(0);
    expect(await recordAttachments(s.services, busEvent('Draft Completed', { leagueId: 1 }))).toBe(0);
    expect(await recordAttachments(s.services, busEvent('Trade Processed', { leagueId: 1 }))).toBe(0);
    expect(await recordAttachments(s.services, draftCompleted())).toBe(0);
  });

  it('is part of ingestion, and a failure there never blocks routing', async () => {
    const s = await draftLeague([pick(2, AGENT_TEAM, 'rb1')]);
    const deps = { services: s.services, events: s.events, repos: s.repos } as never;
    await ingestLeagueEvent(deps, draftCompleted()).catch(() => undefined);
    expect((await stored(s)).preferences.map((p) => p.playerId)).toEqual(['rb1']);
    vi.spyOn(s.repos.agents, 'updateAttachments').mockRejectedValueOnce(new Error('offline'));
    await ingestLeagueEvent(deps, { ...draftCompleted(), id: 'again' }).catch(() => undefined);
    expect(s.logs.join(' ')).toContain('agent attachment update failed');
  });
});

describe('attachment revision before a decision', () => {
  const lastWeek = (points: number | null, state = 'final') => ({
    league: null,
    warnings: [],
    data: {
      week: 4,
      players: [
        { player: { id: 'rb1' }, points, projectedPoints: 15, game: { state } },
        { player: { id: 'wr1' }, points: 1, projectedPoints: null, game: null }
      ]
    }
  });

  it('revises from last week, replaces a corrected week, and ends departed players', async () => {
    const s = await setup();
    const ctx = await context(s);
    const id = await tenure(s);
    await s.repos.agents.updateAttachments(LEAGUE_ID, AGENT_ID, id, (a) =>
      recordAcquisition(recordAcquisition(a, acquisition('rb1', 'RB')), acquisition('rb2', 'RB', 2))
    );
    const call = vi.spyOn(ctx.tools, 'call').mockResolvedValue(lastWeek(2));
    const first = (await refreshAttachments(s.services, ctx))!;
    expect(call).toHaveBeenCalledWith('get_roster', { teamId: AGENT_TEAM, week: 4 });
    expect(first.preferences.find((p) => p.playerId === 'rb1')?.performance).toHaveLength(1);
    // A stat correction for the same week replaces it; it does not count twice.
    s.clock.advance(60_000);
    call.mockResolvedValue(lastWeek(22));
    const corrected = (await refreshAttachments(s.services, ctx))!;
    const rb1 = corrected.preferences.find((p) => p.playerId === 'rb1')!;
    expect(rb1.performance).toEqual([expect.objectContaining({ week: 4, points: 22 })]);
    // A live game, an unreadable roster, or another week says nothing.
    for (const answer of [
      lastWeek(40, 'live'),
      { error: { code: 'FORBIDDEN', message: 'no', fix: 'retry' } },
      { ...lastWeek(40), data: { ...lastWeek(40).data, week: 3 } }
    ]) {
      s.clock.advance(60_000);
      call.mockResolvedValue(answer as never);
      expect(
        (await refreshAttachments(s.services, ctx))!.preferences.find((p) => p.playerId === 'rb1')
          ?.performance
      ).toEqual(rb1.performance);
    }
    // A player who left the roster is no longer held.
    const team = (await s.repos.teams.get(LEAGUE_ID, AGENT_TEAM))!;
    await s.repos.teams.update({ ...team, roster: team.roster.filter((p) => p !== 'rb2') });
    s.clock.advance(60_000);
    const gone = (await refreshAttachments(s.services, ctx))!;
    expect(gone.preferences.find((p) => p.playerId === 'rb2')?.status).toBe('departed');
  });

  it('reads nothing extra without a held attachment, before the season, or in the first week', async () => {
    const s = await setup();
    const ctx = await context(s);
    const call = vi.spyOn(ctx.tools, 'call');
    expect(await refreshAttachments(s.services, ctx)).toEqual(emptyAttachments());
    await s.repos.agents.updateAttachments(LEAGUE_ID, AGENT_ID, await tenure(s), (a) =>
      recordAcquisition(a, acquisition('rb1', 'RB'))
    );
    // It uses the league the task already read (no second league read).
    const leagueGet = vi.spyOn(s.repos.leagues, 'get');
    const league = ctx.league;
    ctx.league = { ...league, phase: 'drafting' };
    expect((await refreshAttachments(s.services, ctx))?.preferences).toHaveLength(1);
    ctx.league = { ...league, week: league.settings.schedule.startWeek };
    expect((await refreshAttachments(s.services, ctx))?.preferences).toHaveLength(1);
    ctx.league = league;
    expect(leagueGet).not.toHaveBeenCalled();
    // Years later, time alone has not erased it, but only results could make it count again.
    s.clock.advance(3 * 365 * 86_400_000);
    await s.repos.agents.updateAttachments(LEAGUE_ID, AGENT_ID, await tenure(s), (a) => ({
      ...a,
      preferences: a.preferences.map((p) => ({ ...p, strength: 0.3 }))
    }));
    expect((await refreshAttachments(s.services, ctx))?.preferences).toHaveLength(1);
    expect(call).not.toHaveBeenCalledWith('get_roster', expect.anything());
  });

  it('decides without attachments when they cannot be read', async () => {
    const s = await setup();
    const ctx = await context(s);
    const teamGet = vi.spyOn(s.repos.teams, 'get');
    const team = (await s.repos.teams.get(LEAGUE_ID, AGENT_TEAM))!;
    teamGet.mockResolvedValueOnce({ ...team, seatType: 'human' });
    expect(await refreshAttachments(s.services, ctx)).toBeUndefined();
    vi.spyOn(s.repos.agents, 'getAttachments').mockRejectedValueOnce(new Error('offline'));
    expect(await refreshAttachments(s.services, ctx)).toBeUndefined();
    expect(s.logs.join(' ')).toContain('agent attachments unavailable');
  });
});

describe('attachment policy in trade decisions', () => {
  const player = (id: string, position: string) => ({ id, name: id.toUpperCase(), position });
  type Ref = ReturnType<typeof player>;
  const tradeSide = (teamId: string, lineupDelta: number, sends: Ref[], receives: Ref[]) => ({
    team: { id: teamId },
    lineupDelta,
    valueDelta: 0,
    sends,
    receives,
    drops: [],
    dropsNeeded: 0,
    dropCandidates: []
  });
  /** A scripted trade answer: Allen offers `receive` for `send`, worth `score` to the agent. */
  function offer(score: number, send: ReturnType<typeof player>[], receive = [player('rb9', 'RB')]) {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const answers: Record<string, unknown> = {
      list_trades: {
        trades: [
          {
            id: 't9',
            status: 'proposed',
            round: 0,
            fromTeam: { id: 'team-1', name: 'Allen' },
            fromSends: receive,
            toSends: send,
            yourActions: ['accept', 'reject', 'counter']
          }
        ]
      },
      preview_trade: (args: { tradeId?: string; send?: string[] }) => {
        // The offer as it stands: Allen's side first, then the agent's.
        if (args.tradeId !== undefined)
          return {
            valid: true,
            issues: [],
            sides: [tradeSide('team-1', -score, receive, send), tradeSide(AGENT_TEAM, score, send, receive)],
            players: [
              ...send.map((p, i) => ({ player: p, fromTeamId: AGENT_TEAM, projectedPoints: 10 + i })),
              ...receive.map((p) => ({ player: p, fromTeamId: 'team-1', projectedPoints: 10 }))
            ]
          };
        // A counter (the agent's side first) that keeps some players out is worth a little less.
        const sends = send.filter((p) => args.send?.includes(p.id));
        return {
          valid: true,
          issues: [],
          sides: [tradeSide(AGENT_TEAM, score - 0.5, sends, receive), tradeSide('team-1', 0, receive, sends)],
          players: []
        };
      },
      respond_to_trade: { trade: { id: 't9' } },
      counter_trade: { trade: { id: 't10' } }
    };
    const ctx = {
      taskId: 'scripted',
      principal: { teamId: AGENT_TEAM },
      config: resolveAgentConfig(EXACT),
      seat: { agentId: AGENT_ID },
      league: { id: LEAGUE_ID, week: 5 },
      clock: new FixedClock(START),
      calls,
      tools: {
        call: async (name: string, args: Record<string, unknown>) => {
          calls.push({ name, args });
          const answer = answers[name];
          return {
            data: typeof answer === 'function' ? (answer as (a: unknown) => unknown)(args) : answer,
            league: null,
            warnings: []
          };
        }
      }
    } as unknown as TaskContext & { calls: typeof calls };
    return ctx;
  }
  const held = (...ids: [string, Acquisition['position']][]) =>
    ids.reduce((a, [id, position]) => recordAcquisition(a, acquisition(id, position)), emptyAttachments());
  const rbNeed = reconcileAgenda(emptyAgenda(), {
    at: START,
    taskId: 'need',
    week: 5,
    complete: false,
    holes: ['RB']
  });
  const answer = async (ctx: TaskContext, action: 'accept' | 'reject' | 'counter' = 'accept', extra = {}) => {
    const task = await tradeResponseTask.prepare(ctx, { tradeId: 't9' });
    return { task, outcome: await task.apply({ summary: 'My call.', action, ...extra }) };
  };

  it('holds an attached player to a higher bar, with base, premium, and result inspectable', async () => {
    const bare = offer(2, [player('wr1', 'WR')]);
    const plain = await answer(bare);
    expect(plain.outcome.action).toBe('accept_trade');
    expect(plain.task.instructions).not.toContain('attached');

    const ctx = offer(2, [player('wr1', 'WR')]);
    ctx.attachments = held(['wr1', 'WR']);
    const { task, outcome } = await answer(ctx, 'reject');
    const fake = task.fakeScript?.().decision as { action: string; summary: string };
    // Base bar 1, plus 0.7 conviction × 4 × 0.95 (balanced) = 2.7: a score of 2 no longer clears it.
    expect(fake.action).toBe('reject');
    expect(fake.summary).toContain('bar 3.7');
    expect(task.instructions).toContain('You are attached to WR1 (WR): you drafted him in round 1');
    expect(task.instructions).not.toMatch(/premium|2\.7/);
    expect(outcome.summary).toContain('Held WR1 to a higher bar');
    expect(outcome.memorySummary).toContain('Held WR1 to a higher bar');
  });

  it('keeps the favorite out of its suggested counter, and floors the counter by its own terms', async () => {
    const ctx = offer(2, [player('wr1', 'WR'), player('wr2', 'WR')]);
    ctx.attachments = held(['wr1', 'WR']);
    const task = await tradeResponseTask.prepare(ctx, { tradeId: 't9' });
    const fake = task.fakeScript?.().decision as { action: string; send?: string[] };
    expect(fake).toMatchObject({ action: 'counter', send: ['wr2'] });
    const outcome = await task.apply(fake);
    // Without the favorite in it, the counter clears the base floor and goes out.
    expect(outcome.action).toBe('counter_trade');
    expect(ctx.calls.find((c) => c.name === 'counter_trade')?.args).toMatchObject({ send: ['wr2'] });
  });

  it('lets a pressing need outweigh the attachment without going under the hard floor', async () => {
    const ctx = offer(2, [player('wr1', 'WR')]);
    ctx.attachments = held(['wr1', 'WR']);
    ctx.agenda = rbNeed;
    const { task, outcome } = await answer(ctx);
    expect(outcome.action).toBe('accept_trade');
    // The sealed activity log says a need outweighed it, generically: no slot, no goal id.
    expect(outcome.summary).toContain('Set aside my attachment to WR1 for a roster need.');
    expect(outcome.summary).not.toMatch(/RB need|repair_position/);
    expect(outcome.sealed).toMatchObject({ trades: [{ tradeId: 't9', until: 'public' }] });
    // The agent's own record, which later chat may recall, keeps no agenda information.
    expect(outcome.memorySummary).not.toMatch(/need|repair_position|Set aside/);
    // The need is private: the model that writes to Allen never reads it, nor the waived attachment.
    expect(task.instructions).not.toMatch(/need|repair_position/);
    expect(task.instructions).not.toContain('attached');

    // A bad deal stays bad: the need waives the premium, never the base floor (bar 1 - 5 = -4).
    const bad = offer(-6, [player('wr1', 'WR')]);
    bad.attachments = held(['wr1', 'WR']);
    bad.agenda = rbNeed;
    const refused = await answer(bad);
    expect(refused.outcome.action).toBe('reject_trade');
    expect(refused.outcome.summary).toContain('floor -4');

    // The premium also lifts the model's accept floor when no need outweighs it.
    const close = offer(-2, [player('wr1', 'WR')]);
    close.attachments = held(['wr1', 'WR']);
    expect((await answer(close)).outcome.action).toBe('reject_trade');
    const loose = offer(-2, [player('wr1', 'WR')]);
    expect((await answer(loose)).outcome.action).toBe('accept_trade');
  });

  it('applies the same premium to trade scouting, and the need override there too', async () => {
    const entry = (id: string, position: string, slot: string, projectedPoints: number) => ({
      player: { id, name: id.toUpperCase(), position },
      slot,
      projectedPoints
    });
    const rosters: Record<string, unknown> = {
      [AGENT_TEAM]: {
        players: [entry('wq', 'QB', 'QB', 20), entry('wr1', 'WR', 'BN', 18), entry('mr', 'RB', 'RB', 5)]
      },
      'team-1': {
        players: [entry('aq', 'QB', 'QB', 8), entry('ar', 'RB', 'BN', 15), entry('aw', 'WR', 'WR', 2)]
      }
    };
    const scout = () => {
      const ctx = offer(0, []);
      const call = ctx.tools.call;
      ctx.tools.call = (async (name: string, args: Record<string, unknown>) => {
        if (name === 'get_league_state')
          return {
            data: {
              week: 5,
              allowedActions: ['propose_trade'],
              yourTeam: { id: AGENT_TEAM },
              teams: [
                { id: AGENT_TEAM, name: 'Me' },
                { id: 'team-1', name: 'Allen' }
              ]
            },
            league: null,
            warnings: []
          };
        if (name === 'list_trades') return { data: { trades: [] }, league: null, warnings: [] };
        if (name === 'propose_trade') return { data: { trade: { id: 't20' } }, league: null, warnings: [] };
        if (name === 'get_roster')
          return { data: rosters[args.teamId as string], league: null, warnings: [] };
        if (name === 'preview_trade')
          return {
            data: {
              valid: true,
              sides: [
                { lineupDelta: 2, valueDelta: 0 },
                { lineupDelta: 2, valueDelta: 0 }
              ],
              fairness: { lopsided: false }
            },
            league: null,
            warnings: []
          };
        return call(name, args);
      }) as never;
      return ctx;
    };
    const free = await tradeProposalTask.prepare(scout(), {});
    expect(free.instructions).toContain('your WR1 (WR) for their AR (RB)');
    const attached = scout();
    attached.attachments = held(['wr1', 'WR']);
    await expect(tradeProposalTask.prepare(attached, {})).rejects.toThrow('no_trade_found');
    const needy = scout();
    needy.attachments = held(['wr1', 'WR']);
    needy.agenda = rbNeed;
    const repaired = await tradeProposalTask.prepare(needy, {});
    expect(repaired.instructions).toContain('your WR1 (WR) for their AR (RB)');
    expect(repaired.instructions).not.toContain('attached');
    const sent = await repaired.apply({ summary: 'Sending it.', offers: [{ candidate: 1 }] });
    expect(sent.summary).toContain('Set aside my attachment to WR1 for a roster need.');
    expect(sent.sealed?.trades).toEqual([{ tradeId: 't20', until: 'public' }]);
    expect(sent.memorySummary).not.toMatch(/need|repair_position|Set aside/);
  });

  it('holds a chat pitch for a favorite to the same higher bar', async () => {
    const s = await setup();
    const ctx = await context(s);
    ctx.attachments = held(['wr1', 'WR']);
    vi.spyOn(ctx.tools, 'call').mockImplementation(async (name, args) => {
      if (name === 'get_chat') return { error: { code: 'ROOM_NOT_FOUND', message: 'gone', fix: 'x' } };
      const data: Record<string, unknown> = {
        get_league_state: {
          week: 5,
          allowedActions: ['propose_trade'],
          yourTeam: { id: AGENT_TEAM },
          teams: [{ id: 'team-1', name: 'Allen', seatType: 'human' }]
        },
        get_roster: {
          players: [
            {
              player: args.teamId === AGENT_TEAM ? player('wr1', 'WR') : player('rb9', 'RB'),
              slot: 'BN',
              projectedPoints: 10
            }
          ]
        },
        preview_trade: {
          valid: true,
          sides: [
            { lineupDelta: 2, valueDelta: 0 },
            { lineupDelta: 1, valueDelta: 0 }
          ],
          fairness: { lopsided: false }
        }
      };
      return { data: data[name], league: null, warnings: [] };
    });
    const pitch = {
      reason: 'chat' as const,
      withTeamId: 'team-1',
      send: ['wr1'],
      receive: ['rb9'],
      chat: { roomId: 'league', messageId: 'm1', fromTeamId: 'team-1' }
    };
    await expect(tradeProposalTask.prepare(ctx, pitch)).rejects.toMatchObject({
      message: 'not_convinced',
      summary: expect.stringContaining('against my bar 3.7. Not convinced. Held WR1 to a higher bar')
    });
    // Without the attachment the same pitch clears the base bar alone.
    delete ctx.attachments;
    const task = await tradeProposalTask.prepare(ctx, pitch);
    expect(task.instructions).toContain('Your bar is 1.');
    expect(task.instructions).not.toContain('attached');
  });

  it('reaches trade prompts through the runner, consistent with the choice', async () => {
    expect([...ATTACHMENT_KINDS].sort()).toEqual(['check_in', 'trade_proposal', 'trade_response']);
    const s = await setup();
    await s.seat(AGENT_TEAM, EXACT);
    await s.repos.agents.updateAttachments(LEAGUE_ID, AGENT_ID, await tenure(s), (a) =>
      recordAcquisition(a, acquisition('rb4', 'RB'))
    );
    // Allen (team-1) offers rb3, the only player who projects, for the agent's rb4.
    const team1 = (await s.repos.teams.get(LEAGUE_ID, 'team-1'))!;
    const team2 = (await s.repos.teams.get(LEAGUE_ID, AGENT_TEAM))!;
    await s.repos.teams.update({
      ...team2,
      roster: roster()
        .map((r) => r.playerId)
        .filter((id) => id !== 'rb3')
    });
    await s.repos.teams.update({ ...team1, roster: ['rb3'] });
    await s.repos.lineups.put([]);
    const operation = s.registry.get('propose_trade')!;
    const res = await executeOperation({
      registry: s.registry,
      operation,
      ctx: createContext(s.services, ALLEN),
      input: { leagueId: LEAGUE_ID, withTeamId: AGENT_TEAM, send: ['rb3'], receive: ['rb4'] },
      idempotencyKey: 'attachments-allen-0001'
    });
    const tradeId = (res.body as { data: { trade: { id: string } } }).data.trade.id;
    const model = new ScriptedModelClient();
    const record = await runAgentAction(s.deps(model), {
      taskId: 'trade_response.attached',
      leagueId: LEAGUE_ID,
      teamId: AGENT_TEAM,
      agentId: AGENT_ID,
      kind: 'trade_response',
      trigger: { detailType: 'Trade Proposed', eventId: 'attached', urgent: true },
      payload: { tradeId, fromTeamId: 'team-1' },
      requestedAt: START
    });
    const prompt = model.transcript[0]?.systemPrompt ?? '';
    expect(prompt).toContain('You are attached to RB4 (RB): you drafted him in round 1');
    // The value math still wins by a mile: the premium is small, and the summary says it weighed it.
    expect(record).toMatchObject({ status: 'completed', finalAction: 'accept_trade' });
    expect(record.reasoningSummary).toContain('Held RB4 to a higher bar');
  });
});
