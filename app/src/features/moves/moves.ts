import { ApiError } from '../../api/client';
import type { MarketPlayer, Roster, RosterEntry, Standing } from '../../api/types';
import { KICKOFF } from '../season/gameState';
import { isStarter, place, placementOf, seats, statusLabel, willPlay } from '../season/slots';

/**
 * The roster workspace's rules and words (#205): what a roster needs this week, who can be
 * dropped for a pickup, and how the market and its errors read. The server decides every move
 * again; this only picks what to offer and how to say it.
 */

export const pts = (n: number | null | undefined): string =>
  n === null || n === undefined ? '–' : n.toFixed(1);

/** "Wed 3:00 AM": waiver runs and clear times, in the viewer's time zone. */
export function waiverTime(iso: string): string {
  return KICKOFF.format(new Date(iso));
}

/** "2.3k" above a thousand, else the count. */
export function compactCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n);
}

/** The crowd's net move on a player: "2.3k adds" up, "5.3k drops" down, or null when flat. */
export function trendOf(trend: MarketPlayer['trend']): { up: boolean; text: string } | null {
  if (trend === null) return null;
  const net = trend.adds - trend.drops;
  if (net === 0) return null;
  return net > 0
    ? { up: true, text: `${compactCount(net)} adds` }
    : { up: false, text: `${compactCount(-net)} drops` };
}

/** "Free agent", "Waivers · clears Wed 3:00 AM", or the rostering team's name. */
export function standingText(standing: Standing, teamName: (teamId: string) => string): string {
  if (standing.status === 'waivers') {
    return standing.clearsAt === undefined ? 'Waivers' : `Waivers · clears ${waiverTime(standing.clearsAt)}`;
  }
  if (standing.status === 'rostered') return teamName(standing.teamId ?? '');
  return 'Free agent';
}

/** The market filter that finds someone for a slot: its position, FLEX for W/R/T, else '' (all). */
export function slotPosition(slot: string): string {
  if (['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].includes(slot)) return slot;
  return slot === 'W/R/T' ? 'FLEX' : '';
}

export interface RosterNeed {
  key: string;
  text: string;
  /** Opens the market filtered to this position ('' for all). */
  find?: string;
  /** Moves this player to IR. */
  toIr?: RosterEntry;
}

/** A starting seat's name: "RB2" when the league starts more than one, else "RB". */
function seatName(slot: string, index: number, count: number): string {
  return count > 1 ? `${slot}${index + 1}` : slot;
}

/**
 * What the roster needs this week: empty starting slots, starters who will not play (on bye or
 * ruled out, before their game), and hurt players holding an active spot while IR has room.
 */
export function rosterNeeds(roster: Roster): RosterNeed[] {
  const needs: RosterNeed[] = [];
  const counts = new Map(roster.slots.map((s) => [s.slot, s.count]));
  const seen = new Map<string, number>();
  for (const seat of seats(roster.players, roster.slots, placementOf(roster.players))) {
    const index = seen.get(seat.slot) ?? 0;
    seen.set(seat.slot, index + 1);
    const name = seatName(seat.slot, index, counts.get(seat.slot) as number);
    const find = slotPosition(seat.slot);
    if (seat.entry === null) {
      needs.push({ key: `empty-${seat.key}`, text: `${name} is empty: find a starter`, find });
    } else if (!seat.entry.locked && !willPlay(seat.entry)) {
      const why = seat.entry.onBye ? 'is on bye' : `is ${String(statusLabel(seat.entry))}`;
      needs.push({
        key: `out-${seat.entry.player.id}`,
        text: `${name} ${seat.entry.player.name} ${why}: find a replacement`,
        find
      });
    }
  }
  const placement = placementOf(roster.players);
  for (const entry of roster.players) {
    if (
      entry.slot === 'IR' ||
      place(roster.players, roster.slots, placement, entry.player.id, { kind: 'ir' }) === null
    ) {
      continue;
    }
    needs.push({
      key: `ir-${entry.player.id}`,
      text: `${entry.player.name} can move to IR to free a spot`,
      toIr: entry
    });
  }
  return needs;
}

/** Whether a player can go to IR now (hurt, IR has room, not locked). */
export function canMoveToIr(roster: Roster, entry: RosterEntry): boolean {
  return (
    place(roster.players, roster.slots, placementOf(roster.players), entry.player.id, { kind: 'ir' }) !== null
  );
}

/** Players you could drop for a pickup, lowest value first: nobody on IR (they hold no spot). */
export function dropCandidates(roster: Roster): RosterEntry[] {
  const value = (e: RosterEntry) => (willPlay(e) ? (e.projectedPoints ?? 0) : 0);
  return roster.players
    .filter((e) => e.slot !== 'IR')
    .sort(
      (a, b) =>
        value(a) - value(b) ||
        (a.seasonAverage?.average ?? 0) - (b.seasonAverage?.average ?? 0) ||
        a.player.name.localeCompare(b.player.name)
    );
}

/** "Starter" or "Bench" for a drop row. */
export function roleOf(entry: RosterEntry): string {
  return isStarter(entry.slot) ? `Starting ${entry.slot}` : 'Bench';
}

/**
 * An add or claim refusal in plain words, naming the players involved. Every code the flow can
 * hit has its own sentence; anything else shows the server's message and fix.
 */
export function moveErrorText(error: unknown, names: { player: string; drop: string | null }): string {
  if (!(error instanceof ApiError)) return error instanceof Error ? error.message : 'Something went wrong.';
  const faab = (error.details as { faabRemaining?: number } | undefined)?.faabRemaining;
  switch (error.code) {
    case 'PLAYER_LOCKED':
      return names.drop === null
        ? 'A game-day lock hit this move; pick another player.'
        : `Your game-day lock hit ${names.drop}; pick another drop.`;
    case 'ROSTER_FULL':
      return 'Your roster is full: pick a player to drop.';
    case 'INSUFFICIENT_FAAB':
      return faab === undefined
        ? 'That bid is more than your FAAB left.'
        : `You have $${faab} FAAB left; lower your bid.`;
    case 'ZERO_BID_NOT_ALLOWED':
      return 'This league needs a bid of at least $1.';
    case 'PLAYER_NOT_AVAILABLE':
      return `${names.player} is no longer available: another team has him.`;
    case 'DUPLICATE_WAIVER_CLAIM':
      return `You already have a claim on ${names.player}; change it under Pending claims.`;
    case 'ACQUISITION_LIMIT_REACHED':
      return 'You have used all your adds this week.';
    case 'PLAYER_IN_TRADE':
      return `${names.drop ?? names.player} is in a trade being processed; pick another drop.`;
    default:
      return error.fix === undefined ? error.message : `${error.message} ${error.fix}`;
  }
}
