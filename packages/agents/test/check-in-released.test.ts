import { describe, expect, it } from 'vitest';
import { ACTION_STEPS, type CheckInPrep, type Run } from '../src/tasks/check-in.js';
import type { TaskContext } from '../src/tasks/kinds.js';

/**
 * A check-in that drops a player for a pickup never then offers him in a trade (#248: the league
 * refused such offers as PLAYER_NOT_ON_ROSTER over a full season).
 */

const offers = ACTION_STEPS.find((s) => s.types.includes('propose_trade'))!;
const run = (released: string[]): Run => ({
  actionsLeft: 3,
  done: [],
  lineupNeeded: false,
  added: false,
  waiverClaims: [],
  released,
  trades: [],
  memory: []
});
const prep = {
  look: {
    trade: {
      prep: {
        limit: 1,
        bar: 1,
        candidates: [
          {
            team: { id: 'team-3', name: 'Three' },
            send: { id: 'kupp', name: 'Cooper Kupp', position: 'WR' },
            receive: { id: 'rb9', name: 'RB Nine', position: 'RB' },
            score: 2,
            partnerScore: 1
          }
        ]
      }
    }
  }
} as unknown as CheckInPrep;

describe('trade ideas after this check-in’s own roster moves', () => {
  it('drops an idea that sends a player the check-in just let go, and proposes nothing', async () => {
    const calls: string[] = [];
    const ctx = {
      tools: { call: async (name: string) => (calls.push(name), { error: { code: 'X' } }) }
    } as unknown as TaskContext;
    const r = run(['kupp']);
    await offers.run(ctx, prep, [{ type: 'propose_trade', candidate: 1 }], r);
    expect(r.done).toEqual([
      { action: 'trade_skipped', line: 'Dropped a trade idea: it sent a player I just let go.' }
    ]);
    expect(calls).toEqual([]);
    expect(r.actionsLeft).toBe(3);
  });
});
