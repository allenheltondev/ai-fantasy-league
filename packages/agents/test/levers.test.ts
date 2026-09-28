import {
  DIFFICULTIES,
  DIFFICULTY_TIERS,
  RESEARCH_KINDS,
  getModel,
  resolveAgentConfig,
  type Difficulty
} from '@fantasy/core';
import { describe, expect, it } from 'vitest';
import type { AgentActionRequested } from '../src/events.js';
import { ScriptedModelClient } from '../src/fake-model.js';
import { routeEvent } from '../src/router.js';
import { runAgentAction } from '../src/runner.js';
import { defaultTaskKinds } from '../src/tasks/index.js';
import { RESEARCH_TOOLS, agentEligible } from '../src/tools.js';
import { AGENT_TEAM, LEAGUE_ID, START, setup } from './support.js';

/**
 * Difficulty levers (issue #74), checked where the runtime applies them: the model request (model,
 * research tools, tool-loop steps, token budget), the tool binding (actions per trigger), the
 * router (cooldowns), and the prompt (negotiation rounds).
 */

const AGENT_ID = `${LEAGUE_ID}.${AGENT_TEAM}`;
const seat = (difficulty: Difficulty) =>
  ({ personalityId: 'stats-nerd', difficulty, archetype: 'balanced' }) as const;
const MAX_TOKENS = { low: 1024, medium: 2048, high: 4096 } as const;
const LINEUP_TOOLS = defaultTaskKinds.get('lineup')?.tools ?? [];

function lineupRequest(taskId = 'lineup.levers'): AgentActionRequested {
  return {
    taskId,
    leagueId: LEAGUE_ID,
    teamId: AGENT_TEAM,
    agentId: AGENT_ID,
    kind: 'lineup',
    trigger: { detailType: 'Lineup Lock Approaching', eventId: 'evt-levers', urgent: true },
    payload: { reason: 'lock', week: 5 },
    requestedAt: START
  };
}

describe('difficulty levers reach the model run', () => {
  for (const difficulty of DIFFICULTIES) {
    it(`${difficulty}: model, research tools, reasoning depth, and prompt budgets`, async () => {
      const s = await setup();
      await s.seat(AGENT_TEAM, seat(difficulty));
      const levers = DIFFICULTY_TIERS[difficulty].levers;
      const model = new ScriptedModelClient();
      await runAgentAction(s.deps(model), lineupRequest());
      const run = model.transcript[0];
      const config = resolveAgentConfig(seat(difficulty));
      expect(run?.modelId).toBe(getModel(config.models.decision[0]!).bedrockId);
      expect(run?.maxIterations).toBe(levers.maxToolSteps);
      expect(run?.maxTokens).toBe(MAX_TOKENS[levers.reasoningEffort]);
      // Information access: a research tool is bound exactly when the tier allows it.
      for (const [tool, kind] of Object.entries(RESEARCH_TOOLS)) {
        // get_matchup_outlook is not built yet; its lever is ready for when it is.
        if (!LINEUP_TOOLS.includes(tool) || s.registry.get(tool) === undefined) continue;
        expect(run?.toolNames.includes(tool), `${difficulty} ${tool}`).toBe(levers.research[kind]);
      }
      expect(run?.systemPrompt).toContain(`at most ${levers.actionsPerTrigger} action(s) per task`);
      expect(run?.systemPrompt).toContain(`at most ${levers.negotiationRounds} counter-offer(s) per trade`);
    });
  }

  it('applies Advanced lever overrides', async () => {
    const s = await setup();
    await s.seat(AGENT_TEAM, {
      ...seat('hall_of_famer'),
      advanced: {
        modelOverride: 'nova-lite',
        levers: { maxToolSteps: 2, reasoningEffort: 'low', research: { news: false }, negotiationRounds: 0 }
      }
    });
    const model = new ScriptedModelClient();
    await runAgentAction(s.deps(model), lineupRequest());
    const run = model.transcript[0];
    expect(run?.modelId).toBe(getModel('nova-lite').bedrockId);
    expect(run?.maxIterations).toBe(2);
    expect(run?.maxTokens).toBe(MAX_TOKENS.low);
    expect(run?.toolNames).not.toContain('get_news');
    expect(run?.toolNames).toContain('get_projections');
    expect(run?.systemPrompt).toContain('at most 0 counter-offer(s)');
  });

  it('stops mutations at the action budget', async () => {
    const s = await setup();
    await s.seat(AGENT_TEAM, { ...seat('pro'), advanced: { levers: { actionsPerTrigger: 1 } } });
    const set = {
      tool: 'set_lineup',
      args: { teamId: AGENT_TEAM, week: 5, moves: [{ playerId: 'qb1', slot: 'QB' }] }
    };
    const model = new ScriptedModelClient({
      script: () => ({ steps: [set, set], decision: { summary: 'Twice.', confirm: true } })
    });
    const kinds = {
      get: (k: string) => {
        const kind = defaultTaskKinds.get(k);
        return kind === undefined ? undefined : { ...kind, tools: [...(kind.tools ?? []), 'set_lineup'] };
      },
      kinds: defaultTaskKinds.kinds
    };
    await runAgentAction(s.deps(model, { kinds }), lineupRequest());
    expect(model.transcript[0]?.results[1]).toMatchObject({
      error: { code: 'FORBIDDEN', details: { actionsPerTrigger: 1 } }
    });
  });

  it('gives a slower agent a longer cooldown between non-urgent triggers', async () => {
    const s = await setup();
    await s.seat(AGENT_TEAM, seat('rookie'));
    await s.seat('team-3', seat('hall_of_famer'));
    const deps = { services: s.services, kinds: defaultTaskKinds };
    const windowEvent = (id: string) => ({
      id,
      'detail-type': 'Waiver Window Opened',
      source: 'fantasy',
      detail: { leagueId: LEAGUE_ID, week: 5 }
    });
    await routeEvent(deps, windowEvent('w1'));
    s.clock.advance(DIFFICULTY_TIERS.hall_of_famer.levers.cooldownMinutes * 60_000);
    const second = await routeEvent(deps, windowEvent('w2'));
    expect(Object.fromEntries(second.map((d) => [d.teamId, d.decision]))).toEqual({
      'team-2': 'cooldown',
      'team-3': 'requested'
    });
  });

  it('only restricts: every lever-gated tool is one a league member can call too', () => {
    // No operation is agent-only, and every research kind maps to a member-readable operation.
    const s = setup();
    return s.then(({ registry }) => {
      for (const op of registry.operations.filter(agentEligible)) expect(op.auth).not.toBe('agent');
      for (const kind of RESEARCH_KINDS) {
        const names = Object.entries(RESEARCH_TOOLS)
          .filter(([, k]) => k === kind)
          .map(([n]) => n);
        for (const name of names) {
          const op = registry.get(name);
          if (op !== undefined) expect(op.auth === 'authenticated' || op.auth === 'public', name).toBe(true);
        }
      }
    });
  });
});
