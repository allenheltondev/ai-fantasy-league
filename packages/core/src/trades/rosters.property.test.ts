import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { activeRosterSize, yahooDefaultSettings, type LeagueSettings } from '../rules/settings.js';
import { rp } from './fixtures.test-helpers.js';
import { acceptTrade, counterTrade, processTrade, proposeTrade } from './machine.js';
import type { RosteredPlayer, Trade } from './trade.js';

/**
 * Rosters under any sequence of proposals, counters, acceptances, and processing: no player is ever
 * on two rosters, no player appears from nowhere, and every roster stays within the active limit.
 */

const settings: LeagueSettings = {
  ...yahooDefaultSettings(4),
  roster: { ...yahooDefaultSettings(4).roster, slots: { QB: 1, RB: 1, BN: 2 } },
  trades: { ...yahooDefaultSettings(4).trades, review: 'none', expireAtNextLineupLock: false }
};
const LIMIT = activeRosterSize(settings);
const TEAMS = ['A', 'B', 'C'];

const step = fc.record({
  action: fc.constantFrom('propose', 'counter', 'accept', 'process'),
  from: fc.integer({ min: 0, max: 2 }),
  to: fc.integer({ min: 0, max: 2 }),
  send: fc.integer({ min: 0, max: 3 }),
  receive: fc.integer({ min: 0, max: 3 }),
  pick: fc.nat()
});

function initialRosters(): Record<string, RosteredPlayer[]> {
  return Object.fromEntries(
    TEAMS.map((t, i) => [t, Array.from({ length: 2 + i }, (_, n) => rp(`${t}${n}`, 'WR'))])
  );
}

/** The drops a team needs so its roster fits after receiving `incoming` and sending `sends`. */
function neededDrops(roster: readonly RosteredPlayer[], sends: readonly string[], incoming: number): string[] {
  const staying = roster.filter((p) => !sends.includes(p.playerId));
  const excess = staying.length + incoming - LIMIT;
  return excess > 0 ? staying.slice(0, excess).map((p) => p.playerId) : [];
}

describe('trade roster invariants', () => {
  it('never puts a player on two rosters and keeps every roster legal', () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 25 }), (steps) => {
        let rosters = initialRosters();
        const everyone = new Set(Object.values(rosters).flatMap((r) => r.map((p) => p.playerId)));
        const released = new Set<string>();
        let open: Trade[] = [];
        let accepted: Trade[] = [];
        let seq = 0;
        const ctx = () => ({ now: '2026-10-01T12:00:00.000Z', currentWeek: 5, rosters });

        for (const s of steps) {
          const from = TEAMS[s.from] as string;
          const to = TEAMS[s.to] as string;
          if (s.action === 'propose' || s.action === 'counter') {
            const target = open[s.pick % Math.max(1, open.length)];
            const me = s.action === 'counter' ? target?.sides[1].teamId : from;
            const them = s.action === 'counter' ? target?.sides[0].teamId : to;
            if (me === undefined || them === undefined) continue;
            const mine = (rosters[me] ?? []).slice(0, s.send).map((p) => p.playerId);
            const theirs = (rosters[them] ?? []).slice(0, s.receive).map((p) => p.playerId);
            const sides = [
              { teamId: me, sends: mine, drops: neededDrops(rosters[me] ?? [], mine, theirs.length) },
              { teamId: them, sends: theirs, drops: [] }
            ] as const;
            const input = { tradeId: `t${++seq}`, sides, nextLockTime: null };
            if (s.action === 'propose') {
              const r = proposeTrade(settings, input, ctx());
              if (r.ok) open.push(r.trade);
            } else if (target !== undefined) {
              const r = counterTrade(settings, target, { ...input, byTeamId: me }, ctx());
              if (r.ok) open = [...open.filter((t) => t !== target), r.counter];
            }
          } else if (s.action === 'accept') {
            const t = open[s.pick % Math.max(1, open.length)];
            if (t === undefined) continue;
            const [a, b] = t.sides;
            const drops = neededDrops(rosters[b.teamId] ?? [], b.sends, a.sends.length).filter(
              (id) => !a.sends.includes(id)
            );
            const r = acceptTrade(settings, t, { byTeamId: b.teamId, drops }, ctx());
            if (r.ok) {
              open = open.filter((x) => x !== t);
              accepted.push(r.trade);
            }
          } else {
            const t = accepted[s.pick % Math.max(1, accepted.length)];
            if (t === undefined) continue;
            accepted = accepted.filter((x) => x !== t);
            const r = processTrade(settings, t, ctx());
            if (!r.ok) continue;
            rosters = r.rosters;
            for (const p of r.dropped) released.add(p.playerId);
          }

          const onRosters = Object.values(rosters).flatMap((r) => r.map((p) => p.playerId));
          expect(new Set(onRosters).size).toBe(onRosters.length);
          for (const id of onRosters) {
            expect(everyone.has(id)).toBe(true);
            expect(released.has(id)).toBe(false);
          }
          expect(onRosters.length + released.size).toBe(everyone.size);
          for (const roster of Object.values(rosters)) expect(roster.length).toBeLessThanOrEqual(LIMIT);
        }
      })
    );
  });
});
