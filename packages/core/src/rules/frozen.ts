import { isPlayerLocked, playerKickoff, type Instant, type LineupEntry, type WeekGames } from './lineup.js';
import { isStarterSlot } from './positions.js';
import { slotCount, type LeagueSettings } from './settings.js';

/**
 * A starter freezes at his game's kickoff: from then on the week is scored with him in the slot he
 * had when he locked, whatever happens to the roster afterwards. The server refuses to drop or trade
 * a locked player, so this is defense in depth against a roster change that slips past those checks.
 *
 * `saved` is the lineup stored for the week (it may still list a starter who has since left the
 * roster), `current` is that lineup reconciled with today's roster. The result is `current` with
 * every locked starter from `saved` back in his saved slot, including the ones who left the roster.
 * When that overfills a starting slot, the departed starters keep it (they were there when they
 * locked and never legitimately left), and players still on the roster are moved to the bench:
 * those not frozen from `saved` first, then the latest kickoffs, so a frozen starter can never be
 * replaced by a later pickup. `nflTeamOf`
 * gives a player's NFL team (null or undefined: no game).
 */
export function frozenLineup(
  settings: Pick<LeagueSettings, 'roster'>,
  saved: readonly LineupEntry[],
  current: readonly LineupEntry[],
  nflTeamOf: (playerId: string) => string | null | undefined,
  games: WeekGames,
  now: Instant
): LineupEntry[] {
  const team = (playerId: string) => ({ nflTeam: nflTeamOf(playerId) ?? null });
  const frozen = new Map<string, LineupEntry>();
  for (const e of saved) {
    if (isStarterSlot(e.slot) && !frozen.has(e.playerId) && isPlayerLocked(team(e.playerId), games, now)) {
      frozen.set(e.playerId, e);
    }
  }
  const rostered = new Set<string>();
  const result: LineupEntry[] = [];
  for (const e of current) {
    if (rostered.has(e.playerId)) continue;
    rostered.add(e.playerId);
    result.push({ playerId: e.playerId, slot: frozen.get(e.playerId)?.slot ?? e.slot });
  }
  for (const f of frozen.values()) {
    if (!rostered.has(f.playerId)) result.push({ playerId: f.playerId, slot: f.slot });
  }
  const kickoffMs = (playerId: string) => playerKickoff(team(playerId), games)?.getTime() ?? Infinity;
  for (const slot of new Set([...frozen.values()].map((f) => f.slot))) {
    const over = result.filter((e) => e.slot === slot).length - slotCount(settings, slot);
    if (over <= 0) continue;
    const benched = result
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.slot === slot && rostered.has(e.playerId))
      .sort(
        (a, b) =>
          Number(frozen.has(a.e.playerId)) - Number(frozen.has(b.e.playerId)) ||
          kickoffMs(b.e.playerId) - kickoffMs(a.e.playerId) ||
          b.i - a.i
      )
      .slice(0, over);
    for (const { e, i } of benched) result[i] = { playerId: e.playerId, slot: 'BN' };
  }
  return result;
}
