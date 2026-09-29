import {
  composeBehavior,
  type AgentSeatConfig,
  resolveAgentConfig,
  yahooDefaultSettings,
  type SituationalState
} from '@fantasy/core';
import { agentPrincipal, type Matchup } from '@fantasy/server';
import { describe, expect, it, vi } from 'vitest';
import { ScriptedModelClient } from '../src/fake-model.js';
import { runAgentAction } from '../src/runner.js';
import { effectiveBehavior, readSituation } from '../src/situation.js';
import {
  BaseDecisionSchema,
  createTaskKindRegistry,
  defineTaskKind,
  type TaskContext
} from '../src/tasks/kinds.js';
import { TaskUnavailableError } from '../src/tasks/lineup.js';
import { scoutProposals } from '../src/tasks/trade-proposal.js';
import { scout } from '../src/tasks/waivers.js';
import { ToolBox } from '../src/tools.js';
import { HAPPY, market } from './market.js';
import { AGENT_TEAM, LEAGUE_ID, START, setup, type Setup } from './support.js';

const agentId = `${LEAGUE_ID}.${AGENT_TEAM}`;
const config = { personalityId: 'stats-nerd', difficulty: 'pro', archetype: 'balanced' } as const;

/** Four teams, two playoff seats: a real race, unlike the support league where everyone qualifies. */
function raceSettings() {
  const settings = yahooDefaultSettings(4);
  settings.waivers.type = 'faab';
  settings.playoffs = { ...settings.playoffs, teams: 2, byes: 0 };
  return settings;
}

const game = (
  week: number,
  home: string,
  away: string,
  homeScore: number,
  awayScore: number,
  status: Matchup['status'] = 'final'
): Matchup => ({
  id: `w${week}-${home}-${away}`,
  leagueId: LEAGUE_ID,
  week,
  kind: 'regular',
  homeTeamId: home,
  awayTeamId: away,
  homeScore,
  awayScore,
  status
});

/** team-2 (the agent) goes 4-0, team-1 3-1, team-3 and team-4 1-3. */
const FOUR_WEEKS = [
  game(1, 'team-2', 'team-1', 120, 100),
  game(1, 'team-3', 'team-4', 110, 90),
  game(2, 'team-2', 'team-4', 120, 100),
  game(2, 'team-1', 'team-3', 110, 90),
  game(3, 'team-2', 'team-3', 120, 100),
  game(3, 'team-1', 'team-4', 110, 90),
  game(4, 'team-2', 'team-1', 120, 100),
  game(4, 'team-4', 'team-3', 110, 90)
];

async function context(s: Setup, seat: AgentSeatConfig = config): Promise<TaskContext> {
  await s.seat(AGENT_TEAM, seat);
  const principal = agentPrincipal({ agentId, teamId: AGENT_TEAM, leagueId: LEAGUE_ID });
  return {
    taskId: 'situation-test',
    principal,
    seat: (await s.repos.agents.getSeat(LEAGUE_ID, AGENT_TEAM))!,
    config: resolveAgentConfig(seat),
    league: (await s.repos.leagues.get(LEAGUE_ID))!,
    clock: s.clock,
    log: s.services.log,
    trigger: { detailType: 'Manager Check-In', eventId: 'event' },
    claimLimit: async () => true,
    tools: new ToolBox({
      registry: s.registry,
      services: s.services,
      principal,
      research: { news: true, projections: true, trending: true, matchupOutlook: true },
      actionsPerTrigger: 10,
      idempotencyPrefix: 'situation-test'
    })
  };
}

/** A contender whose only thin position is `thin`: it protects that depth. */
const contender = (thin: 'QB' | 'TE'): SituationalState => ({
  schemaVersion: 1,
  week: 5,
  throughWeek: 4,
  remainingWeeks: 11,
  urgency: 'contender',
  basis: 'heuristic',
  reasons: ['in_playoff_position', 'comfortable_cushion'],
  sinceWeek: 4,
  previous: 'baseline',
  pending: null,
  horizon: 'season',
  standing: null,
  pressure: { [thin]: 'thin' }
});

