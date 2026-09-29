import { emptyAgenda, resolveAgentConfig, yahooDefaultSettings, type RosterSlot } from '@fantasy/core';
import { agentPrincipal, seatTenureStart } from '@fantasy/server';
import { describe, expect, it, vi } from 'vitest';
import { agendaHoles, refreshAgenda } from '../src/agenda.js';
import { ScriptedModelClient } from '../src/fake-model.js';
import { runAgentAction } from '../src/runner.js';
import { checkInTask } from '../src/tasks/check-in.js';
import {
  BaseDecisionSchema,
  createTaskKindRegistry,
  defineTaskKind,
  type TaskContext
} from '../src/tasks/kinds.js';
import { lineupTask } from '../src/tasks/lineup.js';
import { tradeProposalTask } from '../src/tasks/trade-proposal.js';
import { tradeResponseTask } from '../src/tasks/trades.js';
import { ToolBox } from '../src/tools.js';
import { scout, waiverTask } from '../src/tasks/waivers.js';
import { AGENT_TEAM, LEAGUE_ID, START, setup, type Setup } from './support.js';

const agentId = `${LEAGUE_ID}.${AGENT_TEAM}`;
const config = { personalityId: 'stats-nerd', difficulty: 'pro', archetype: 'balanced' } as const;
async function context(s: Setup): Promise<TaskContext> {
  await s.seat(AGENT_TEAM, config);
  const seat = (await s.repos.agents.getSeat(LEAGUE_ID, AGENT_TEAM))!;
  const principal = agentPrincipal({ agentId, teamId: AGENT_TEAM, leagueId: LEAGUE_ID });
  return {
    taskId: 'agenda-test',
    principal,
    seat,
    config: resolveAgentConfig(config),
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
      idempotencyPrefix: 'agenda-test'
    })
  };
}
const request = (id: string, kind = 'check_in') => ({
  taskId: `${kind}.${id}`,
  leagueId: LEAGUE_ID,
  teamId: AGENT_TEAM,
  agentId,
  kind,
  trigger: { detailType: 'Manager Check-In', eventId: id, urgent: false },
  payload: { slot: 'morning' },
  requestedAt: START
});
async function hurtRunningBacks(s: Setup, injury: string | null) {
  const players = await Promise.all(['rb1', 'rb2', 'rb3', 'rb4'].map((id) => s.repos.players.get(id)));
  await s.repos.players.putMany(players.map((p) => ({ ...p!, injuryStatus: injury })));
}
const stored = async (s: Setup) =>
  s.repos.agents.getAgenda(
    LEAGUE_ID,
    agentId,
    seatTenureStart((await s.repos.teams.get(LEAGUE_ID, AGENT_TEAM))!)
  );

