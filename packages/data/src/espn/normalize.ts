import { SchemaDriftError, type DriftIssue } from '../errors.js';
import { SLEEPER_TEAMS, toSleeperTeam } from '../teams.js';
import type { LiveGame, ScheduledGame } from '../types.js';
import { espnEventSchema, type EspnEvent, type EspnScoreboard, type EspnSituation } from './schemas.js';

const KNOWN_TEAMS = new Set<string>(SLEEPER_TEAMS);

/** ESPN's team code as Sleeper writes it (`WSH` → `WAS`), or null for a code we do not know. */
export function espnTeam(code: string): string | null {
  const team = toSleeperTeam(code);
  return team !== null && KNOWN_TEAMS.has(team) ? team : null;
}

export interface NormalizeScoreboardOptions {
  /** The week's games from our schedule, matched to ESPN's by home and away team. */
  games: readonly ScheduledGame[];
  asOf: Date;
}

/**
 * ESPN's scoreboard as `LiveGame`s, one per game. Tolerant by design: a game without a situation
 * has no possession or red zone, fields we do not read are ignored, and a single malformed event
 * is skipped. Only when no event at all has the expected shape does it raise `SchemaDriftError`,
 * because then ESPN changed the payload.
 */
export function normalizeScoreboard(board: EspnScoreboard, options: NormalizeScoreboardOptions): LiveGame[] {
  const updatedAt = options.asOf.toISOString();
  const games: LiveGame[] = [];
  const issues: DriftIssue[] = [];
  board.events.forEach((raw, index) => {
    const parsed = espnEventSchema.safeParse(raw);
    if (parsed.success) {
      games.push(normalizeEvent(parsed.data, options.games, updatedAt));
      return;
    }
    for (const issue of parsed.error.issues) {
      issues.push({ path: ['events', index, ...issue.path].map(String).join('.'), message: issue.message });
    }
  });
  if (games.length === 0 && issues.length > 0) throw new SchemaDriftError('espn /scoreboard', issues);
  return games;
}

function normalizeEvent(event: EspnEvent, schedule: readonly ScheduledGame[], updatedAt: string): LiveGame {
  // The schema requires at least one competition.
  const competition = event.competitions[0] as EspnEvent['competitions'][number];
  const side = (homeAway: 'home' | 'away') => competition.competitors.find((c) => c.homeAway === homeAway);
  const home = side('home');
  const away = side('away');
  const homeTeam = home === undefined ? null : espnTeam(home.team.abbreviation);
  const awayTeam = away === undefined ? null : espnTeam(away.team.abbreviation);
  const { status } = competition;
  const state = status.type.state;
  const situation = state === 'in' ? (competition.situation ?? null) : null;
  const possessor =
    situation?.possession == null
      ? undefined
      : competition.competitors.find((c) => c.team.id === situation.possession);
  const possessionTeam = possessor === undefined ? null : espnTeam(possessor.team.abbreviation);
  const fieldPosition = situation === null ? null : spot(situation);
  return {
    gameKey: matchGame(schedule, homeTeam, awayTeam),
    espnId: event.id,
    homeTeam,
    awayTeam,
    homeScore: state === 'pre' ? null : score(home?.score),
    awayScore: state === 'pre' ? null : score(away?.score),
    kickoff: isoOrNull(competition.date ?? event.date),
    state,
    status: status.type.shortDetail?.trim() || null,
    period: state === 'pre' ? null : (status.period ?? null),
    clock: state === 'in' ? status.displayClock?.trim() || null : null,
    possessionTeam,
    isRedZone: possessionTeam !== null && situation?.isRedZone === true,
    downDistance: situation === null ? null : downDistance(situation, fieldPosition),
    fieldPosition,
    yardsToGoal: possessionTeam === null ? null : yardsToGoal(fieldPosition, possessionTeam),
    updatedAt
  };
}

/** Our game with these teams (either way round, for neutral sites), or null. */
function matchGame(games: readonly ScheduledGame[], home: string | null, away: string | null): string | null {
  if (home === null || away === null) return null;
  const game =
    games.find((g) => g.homeTeam === home && g.awayTeam === away) ??
    games.find((g) => g.homeTeam === away && g.awayTeam === home);
  return game?.gameId ?? null;
}

function score(value: string | number | null | undefined): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isoOrNull(value: string | null | undefined): string | null {
  const ms = Date.parse(value ?? '');
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

const ORDINAL = ['1st', '2nd', '3rd', '4th'];

/** `2nd & 4 at DAL 7`: ESPN's own text, else built from the down, distance, and spot. */
function downDistance(situation: EspnSituation, at: string | null): string | null {
  const text = situation.downDistanceText?.trim();
  if (text) return text;
  const down = situation.down == null ? undefined : ORDINAL[situation.down - 1];
  if (down === undefined || situation.distance == null) return null;
  return `${down} & ${situation.distance}${at === null ? '' : ` at ${at}`}`;
}

/** `DAL 7`: ESPN's `possessionText`, else the spot after "at" in the down-and-distance text. */
function spot(situation: EspnSituation): string | null {
  const text = situation.possessionText?.trim();
  if (text) return text;
  const match = / at (.+)$/.exec(situation.downDistanceText ?? '');
  return match?.[1]?.trim() || null;
}

/**
 * Yards to the goal line the offense attacks, from the spot: `DAL 7` with PHI on offense is 7, and
 * `PHI 25` is 75. Null when the spot does not parse.
 */
export function yardsToGoal(fieldPosition: string | null, offense: string): number | null {
  const match = /^(?:([A-Za-z]{2,3}) )?(\d{1,2})$/.exec(fieldPosition ?? '');
  if (match === null) return null;
  const yard = Number(match[2]);
  if (yard > 50) return null;
  if (match[1] === undefined) return yard === 50 ? 50 : null;
  return espnTeam(match[1]) === offense ? 100 - yard : yard;
}