describe('reading the situation', () => {
  it('reads finalized results only: live scores and later weeks never move it', async () => {
    const s = await setup({ league: { settings: raceSettings() } });
    await s.repos.schedule.putMatchups(FOUR_WEEKS);
    const ctx = await context(s);
    const settled = await readSituation(s.services, ctx);
    expect(settled).toMatchObject({
      urgency: 'contender',
      basis: 'heuristic',
      throughWeek: 4,
      remainingWeeks: 11,
      sinceWeek: 4,
      standing: { record: '4-0', rank: 1, cushion: 3 }
    });
    // A blowout in progress this week, and a week-6 final a replay must not see yet.
    await s.repos.schedule.putMatchups([
      game(5, 'team-2', 'team-3', 0, 200, 'in_progress'),
      game(6, 'team-2', 'team-4', 0, 200)
    ]);
    expect(await readSituation(s.services, ctx)).toEqual(settled);
    // The same state drives the levers: a contender is steadier than the archetype's gamble.
    ctx.situation = settled;
    expect(effectiveBehavior(ctx).riskTolerance).toBeLessThan(ctx.config.valuation.riskTolerance ?? 0.5);
  });

  it('keeps the baseline outside the season, without a race, and when reads fail', async () => {
    const s = await setup();
    const ctx = await context(s);
    expect((await readSituation(s.services, ctx))?.reasons).toEqual(['no_playoff_race']);
    expect(
      await readSituation(s.services, { ...ctx, league: { ...ctx.league, phase: 'drafting' } })
    ).toBeUndefined();
    vi.spyOn(s.repos.schedule, 'listMatchups').mockRejectedValueOnce(new Error('throttled'));
    expect(await readSituation(s.services, ctx)).toBeUndefined();
    expect(s.logs.some((l) => l.includes('agent situation unavailable'))).toBe(true);
    expect(effectiveBehavior(ctx)).toEqual(composeBehavior(ctx.config));
    // A seat whose team is gone reads no roster pressure.
    await s.repos.schedule.putMatchups(FOUR_WEEKS);
    const missing = await readSituation(s.services, {
      ...ctx,
      principal: { ...ctx.principal, teamId: 'team-9' }
    });
    expect(missing?.pressure).toEqual({});
  });
});

describe('one state for words and actions', () => {
  it('gives decision and chat prompts the same league-visible lines, and logs the adjustments', async () => {
    const s = await setup({ league: { settings: raceSettings() } });
    await s.repos.schedule.putMatchups(FOUR_WEEKS);
    await s.seat(AGENT_TEAM, config);
    const seen: (string | undefined)[] = [];
    const kind = (name: string, modelRole: 'chat' | 'decision') =>
      defineTaskKind({
        kind: name,
        title: name,
        modelRole,
        payload: BaseDecisionSchema.partial(),
        decision: BaseDecisionSchema,
        tools: [],
        prepare: async (ctx) => {
          seen.push(ctx.situation?.urgency);
          return null;
        },
        instructions: () => 'Do the task.',
        apply: async () => ({ action: 'none', summary: 'Done.' }),
        fallback: async () => ({ action: 'none', summary: 'Quiet.' })
      });
    const kinds = createTaskKindRegistry([kind('talk', 'chat'), kind('decide', 'decision')]);
    const model = new ScriptedModelClient({ script: () => ({ steps: [], decision: { summary: 'Done.' } }) });
    for (const name of ['talk', 'decide'])
      await runAgentAction(s.deps(model, { kinds }), {
        taskId: `${name}.1`,
        leagueId: LEAGUE_ID,
        teamId: AGENT_TEAM,
        agentId,
        kind: name,
        trigger: { detailType: 'Manager Check-In', eventId: name, urgent: false },
        payload: {},
        requestedAt: START
      });
    expect(seen).toEqual(['contender', 'contender']);
    const line =
      'You are 4-0, 1st, in a playoff spot 3 games clear of the first team out with 11 weeks left.';
    for (const call of model.transcript) {
      expect(call.systemPrompt).toContain('Your competitive situation (from final results):');
      expect(call.systemPrompt).toContain(line);
      expect(call.systemPrompt).not.toMatch(/aggressiveness|tolerance|FAAB bid/);
    }
    expect(s.logs.some((l) => l.includes('agent situation') && l.includes('lineup risk tolerance'))).toBe(
      true
    );
  });
});

describe('depth preservation', () => {
  it('does not cut the last healthy cover at a thin position for a pickup elsewhere', async () => {
    const s = await setup();
    const ctx = await context(s);
    const ref = (id: string, position: string) => ({ id, name: id, position, team: null });
    vi.spyOn(ctx.tools, 'call').mockImplementation(async (name) =>
      name === 'get_projections'
        ? {
            league: null,
            warnings: [],
            data: { projections: [{ player: { id: 'upgrade' }, points: 30 }] }
          }
        : {
            league: null,
            warnings: [],
            data: {
              outcome: 'claim_pending',
              issues: [{ code: 'ROSTER_FULL' }],
              currentRoster: [ref('te2', 'TE')]
            }
          }
    );
    const leads = [{ player: ref('upgrade', 'WR'), count: 3 }];
    expect((await scout(ctx, 100, leads, 1)).suggestions[0]?.drop?.id).toBe('te2');
    ctx.situation = contender('TE');
    expect((await scout(ctx, 100, leads, 1)).suggestions).toEqual([]);
  });

  it('does not offer a thin position away in a trade, but keeps the ordinary offer otherwise', async () => {
    const s = await market(HAPPY);
    const ctx = await context(s, HAPPY);
    const baseline = await scoutProposals(ctx, 1);
    expect(baseline.candidates[0]?.send.id).toBe('qb1');
    ctx.situation = contender('QB');
    await expect(scoutProposals(ctx, 1)).rejects.toThrow(TaskUnavailableError);
  });
});
