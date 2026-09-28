import { resolveAgentConfig } from '@fantasy/core';
import { agentIdFor, fixtureDraftPool } from '@fantasy/server';
import { describe, expect, it } from 'vitest';
import { ScriptedModelClient } from '../src/fake-model.js';
import { runAgentAction } from '../src/runner.js';
import { agentRank } from '../src/tasks/draft.js';
import { draftSetup, type DraftSetup } from './draft-support.js';

/** team-2 is an agent and picks first; Allen (team-1) picks second. */
const ORDER = ['team-2', 'team-1', 'team-3', 'team-4'];
const ZERO_RB = { personalityId: 'stats-nerd', difficulty: 'pro', archetype: 'zero_rb' } as const;

async function withAgent(config: typeof ZERO_RB = ZERO_RB, options: Parameters<typeof draftSetup>[0] = {}) {
  return draftSetup({
    order: ORDER,
    ...options,
    beforeStart: async (s) => {
      const res = await s.run('configure_agent_seat', { leagueId: s.leagueId, teamId: 'team-2', ...config });
      if ('error' in res) throw new Error(JSON.stringify(res.error));
    }
  });
}

async function picks(s: DraftSetup) {
  return (await s.repos.drafts.get(s.leagueId))?.state.picks ?? [];
}

describe('draft_pick task', () => {
  it('reads the board, lets the model choose, and makes the pick pinned to its pick number', async () => {
    const s = await withAgent();
    const model = new ScriptedModelClient({
      script: () => ({
        steps: [{ tool: 'get_draft_board', args: { position: 'WR', limit: 3 } }],
        decision: { summary: 'Elite WR, as planned.', playerId: 'fx-jjefferson' }
      })
    });
    const record = await runAgentAction(s.deps(model), s.turnRequest());
    expect(record).toMatchObject({
      status: 'completed',
      finalAction: 'make_draft_pick',
      reasoningSummary: 'Elite WR, as planned.'
    });
    // The model's reasoning goes with the pick: the recap and the notable-pick chat line show it.
    expect(await picks(s)).toEqual([
      expect.objectContaining({
        overall: 1,
        teamId: 'team-2',
        playerId: 'fx-jjefferson',
        auto: false,
        reason: 'Elite WR, as planned.'
      })
    ]);
    const made = s.events.events.filter((e) => e.detailType === 'Draft Pick Made').at(-1);
    expect(made?.detail).toMatchObject({ notable: 'first_round', reason: 'Elite WR, as planned.' });
    const prompt = model.transcript[0]?.systemPrompt ?? '';
    expect(prompt).toContain('Strategy: Zero RB');
    expect(prompt).toContain('You are on the clock: round 1, pick 1');
    expect(prompt).toContain('Empty starting slots: QB, WR, WR, WR, RB, RB, TE, K, DEF, W/R/T');
    expect(model.transcript[0]?.toolNames).not.toContain('make_draft_pick');
    const calls = record.toolsCalled.map((c) => c.name);
    expect(calls.filter((n) => n === 'get_draft_board').length).toBeGreaterThanOrEqual(3);
    expect(calls.at(-1)).toBe('make_draft_pick');
  });

  it('shows last season PPG and the season projection in the candidate lines', async () => {
    const s = await withAgent();
    const reference = s.services.data.reference;
    const state = {
      season: 2026,
      seasonType: 'pre' as const,
      week: 1,
      displayWeek: 1,
      leagueSeason: 2026,
      previousSeason: 2025,
      seasonStartDate: null,
      updatedAt: 'x'
    };
    await reference.nflState.put(state, null);
    const lines = (season: number, weeks: Record<string, number>[]) => ({
      playerId: 'fx-jjefferson',
      season,
      weeks: weeks.map((stats, i) => ({ week: i + 1, stats }))
    });
    const meta = { updatedAt: 'x', players: 1, weeks: [1, 2], hash: 'h' };
    await reference.seasons.put({ ...meta, kind: 'stats', season: 2025 }, [
      lines(2025, [
        { gp: 1, rec: 6, rec_yd: 100 },
        { gp: 1, rec: 4, rec_yd: 50 }
      ])
    ]);
    await reference.seasons.put({ ...meta, kind: 'projections', season: 2026 }, [
      lines(2026, [{ rec: 5, rec_yd: 80 }])
    ]);
    const model = new ScriptedModelClient({
      script: () => ({ steps: [], decision: { summary: 'WR1.', playerId: 'fx-jjefferson' } })
    });
    await runAgentAction(s.deps(model), s.turnRequest());
    const prompt = model.transcript[0]?.systemPrompt ?? '';
    // Half PPR: (3 + 10) + (2 + 5) = 20 over 2 games; projection 2.5 + 8 = 10.5.
    expect(prompt).toMatch(
      /Justin Jefferson \(fx-jjefferson, WR, MIN, rank \d+, 10 PPG last season \(2 games\), projected 10.5 pts\)/
    );
  });

  it('shapes the recommendation by archetype: zero RB passes on the top back', async () => {
    const s = await withAgent();
    const record = await runAgentAction(s.deps(new ScriptedModelClient()), s.turnRequest());
    expect(record.status).toBe('completed');
    const first = (await picks(s))[0];
    expect(fixtureDraftPool.find((p) => p.id === first?.playerId)?.position).toBe('WR');
    const config = resolveAgentConfig(ZERO_RB);
    const seat = { agentId: agentIdFor(s.leagueId, 'team-2') };
    const rb = { player: { id: 'r', name: 'R', team: null, position: 'RB' as const }, rank: 10 };
    const wr = { player: { id: 'w', name: 'W', team: null, position: 'WR' as const }, rank: 10 };
    const ctx = { config, seat } as Parameters<typeof agentRank>[0];
    expect(agentRank(ctx, rb)).toBeGreaterThan(agentRank(ctx, wr));
    expect(agentRank(ctx, { ...wr, rank: null })).toBeGreaterThan(agentRank(ctx, wr));
  });

  it('autopicks when the model names a player who is gone', async () => {
    const s = await withAgent();
    const model = new ScriptedModelClient({
      script: () => ({ steps: [], decision: { summary: 'CMC!', playerId: 'not-a-player' } })
    });
    const record = await runAgentAction(s.deps(model), s.turnRequest());
    expect(record).toMatchObject({ status: 'completed', finalAction: 'make_draft_pick' });
    expect(record.reasoningSummary).toMatch(/^Wanted not-a-player but PLAYER_NOT_FOUND\. Autopick: /);
    expect(await picks(s)).toHaveLength(1);
  });

  it('falls back to core autopick when the model fails or the kill switch is on', async () => {
    const s = await withAgent();
    const failing = new ScriptedModelClient({ fail: () => new Error('bedrock is down') });
    const record = await runAgentAction(s.deps(failing), s.turnRequest());
    expect(record).toMatchObject({
      status: 'fallback',
      fallbackReason: 'model_error',
      finalAction: 'make_draft_pick'
    });
    expect(record.reasoningSummary).toContain('No model decision. Autopick:');
    expect((await picks(s))[0]).toMatchObject({ teamId: 'team-2', auto: false });

    const t = await withAgent();
    const off = await runAgentAction(
      t.deps(new ScriptedModelClient(), { killSwitch: { engaged: async () => true } }),
      t.turnRequest()
    );
    expect(off).toMatchObject({
      status: 'fallback',
      fallbackReason: 'kill_switch',
      finalAction: 'make_draft_pick'
    });
  });

  it('skips a turn that already passed (the clock autopicked first)', async () => {
    const s = await withAgent();
    const request = s.turnRequest();
    await runAgentAction(s.deps(new ScriptedModelClient()), { ...request, taskId: 'first-run' });
    const record = await runAgentAction(s.deps(new ScriptedModelClient()), {
      ...request,
      taskId: 'late-run'
    });
    expect(record).toMatchObject({ status: 'skipped' });
    expect(record.fallbackReason).toContain('not on the clock');
    expect(await picks(s)).toHaveLength(1);
  });

  it('skips when the league has no draft yet', async () => {
    const s = await withAgent();
    const created = await s.run('create_league', { name: 'Not Drafting', teamCount: 4 });
    const leagueId = (created as { data: { id: string } }).data.id;
    await s.run('configure_agent_seat', { leagueId, teamId: 'team-2', ...ZERO_RB });
    const record = await runAgentAction(s.deps(new ScriptedModelClient()), {
      ...s.turnRequest(),
      leagueId,
      agentId: agentIdFor(leagueId, 'team-2')
    });
    expect(record).toMatchObject({ status: 'skipped' });
    expect(record.fallbackReason).toContain('DRAFT_NOT_STARTED');
  });

  it('reports a pick it could not make, and does nothing when no player is left', async () => {
    const paused = await withAgent();
    await paused.run('pause_draft', { leagueId: paused.leagueId });
    const refused = await runAgentAction(
      paused.deps(new ScriptedModelClient({ fail: () => new Error('down') })),
      paused.turnRequest()
    );
    expect(refused).toMatchObject({ status: 'fallback', finalAction: 'draft_pick_failed' });
    expect(refused.reasoningSummary).toContain('paused');

    const empty = await withAgent(ZERO_RB, { players: [] });
    const none = await runAgentAction(empty.deps(new ScriptedModelClient()), empty.turnRequest());
    expect(none).toMatchObject({ status: 'completed', finalAction: 'none' });
    expect(none.reasoningSummary).toContain('No draftable player found');
  });
});
