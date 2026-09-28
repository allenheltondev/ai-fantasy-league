import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Position } from '../rules/positions.js';
import { yahooDefaultSettings } from '../rules/settings.js';
import { autopick, draftRosterIssue, unfilledStarterSlots, type DraftablePlayer } from './autopick.js';
import {
  createDraft,
  currentPick,
  draftRoundsFor,
  isComplete,
  makePick,
  picksRemaining,
  teamPicks,
  type DraftState
} from './draft.js';

const settings = yahooDefaultSettings(4);

function draft(rounds = draftRoundsFor(settings)): DraftState {
  const r = createDraft({ teamIds: ['a', 'b', 'c', 'd'], rounds, pickSeconds: 60 });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

function take(d: DraftState, playerId: string, positions: Position[]): DraftState {
  const slot = currentPick(d);
  if (slot === null) throw new Error('draft over');
  const r = makePick(d, slot.teamId, playerId, { positions });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value.draft;
}

describe('picksRemaining', () => {
  it('counts the pick on the clock and every later one', () => {
    const d = draft(3);
    expect(picksRemaining(d, 'a')).toBe(3);
    const after = take(d, 'p1', ['QB']);
    expect(picksRemaining(after, 'a')).toBe(2);
    expect(picksRemaining(after, 'b')).toBe(3);
  });
});

describe('draftRosterIssue', () => {
  it('allows any pick while there are picks to spare', () => {
    expect(draftRosterIssue(draft(), 'a', ['QB'], settings)).toBeNull();
  });

  it('refuses a pick that leaves too few picks for the empty starting slots', () => {
    // 16 rounds, 10 starters: after 7 QBs, a team has 9 picks for 9 empty starting slots.
    let d = draft();
    for (let i = 0; i < 7 * 4; i++) d = take(d, `p${i}`, ['QB']);
    expect(currentPick(d)?.teamId).toBe('d');
    const issue = draftRosterIssue(d, 'd', ['QB'], settings);
    expect(issue).toMatchObject({
      code: 'ROSTER_WOULD_BE_INVALID',
      severity: 'error',
      details: { picksLeftAfter: 8 }
    });
    expect(issue?.fix).toContain('K');
    expect(issue?.fix).toContain('DEF');
    expect(draftRosterIssue(d, 'd', ['K'], settings)).toBeNull();
  });

  it('names the player position, or "player" when positions are unknown', () => {
    let d = draft();
    for (let i = 0; i < 7 * 4; i++) d = take(d, `p${i}`, ['QB']);
    expect(draftRosterIssue(d, 'd', [], settings)?.message).toContain('Taking a player');
  });
});

/** A deep player pool: enough of every position for four teams. */
function pool(): DraftablePlayer[] {
  const counts: Record<string, number> = { QB: 16, RB: 30, WR: 36, TE: 14, K: 8, DEF: 8 };
  return Object.entries(counts).flatMap(([pos, n]) =>
    Array.from({ length: n }, (_, i) => ({ playerId: `${pos}-${i}`, positions: [pos as Position] }))
  );
}

describe('draft roster properties', () => {
  it('any mix of legal manual picks and autopicks ends with every starting slot filled', () => {
    const players = pool();
    fc.assert(
      fc.property(
        fc.array(fc.nat(players.length - 1), { minLength: 64, maxLength: 64 }),
        fc.array(fc.boolean(), { minLength: 64, maxLength: 64 }),
        (choices, manual) => {
          let d = draft();
          const ranks = players.map((p) => p.playerId);
          let i = 0;
          while (!isComplete(d)) {
            const slot = currentPick(d)!;
            const taken = new Set(d.picks.map((p) => p.playerId));
            const wanted = players[choices[i] ?? 0]!;
            const legal =
              manual[i] === true &&
              !taken.has(wanted.playerId) &&
              draftRosterIssue(d, slot.teamId, wanted.positions, settings) === null;
            const choice = legal ? wanted : autopick(d, players, ranks, settings)!;
            expect(draftRosterIssue(d, slot.teamId, choice.positions, settings)).toBeNull();
            d = take(d, choice.playerId, [...choice.positions]);
            i++;
          }
          for (const team of d.teamIds) {
            const mine = teamPicks(d, team).map((p) => p.positions);
            expect(unfilledStarterSlots(settings, mine)).toEqual([]);
          }
          expect(new Set(d.picks.map((p) => p.playerId)).size).toBe(d.picks.length);
        }
      ),
      { numRuns: 60 }
    );
  });
});
