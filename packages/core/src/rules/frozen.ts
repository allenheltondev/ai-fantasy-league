import { isPlayerLocked, type Instant, type LineupEntry, type WeekGames } from './lineup.js';
import { isStarterSlot } from './positions.js';
import { slotCount, type LeagueSettings } from './settings.js';

/**
 * A starter freezes at his game's kickoff: from then on the week is scored with him in the slot he
 * had when he locked, whatever happens to the roster afterwards. The server refuses to drop or trade
 * a locked player, so this is defense in depth against a roster change that slips past those checks.
 *
 * `saved` is the lineup stored for the week (it may still list a starter who has since left the
 * roster), `current` is that lineup reconciled with today's roster. The result is `current` with
 * every locked starter from `saved` back in his saved slot. When that overfills a starting slot, the
 * unlocked players who took the slot since are moved to the bench, so a frozen starter can never be
 * replaced by a later pickup. `nflTeamOf` gives a player's NFL team (null or undefined: no game).
 */
export function frozenLineup(
  settings: Pick<LeagueSettings, 'roster'>,
  saved: readonly LineupEntry[],
  current: readonly LineupEntry[],
  nflTeamOf: (playerId: string) => string | null | undefined,
  games: WeekGames,
  now: Instant
): LineupEntry[] {
  const locked = (playerId: string) => isPlayerLocked({ nflTeam: nflTeamOf(playerId) ?? null }, games, now);
  const frozen = new Map<string, LineupEntry>();
  for (const e of saved) {
    if (isStarterSlot(e.slot) && !frozen.has(e.playerId) && locked(e.playerId)) frozen.set(e.playerId, e);
  }
  const seen = new Set<string>();
  const result: LineupEntry[] = [];
  for (const e of current) {
    if (seen.has(e.playerId)) continue;
    seen.add(e.playerId);
    result.push({ playerId: e.playerId, slot: frozen.get(e.playerId)?.slot ?? e.slot });
  }
  for (const f of frozen.values()) {
    if (!seen.has(f.playerId)) result.push({ playerId: f.playerId, slot: f.slot });
  }
  for (const slot of new Set([...frozen.values()].map((f) => f.slot))) {
    let over = result.filter((e) => e.slot === slot).length - slotCount(settings, slot);
    for (let i = result.length - 1; i >= 0 && over > 0; i--) {
      const e = result[i] as LineupEntry;
      if (e.slot === slot && !frozen.has(e.playerId) && !locked(e.playerId)) {
        result[i] = { playerId: e.playerId, slot: 'BN' };
        over--;
      }
    }
  }
  return result;
}
