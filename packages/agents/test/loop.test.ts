import { EventLoop, silentLogger } from '@fantasy/server';
import { describe, expect, it, vi } from 'vitest';
import { startDevServer } from '../src/dev.js';
import { ScriptedModelClient } from '../src/fake-model.js';
import { agentSubscribers, inProcessAgentDeps } from '../src/loop.js';
import { draftSetup } from './draft-support.js';

describe('agents in the event loop', () => {
  it('route draft turns to agent picks through the router and runner until the draft ends', async () => {
    const model = new ScriptedModelClient();
    const s = await draftSetup({ teamCount: 4, start: '2026-09-30T12:00:00.000Z' });
    // Every seat but Allen's is an agent; Allen picks for the first empty starting slot.
    const deps = inProcessAgentDeps(s.services, model, { modelTimeoutMs: 5000 });
    expect(deps.runner.killSwitch).toBeDefined();
    const loop = new EventLoop({
      publisher: s.events,
      clock: s.clock,
      subscribers: [
        ...agentSubscribers(deps),
        {
          name: 'allen',
          detailTypes: ['Draft Turn Started'],
          handle: async (e) => {
            const d = e.detail as { teamId: string; pick: number };
            if (d.teamId !== 'team-1') return;
            const board = await s.run('get_draft_board', { leagueId: s.leagueId, limit: 40 });
            if ('error' in board) throw new Error(board.error.message);
            const draft = board.data as {
              yourNeeds: string[];
              bestAvailable: { player: { id: string; position: string } }[];
            };
            const need = new Set(draft.yourNeeds.flatMap((n) => (n === 'W/R/T' ? ['RB', 'WR', 'TE'] : [n])));
            const pick =
              draft.bestAvailable.find((c) => need.has(c.player.position)) ?? draft.bestAvailable[0];
            await s.run('make_draft_pick', { leagueId: s.leagueId, playerId: pick?.player.id, pick: d.pick });
          }
        }
      ],
      log: silentLogger
    });
    await loop.drain();
    expect(loop.stats.failures).toEqual([]);
    expect((await s.repos.drafts.get(s.leagueId))?.status).toBe('complete');
    expect(loop.stats.delivered['Agent Action Requested']).toBe(3 * 16);
    expect(model.transcript.length).toBe(3 * 16);
  });

  it('dev server runs the loop with agents on the fake model', async () => {
    const local = await startDevServer({ port: 0, env: {}, log: silentLogger });
    try {
      expect(local.loop).not.toBeNull();
      await vi.waitFor(() => expect(local.loop?.stats.jobRuns).toBeDefined());
    } finally {
      await local.close();
    }
  });
});
