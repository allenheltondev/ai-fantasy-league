import {
  advanceBracket,
  buildBracket,
  seedPlayoffs,
  type Bracket,
  type BracketKind,
  type BracketWeekResults
} from '../playoffs/bracket.js';
import type { Instant, LineupEntry } from '../rules/lineup.js';
import type { RosterSlot } from '../rules/positions.js';
import { ruleOk, type RuleResult } from '../rules/result.js';
import type { LeagueSettings } from '../rules/settings.js';
import type { StandingsRow } from '../standings/standings.js';
import { HOUR_MS, instantMs } from '../time.js';

/**
 * The weekly season cycle, as pure functions: game windows (when lineups start locking), when a
 * week is over, which week comes next, and how lineups carry from one week to the next. The server
 * drives these from its clock (`packages/server/src/season/`); nothing here reads the time.
 */

/** Kickoffs closer together than this belong to one game window (Sunday's 4:05 and 4:25 games). */
export const GAME_WINDOW_GAP_MS = HOUR_MS;

export interface WeekGame {
  kickoff: Instant;
  homeTeam: string;
  awayTeam: string;
}

export interface GameWindow {
  /** The window's first kickoff: the first players lock then. */
  startsAt: string;
  /** NFL teams playing in the window. */
  teams: string[];
}

/** A week's game windows in time order: kickoffs within `gapMs` of the previous one share a window. */
export function gameWindows(games: readonly WeekGame[], gapMs: number = GAME_WINDOW_GAP_MS): GameWindow[] {
  const sorted = [...games].sort((a, b) => instantMs(a.kickoff) - instantMs(b.kickoff));
  const windows: { start: number; last: number; teams: string[] }[] = [];
  for (const game of sorted) {
    const at = instantMs(game.kickoff);
    const current = windows.at(-1);
    if (current !== undefined && at - current.last <= gapMs) {
      current.last = at;
      current.teams.push(game.homeTeam, game.awayTeam);
    } else {
      windows.push({ start: at, last: at, teams: [game.homeTeam, game.awayTeam] });
    }
  }
  return windows.map((w) => ({
    startsAt: new Date(w.start).toISOString(),
    teams: [...new Set(w.teams)].sort()
  }));
}

/** The first kickoff of the week, or null when there are no games. */
export function firstKickoff(games: readonly WeekGame[]): string | null {
  return gameWindows(games)[0]?.startsAt ?? null;
}

/**
 * When the week's last game is over (usually the Monday night game): its kickoff plus
 * `gameDurationMs`. Null when there are no games.
 */
export function weekEndsAt(games: readonly WeekGame[], gameDurationMs: number): string | null {
  if (games.length === 0) return null;
  const last = Math.max(...games.map((g) => instantMs(g.kickoff)));
  return new Date(last + gameDurationMs).toISOString();
}

export type LeagueWeekStep =
  { phase: 'regular_season' | 'playoffs'; week: number } | { phase: 'complete'; week: number };

/**
 * Where a league goes once `week` is final: the next regular-season week, the first playoff week
 * after the regular season ends, the next playoff week, or `complete` after the last playoff week.
 */
export function nextLeagueWeek(
  settings: Pick<LeagueSettings, 'schedule' | 'playoffs'>,
  phase: 'regular_season' | 'playoffs',
  week: number
): LeagueWeekStep {
  if (phase === 'regular_season' && week < settings.schedule.regularSeasonEndWeek) {
    return { phase: 'regular_season', week: week + 1 };
  }
  if (phase === 'regular_season') return { phase: 'playoffs', week: settings.playoffs.startWeek };
  if (week < settings.playoffs.endWeek) return { phase: 'playoffs', week: week + 1 };
  return { phase: 'complete', week };
}

/**
 * A saved lineup brought up to date with the current roster: players no longer rostered are
 * removed, and rostered players the lineup does not mention are added on the bench. Used to carry
 * last week's lineup into a new week and after roster moves.
 */