describe('agenda availability', () => {
  it('marks every chat-visible roster task as refresh-only', async () => {
    const s = await setup();
    const ctx = await context(s);
    expect(checkInTask.agendaMode(ctx, { slot: 'morning' })).toBe('guide_only');
    expect(lineupTask.agendaMode(ctx, { reason: 'chat' })).toBe('refresh_only');
    expect(waiverTask.agendaMode(ctx, { reason: 'chat' })).toBe('refresh_only');
    expect(tradeProposalTask.agendaMode(ctx, { reason: 'chat' })).toBe('refresh_only');
    expect(
      tradeResponseTask.agendaMode(ctx, {
        tradeId: 't1',
        fromTeamId: 'team-1',
        chat: { roomId: 'league', messageId: 'm1', fromTeamId: 'team-1' }
      })
    ).toBe('refresh_only');
    expect(tradeResponseTask.agendaMode(ctx, { tradeId: 't1' })).toBe('refresh_only');
    expect(tradeProposalTask.agendaMode(ctx, { reason: 'week' })).toBe('guide_only');
    expect(lineupTask.agendaMode(ctx, { reason: 'lock' })).toBe('private');
    expect(waiverTask.agendaMode(ctx, { reason: 'window' })).toBe('private');
  });

  it('prioritizes a durable need before allocating scarce drops without bypassing the gain floor', async () => {
    const s = await setup();
    const ctx = await context(s);
    await hurtRunningBacks(s, 'Out');
    ctx.agenda = await refreshAgenda(s.services, ctx);
    const ref = (id: string, position: string) => ({ id, name: id, position, team: null });
    const leads = [
      { player: ref('luxury', 'WR'), count: 10 },
      { player: ref('repair', 'RB'), count: 1 }
    ];
    vi.spyOn(ctx.tools, 'call').mockImplementation(async (name) =>
      name === 'get_projections'
        ? {
            league: null,
            warnings: [],
            data: {
              projections: [
                { player: { id: 'luxury' }, points: 30 },
                { player: { id: 'repair' }, points: 10 }
              ]
            }
          }
        : {
            league: null,
            warnings: [],
            data: {
              outcome: 'claim_pending',
              issues: [{ code: 'ROSTER_FULL' }],
              currentRoster: [ref('spare', 'TE')]
            }
          }
    );
    const prioritized = await scout(ctx, 100, leads, 1);
    expect(prioritized.suggestions.map((s) => s.player.id)).toEqual(['repair']);
    expect(prioritized.suggestions[0]?.drop?.id).toBe('spare');
    expect((await scout(ctx, 100, leads, 15)).suggestions.map((s) => s.player.id)).toEqual(['luxury']);
    delete ctx.agenda;
    expect((await scout(ctx, 100, leads, 1)).suggestions.map((s) => s.player.id)).toEqual(['luxury']);
  });

  it('counts healthy cover, byes and IR, and honors the actual slots of locked players', () => {
    const settings = yahooDefaultSettings(4);
    settings.roster.slots = { RB: 1, 'W/R/T': 1, BN: 2, IR: 1 };
    const player = (id: string, slot: RosterSlot, state: 'upcoming' | 'live' | 'final' | 'bye') => ({
      player: { id, position: 'RB' as const },
      status: 'active' as const,
      slot,
      kickoff: null,
      game: { state }
    });
    expect(
      agendaHoles(
        settings,
        { week: 5, players: [player('a', 'RB', 'upcoming'), player('b', 'BN', 'upcoming')] },
        START
      )
    ).toEqual([]);
    expect(
      agendaHoles(
        settings,
        { week: 5, players: [player('a', 'RB', 'bye'), player('b', 'IR', 'upcoming')] },
        START
      )
    ).toEqual(['RB', 'W/R/T']);
    // The locked flex cannot be reassigned to RB, and the locked bench cannot start.
    expect(
      agendaHoles(
        settings,
        { week: 5, players: [player('a', 'W/R/T', 'live'), player('b', 'BN', 'final')] },
        START
      )
    ).toEqual(['RB']);
    expect(
      agendaHoles(
        settings,
        { week: 5, players: [{ ...player('a', 'W/R/T', 'upcoming'), kickoff: START }] },
        START
      )
    ).toEqual(['RB']);
    const { game: _game, ...withoutGame } = player('a', 'RB', 'upcoming');
    expect(agendaHoles(settings, { week: 5, players: [withoutGame] }, START)).toEqual(['W/R/T']);
  });

  it('persists a goal across check-ins, closes on verified recovery, and isolates a new occupant', async () => {
    const s = await setup();
    await context(s);
    await hurtRunningBacks(s, 'Out');
    const model = new ScriptedModelClient({
      script: () => ({ steps: [], decision: { summary: 'Holding steady.', actions: [] } })
    });
    await runAgentAction(s.deps(model), request('first'));
    const first = await stored(s);
    expect(first.goals[0]).toMatchObject({ slot: 'RB', missing: 2, status: 'active' });
    expect(model.transcript[0]?.systemPrompt).not.toContain('repair_position');
    await runAgentAction(s.deps(model), request('private-lineup', 'lineup'));
    expect(model.transcript.at(-1)?.systemPrompt).toContain('[repair_position:W5:RB]');
    s.clock.advance(60_000);
    await runAgentAction(s.deps(model), request('second'));
    expect((await stored(s)).goals).toEqual(first.goals);
    await hurtRunningBacks(s, null);
    s.clock.advance(60_000);
    await runAgentAction(s.deps(model), request('recovered'));
    expect((await stored(s)).goals[0]?.status).toBe('completed');
    expect(model.transcript.at(-1)?.systemPrompt).not.toContain('[repair_position:W5:RB]');
    const team = (await s.repos.teams.get(LEAGUE_ID, AGENT_TEAM))!;
    await s.repos.teams.update({ ...team, occupiedSince: s.clock.now().toISOString() });
    expect(await stored(s)).toEqual(emptyAgenda());
  });

  it('does not trust a model claim that a roster need was solved', async () => {
    const s = await setup();
    await context(s);
    await hurtRunningBacks(s, 'Out');
    const model = new ScriptedModelClient({
      script: () => ({ steps: [], decision: { summary: 'I solved my RB problem.', actions: [] } })
    });
    await runAgentAction(s.deps(model), request('claim'));
    expect((await stored(s)).goals[0]?.status).toBe('active');
  });

  it('closes a repair goal after a real check-in pickup and also works without a model', async () => {
    for (const fallback of [false, true]) {
      const s = await setup();
      await context(s);
      const team = (await s.repos.teams.get(LEAGUE_ID, AGENT_TEAM))!;
      await s.repos.teams.update({ ...team, roster: team.roster.filter((id) => id !== 'k1') });
      const lineup = (await s.repos.lineups.get(LEAGUE_ID, AGENT_TEAM, 5))!;
      await s.repos.lineups.put([{ ...lineup, entries: lineup.entries.filter((e) => e.playerId !== 'k1') }]);
      const model = new ScriptedModelClient();
      const result = await runAgentAction(
        s.deps(model, fallback ? { killSwitch: { engaged: async () => true } } : {}),
        request(fallback ? 'fallback-repair' : 'repair')
      );
      expect(result.status).toBe(fallback ? 'fallback' : 'completed');
      expect((await s.repos.teams.get(LEAGUE_ID, AGENT_TEAM))?.roster).toContain('k1');
      expect((await stored(s)).goals.find((g) => g.slot === 'K')?.status).toBe('completed');
      expect(model.transcript).toHaveLength(fallback ? 0 : 1);
    }
  });

  it('keeps private goals out of chat and externally-writing decision prompts', async () => {
    const s = await setup();
    const ctx = await context(s);
    await hurtRunningBacks(s, 'Out');
    await refreshAgenda(s.services, ctx);
    const chat = defineTaskKind({
      kind: 'chat_reply',
      title: 'Chat',
      modelRole: 'chat',
      payload: BaseDecisionSchema.partial(),
      decision: BaseDecisionSchema,
      tools: [],
      prepare: async (ctx) => {
        expect(ctx.agenda).toBeUndefined();
        return null;
      },
      instructions: () => 'Say hello.',
      apply: async () => ({ action: 'none', summary: 'Hello.' }),
      fallback: async () => ({ action: 'none', summary: 'Quiet.' })
    });
    const guidedTrade = defineTaskKind({
      kind: 'guided_trade',
      title: 'Guided trade',
      modelRole: 'decision',
      agenda: 'guide_only',
      payload: BaseDecisionSchema.partial(),
      decision: BaseDecisionSchema,
      tools: [],
      prepare: async (ctx) => {
        expect(ctx.agenda?.goals[0]?.slot).toBe('RB');
        return null;
      },
      instructions: () => 'Choose from already-ranked candidates and write a note.',
      apply: async () => ({ action: 'none', summary: 'No offer.' }),
      fallback: async () => ({ action: 'none', summary: 'Quiet.' })
    });
    const model = new ScriptedModelClient({ script: () => ({ steps: [], decision: { summary: 'Hello.' } }) });
    const kinds = createTaskKindRegistry([chat, guidedTrade]);
    await runAgentAction(s.deps(model, { kinds }), request('chat', 'chat_reply'));
    expect(model.transcript[0]?.systemPrompt).not.toContain('repair_position');
    expect(model.transcript[0]?.systemPrompt).not.toContain('private roster priorities');
    await runAgentAction(s.deps(model, { kinds }), request('guided', 'guided_trade'));
    expect(model.transcript[1]?.systemPrompt).not.toContain('repair_position');
    expect(model.transcript[1]?.systemPrompt).not.toContain('private roster priorities');
  });

  it('preserves saved goals but withholds stale context when roster reads fail', async () => {
    const s = await setup();
    const ctx = await context(s);
    await hurtRunningBacks(s, 'Out');
    const first = await refreshAgenda(s.services, ctx);
    vi.spyOn(ctx.tools, 'call').mockResolvedValue({
      error: { code: 'FORBIDDEN', message: 'unavailable', fix: 'retry' }
    });
    expect(await refreshAgenda(s.services, ctx)).toBeUndefined();
    expect(await stored(s)).toEqual(first);
  });

  it('ignores unavailable leagues, non-agent seats, setup, wrong weeks and racing roster changes', async () => {
    const s = await setup();
    const ctx = await context(s);
    const league = (await s.repos.leagues.get(LEAGUE_ID))!;
    const team = (await s.repos.teams.get(LEAGUE_ID, AGENT_TEAM))!;
    const leagueGet = vi.spyOn(s.repos.leagues, 'get');
    leagueGet.mockResolvedValueOnce(null);
    expect(await refreshAgenda(s.services, ctx)).toBeUndefined();
    leagueGet.mockResolvedValueOnce({ ...league, phase: 'setup' });
    expect(await refreshAgenda(s.services, ctx)).toBeUndefined();
    const teamGet = vi.spyOn(s.repos.teams, 'get');
    teamGet.mockResolvedValueOnce(null);
    expect(await refreshAgenda(s.services, ctx)).toBeUndefined();
    teamGet.mockResolvedValueOnce({ ...team, seatType: 'human' });
    expect(await refreshAgenda(s.services, ctx)).toBeUndefined();
    leagueGet.mockResolvedValueOnce({ ...league, week: 6 });
    expect(await refreshAgenda(s.services, ctx)).toBeUndefined();
    teamGet.mockResolvedValueOnce(team).mockResolvedValueOnce({ ...team, version: team.version + 1 });
    expect(await refreshAgenda(s.services, ctx)).toBeUndefined();
    teamGet.mockResolvedValueOnce(team).mockResolvedValueOnce({ ...team, seatType: 'human' });
    expect(await refreshAgenda(s.services, ctx)).toBeUndefined();
    teamGet
      .mockResolvedValueOnce(team)
      .mockResolvedValueOnce({ ...team, occupiedSince: '2026-10-05T12:00:00.000Z' });
    expect(await refreshAgenda(s.services, ctx)).toBeUndefined();
  });

  it('cancels on league completion and degrades gracefully on storage/schema errors', async () => {
    const s = await setup();
    const ctx = await context(s);
    await hurtRunningBacks(s, 'Out');
    await refreshAgenda(s.services, ctx);
    const league = (await s.repos.leagues.get(LEAGUE_ID))!;
    await s.repos.leagues.update({ ...league, phase: 'complete' });
    expect((await refreshAgenda(s.services, ctx))?.goals[0]?.status).toBe('cancelled');
    vi.spyOn(s.repos.agents, 'updateAgenda').mockRejectedValueOnce(new Error('offline'));
    expect(await refreshAgenda(s.services, ctx)).toBeUndefined();
    expect(s.logs.join(' ')).toContain('agent agenda unavailable');
  });
});
