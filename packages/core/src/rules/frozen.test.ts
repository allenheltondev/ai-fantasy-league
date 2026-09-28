import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { frozenLineup } from './frozen.js';
import type { LineupEntry, WeekGames } from './lineup.js';
import { isStarterSlot, type RosterSlot } from './positions.js';
import { slotCount, yahooDefaultSettings } from './settings.js';

const settings = yahooDefaultSettings();
const THU = '2026-09-11T00:20:00.000Z';
const SUN = '2026-09-13T17:00:00.000Z';
const games: WeekGames = { KC: { kickoff: THU }, BAL: { kickoff: THU }, BUF: { kickoff: SUN } };
const FRIDAY = '2026-09-11T12:00:00.000Z';
const teams: Record<string, string | null> = {
  qbKC: 'KC',
  qbBUF: 'BUF',
  wrKC: 'KC',
  wrBUF: 'BUF',
  wrBAL: 'BAL'
};
const teamOf = (id: string) => teams[id];

describe('frozenLineup', () => {
  it('keeps a locked starter who left the roster in his slot and benches the pickup who took it', () => {
    const saved: LineupEntry[] = [
      { playerId: 'qbKC', slot: 'QB' },
      { playerId: 'qbBUF', slot: 'BN' }
    ];
    // qbKC was dropped after his Thursday game; qbBUF was moved into QB.
    const current: LineupEntry[] = [{ playerId: 'qbBUF', slot: 'QB' }];
    expect(frozenLineup(settings, saved, current, teamOf, games, FRIDAY)).toEqual([
      { playerId: 'qbBUF', slot: 'BN' },
      { playerId: 'qbKC', slot: 'QB' }
    ]);
  });

  it('keeps the departed starter even when the pickup saved into his slot has played too', () => {
    // Friday: qbKC (Thursday) left, qbBUF was saved into QB; by Monday both games have started.
    const saved: LineupEntry[] = [
      { playerId: 'qbKC', slot: 'QB' },
      { playerId: 'qbBUF', slot: 'QB' }
    ];
    const current: LineupEntry[] = [{ playerId: 'qbBUF', slot: 'QB' }];
    expect(frozenLineup(settings, saved, current, teamOf, games, '2026-09-14T12:00:00.000Z')).toEqual([
      { playerId: 'qbBUF', slot: 'BN' },
      { playerId: 'qbKC', slot: 'QB' }
    ]);
  });

  it('changes nothing before kickoff, for bench players, or for players without a game', () => {
    const saved: LineupEntry[] = [
      { playerId: 'qbKC', slot: 'QB' },
      { playerId: 'wrKC', slot: 'BN' },
      { playerId: 'nobody', slot: 'WR' }
    ];
    const current: LineupEntry[] = [{ playerId: 'qbBUF', slot: 'QB' }];
    expect(frozenLineup(settings, saved, current, teamOf, games, '2026-09-10T00:00:00.000Z')).toEqual(
      current
    );
    expect(frozenLineup(settings, saved.slice(1), current, teamOf, games, FRIDAY)).toEqual(current);
  });

  it('puts a locked player still on the roster back in his saved slot, once', () => {
    const saved: LineupEntry[] = [
      { playerId: 'wrKC', slot: 'WR' },
      { playerId: 'wrKC', slot: 'WR' }
    ];
    const current: LineupEntry[] = [
      { playerId: 'wrKC', slot: 'BN' },
      { playerId: 'wrKC', slot: 'BN' }
    ];
    expect(frozenLineup(settings, saved, current, teamOf, games, FRIDAY)).toEqual([
      { playerId: 'wrKC', slot: 'WR' }
    ]);
  });

  const SLOTS: RosterSlot[] = ['QB', 'WR', 'RB', 'TE', 'W/R/T', 'BN'];
  const NFL = ['KC', 'BAL', 'BUF', null];
  const scenario = fc
    .record({
      players: fc.array(
        fc.record({ slot: fc.constantFrom(...SLOTS), team: fc.constantFrom(...NFL), stays: fc.boolean() }),
        { maxLength: 14 }
      ),
      pickups: fc.array(fc.record({ slot: fc.constantFrom(...SLOTS), team: fc.constantFrom(...NFL) }), {
        maxLength: 4
      }),
      now: fc.constantFrom('2026-09-10T00:00:00.000Z', FRIDAY, '2026-09-14T00:00:00.000Z')
    })
    .map(({ players, pickups, now }) => {
      const nfl = new Map<string, string | null>();
      const fits = (lineup: LineupEntry[], slot: RosterSlot) =>
        !isStarterSlot(slot) || lineup.filter((e) => e.slot === slot).length < slotCount(settings, slot);
      const saved: LineupEntry[] = [];
      players.forEach((p, i) => {
        const id = `p${i}`;
        nfl.set(id, p.team);
        saved.push({ playerId: id, slot: fits(saved, p.slot) ? p.slot : 'BN' });
      });
      const current = saved.filter((_, i) => players[i]?.stays);
      pickups.forEach((p, i) => {
        const id = `n${i}`;
        nfl.set(id, p.team);
        current.push({ playerId: id, slot: fits(current, p.slot) ? p.slot : 'BN' });
      });
      return { saved, current, nfl, now };
    });

  it('always keeps every rostered player and every locked starter, and never overfills a slot', () => {
    fc.assert(
      fc.property(scenario, ({ saved, current, nfl, now }) => {
        const locked = (id: string) => {
          const team = nfl.get(id);
          const game = team == null ? undefined : games[team];
          return game !== undefined && Date.parse(String(game.kickoff)) <= Date.parse(now);
        };
        const out = frozenLineup(settings, saved, current, (id) => nfl.get(id), games, now);
        const ids = out.map((e) => e.playerId);
        expect(new Set(ids).size).toBe(ids.length);
        for (const e of current) expect(ids).toContain(e.playerId);
        for (const e of saved) {
          if (isStarterSlot(e.slot) && locked(e.playerId)) expect(out).toContainEqual(e);
        }
        for (const e of out) {
          const was = current.find((c) => c.playerId === e.playerId);
          if (was !== undefined && e.slot !== was.slot)
            expect(e.slot === 'BN' || locked(e.playerId)).toBe(true);
        }
        for (const slot of SLOTS.filter(isStarterSlot)) {
          const inSlot = out.filter((e) => e.slot === slot);
          expect(inSlot.length).toBeLessThanOrEqual(slotCount(settings, slot));
        }
        expect(frozenLineup(settings, saved, out, (id) => nfl.get(id), games, now)).toEqual(out);
      })
    );
  });
});