export function reconcileLineup(lineup: readonly LineupEntry[], rosterIds: readonly string[]): LineupEntry[] {
  const rostered = new Set(rosterIds);
  const kept: LineupEntry[] = [];
  const seen = new Set<string>();
  for (const entry of lineup) {
    if (!rostered.has(entry.playerId) || seen.has(entry.playerId)) continue;
    seen.add(entry.playerId);
    kept.push({ playerId: entry.playerId, slot: entry.slot });
  }
  for (const id of rosterIds) {
    if (!seen.has(id)) {
      seen.add(id);
      kept.push({ playerId: id, slot: 'BN' });
    }
  }
  return kept;
}

export interface LineupMove {
  playerId: string;
  slot: RosterSlot;
}

/**
 * Applies slot moves to a lineup. Players not moved stay where they are, and a later move of the
 * same player wins. A moved player the lineup does not contain is appended, so `validateLineup`
 * reports him as not on the roster. Nobody is displaced automatically: moving a player into a full
 * slot overfills it, and validation says which slot to clear.
 */
export function applyLineupMoves(
  lineup: readonly LineupEntry[],
  moves: readonly LineupMove[]
): LineupEntry[] {
  const slots = new Map<string, RosterSlot>();
  for (const move of moves) slots.set(move.playerId, move.slot);
  const out = lineup.map((e) => ({ playerId: e.playerId, slot: slots.get(e.playerId) ?? e.slot }));
  const present = new Set(lineup.map((e) => e.playerId));
  for (const [playerId, slot] of slots) if (!present.has(playerId)) out.push({ playerId, slot });
  return out;
}

export interface PairedMatchup {
  homeTeamId: string;
  awayTeamId: string;
}

/** A playoff game ready to be played: its bracket game id and both teams. */
export interface PairedPlayoffGame extends PairedMatchup {
  gameId: string;
  bracket: BracketKind;
}

/**
 * The league's playoff bracket rebuilt from the final regular-season standings and the results of
 * the playoff weeks already played. Seeding, byes, reseeding, and the consolation bracket all come
 * from `settings.playoffs`, which lock at the draft, so rebuilding is deterministic and only the
 * standings and results need storing.
 */
export function playoffBracket(
  settings: Pick<LeagueSettings, 'playoffs'>,
  finalStandings: readonly Pick<StandingsRow, 'teamId' | 'rank'>[],
  played: readonly BracketWeekResults[]
): RuleResult<Bracket> {
  const seeding = seedPlayoffs(settings, finalStandings);
  if (!seeding.ok) return seeding;
  const consolation = settings.playoffs.consolation && seeding.value.nonPlayoff.length >= 2;
  let bracket = buildBracket(settings, seeding.value.seeds, {
    consolation,
    nonPlayoff: seeding.value.nonPlayoff
  });
  for (const results of [...played].sort((a, b) => a.week - b.week)) {
    if (!bracket.ok) break;
    bracket = advanceBracket(bracket.value, results);
  }
  return bracket;
}

/**
 * The bracket games of a playoff `week` (championship and, when the league plays one,
 * consolation), from the final regular-season standings and the playoff weeks already played.
 * Games whose teams are not known yet are left out.
 */
export function playoffMatchups(
  settings: Pick<LeagueSettings, 'playoffs'>,
  finalStandings: readonly Pick<StandingsRow, 'teamId' | 'rank'>[],
  played: readonly BracketWeekResults[],
  week: number
): RuleResult<PairedPlayoffGame[]> {
  const bracket = playoffBracket(settings, finalStandings, played);
  if (!bracket.ok) return bracket;
  return ruleOk(
    bracket.value.games
      .filter((g) => g.week === week && g.home.teamId !== null && g.away.teamId !== null)
      .map((g) => ({
        gameId: g.id,
        bracket: g.bracket,
        homeTeamId: g.home.teamId as string,
        awayTeamId: g.away.teamId as string
      }))
  );
}
