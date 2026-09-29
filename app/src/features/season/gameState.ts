import { useEffect, useState } from 'react';
import type { PlayerGame, RosterEntry } from '../../api/types';
import { isStarter, willPlay } from './slots';

/**
 * How the app words a player's game (#193). The state itself comes from the server (core
 * `playerGame`), so the matchup, the outlook, and the lineup never disagree; this only turns it into
 * text, counts, and lock countdowns.
 */

export const KICKOFF = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  hour: 'numeric',
  minute: '2-digit'
});

/** A player's game, or one derived from the older fields for a response from before #193. */
export function gameOf(entry: RosterEntry): PlayerGame {
  if (entry.game !== undefined) return entry.game;
  const bye = entry.onBye || entry.kickoff === null;
  return {
    state: bye ? 'bye' : entry.locked ? 'live' : 'upcoming',
    opponent: entry.opponent?.team ?? null,
    home: entry.opponent?.home ?? null,
    kickoff: entry.kickoff,
    period: null,
    clock: null,
    teamScore: null,
    opponentScore: null,
    possession: false,
    redZone: false,
    progress: null
  };
}

/** `vs DAL` at home, `@ DAL` away. */
export function versus(game: Pick<PlayerGame, 'opponent' | 'home'>): string {
  if (game.opponent === null) return '';
  return `${game.home === false ? '@' : 'vs'} ${game.opponent}`;
}

/** `Q3 8:42`, `Halftime`, `OT 6:00`, or null before a quarter is known. */
export function periodLabel(period: number | null, clock: string | null): string | null {
  if (period === null) return null;
  if (period === 2 && (clock === '0:00' || clock === '00:00')) return 'Halftime';
  const quarter = period > 4 ? (period === 5 ? 'OT' : `${period - 4}OT`) : `Q${period}`;
  return clock === null ? quarter : `${quarter} ${clock}`;
}

/** `W 27–20`, `L 17–24`, `T 17–17`: his team's score first. */
export function scoreLine(game: PlayerGame, final: boolean): string | null {
  if (game.teamScore === null || game.opponentScore === null) return null;
  const score = `${game.teamScore}–${game.opponentScore}`;
  if (!final) return score;
  const result = game.teamScore > game.opponentScore ? 'W' : game.teamScore < game.opponentScore ? 'L' : 'T';
  return `${result} ${score}`;
}

/** Whether a starter will score nothing more: on bye, or ruled out and his game not final. */
export function sitsOut(entry: RosterEntry): boolean {
  const game = gameOf(entry);
  return game.state === 'bye' || (game.state !== 'final' && !willPlay(entry));
}

/**
 * The second line of a player's cell: `Sun 1:00 PM vs DAL`, `Q3 8:42 · vs DAL 14–10`,
 * `Final · W 27–20`, or `BYE`. Always text, so no state relies on color.
 */
export function gameContext(entry: RosterEntry): string {
  return gameText(gameOf(entry));
}

/** `gameContext` for a game on its own (the player market's rows, #205). */
export function gameText(game: PlayerGame): string {
  switch (game.state) {
    case 'bye':
      return 'BYE';
    case 'upcoming':
      return [game.kickoff === null ? null : KICKOFF.format(new Date(game.kickoff)), versus(game)]
        .filter(Boolean)
        .join(' ');
    case 'live': {
      const when = periodLabel(game.period, game.clock) ?? 'Live';
      const score = scoreLine(game, false);
      return `${when} · ${versus(game)}${score === null ? '' : ` ${score}`}`;
    }
    case 'final': {
      const score = scoreLine(game, true);
      return score === null ? `Final · ${versus(game)}` : `Final · ${score}`;
    }
  }
}

export interface StateCounts {
  playing: number;
  toPlay: number;
  done: number;
  out: number;
}

/** The starters by game state; one on bye or ruled out (and not final) counts as out. */
export function stateCounts(players: readonly RosterEntry[]): StateCounts {
  const counts = { playing: 0, toPlay: 0, done: 0, out: 0 };
  for (const p of players) {
    if (!isStarter(p.slot)) continue;
    const state = gameOf(p).state;
    if (state === 'final') counts.done++;
    else if (sitsOut(p)) counts.out++;
    else if (state === 'live') counts.playing++;
    else counts.toPlay++;
  }
  return counts;
}

/** "3 playing · 4 to play · 2 done · 1 out", leaving out the zeros. */
export function countsLabel(counts: StateCounts): string {
  const parts = [
    counts.playing > 0 ? `${counts.playing} playing` : null,
    counts.toPlay > 0 ? `${counts.toPlay} to play` : null,
    counts.done > 0 ? `${counts.done} done` : null,
    counts.out > 0 ? `${counts.out} out` : null
  ].filter((p): p is string => p !== null);
  return parts.length === 0 ? 'No starters' : parts.join(' · ');
}

/** Show "Locks in …" this long before a kickoff. */
export const LOCK_SOON_MS = 60 * 60_000;

/** "Locks in 12m" within the hour before his kickoff, else null (and null once locked). */
export function locksIn(entry: RosterEntry, now: number): string | null {
  if (isLockedAt(entry, now) || entry.kickoff === null) return null;
  const left = Date.parse(entry.kickoff) - now;
  if (left > LOCK_SOON_MS) return null;
  const minutes = Math.max(1, Math.ceil(left / 60_000));
  return `Locks in ${minutes}m`;
}

/** Locked by the server, or since then by the clock: his kickoff has come. */
export function isLockedAt(entry: RosterEntry, now: number): boolean {
  return entry.locked || (entry.kickoff !== null && !entry.onBye && Date.parse(entry.kickoff) <= now);
}

/**
 * The players with `locked` brought up to `now` (#193): a player locks at his kickoff without a
 * reload. The server stays the judge (set_lineup refuses a locked move either way).
 */
export function withLocksAt(players: readonly RosterEntry[], now: number): RosterEntry[] {
  return players.map((p) => (p.locked || !isLockedAt(p, now) ? p : { ...p, locked: true }));
}

/** When the next of these kickoffs comes after `now`, or null. */
export function nextKickoff(players: readonly RosterEntry[], now: number): number | null {
  let next: number | null = null;
  for (const p of players) {
    if (p.kickoff === null) continue;
    const at = Date.parse(p.kickoff);
    if (at > now && (next === null || at < next)) next = at;
  }
  return next;
}

/**
 * The time, ticking every `tickMs` and exactly at `boundary(now)` (the next kickoff), so a lock
 * lands on time and a countdown stays fresh.
 */
export function useNow(tickMs: number, boundary: (now: number) => number | null = () => null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(timer);
  }, [tickMs]);
  const next = boundary(now);
  useEffect(() => {
    if (next === null) return undefined;
    // setTimeout caps at about 24.8 days; the interval covers anything later.
    const wait = Math.min(Math.max(0, next - Date.now()), 2_147_483_647);
    const timer = setTimeout(() => setNow(Date.now()), wait);
    return () => clearTimeout(timer);
  }, [next]);
  return now;
}
