import { createDraft, makePick, yahooDefaultSettings, type DraftState } from '@fantasy/core';
import { describe, expect, it } from 'vitest';
import type { Ctx } from '../../context.js';
import { buildDepth, picksBeforeTurn } from './get-draft-depth.js';

const settings = yahooDefaultSettings(3);

function draft(): DraftState {
  const created = createDraft({ teamIds: ['a', 'b', 'c'], rounds: 2, pickSeconds: 60 });
  if (!created.ok) throw new Error('bad draft');
  const picked = makePick(created.value, 'a', 'gone', { positions: ['TE'] });
  if (!picked.ok) throw new Error('bad pick');
  return picked.value.draft;
}

const ctx = { data: { players: { all: async () => [] } } } as unknown as Pick<Ctx, 'data'>;

describe('picksBeforeTurn', () => {
  it('counts each team’s picks before yours, and nothing without a team or once the draft is over', () => {
    const state = draft();
    // Pick 2 (b) is on the clock; a picks again at 6, so b, c, c, b pick first.
    expect([...picksBeforeTurn(state, 'a')]).toEqual([
      ['b', 2],
      ['c', 2]
    ]);
    expect(picksBeforeTurn(state, null).size).toBe(0);
    expect(picksBeforeTurn({ ...state, picks: [], rounds: 0 }, 'a').size).toBe(0);
  });
});

describe('buildDepth', () => {
  it('shows a drafted player who left the index by id, and teams by name or id', async () => {
    const depth = await buildDepth(ctx, { state: draft(), teams: [], settings, yourTeamId: null });
    expect(depth.teams.map((t) => [t.teamId, t.teamName, t.yours])).toEqual([
      ['a', 'a', false],
      ['b', 'b', false],
      ['c', 'c', false]
    ]);
    const te = depth.teams[0]?.positions.find((p) => p.position === 'TE');
    expect(te?.players).toEqual([{ id: 'gone', name: 'gone', team: null, position: 'TE' }]);
    expect(depth.teams[0]?.slots.find((s) => s.slot === 'TE')).toEqual({
      slot: 'TE',
      required: 1,
      filled: 1
    });
  });
});
