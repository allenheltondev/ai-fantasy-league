import { ruleError, type RuleIssue } from '../rules/issues.js';
import { ruleFail, ruleOk, type RuleResult } from '../rules/result.js';
import { playoffRounds, requiredByes, type LeagueSettings } from '../rules/settings.js';
import { matchupResult } from '../standings/standings.js';
import type { StandingsRow } from '../standings/standings.js';

export interface PlayoffSeed {
  /** 1 is the best seed. Consolation seeds continue the numbering (7, 8, ... in an 8-team league). */
  seed: number;
  teamId: string;
}

export interface PlayoffSeeding {
  /** Playoff teams, best first. */
  seeds: PlayoffSeed[];
  /** Teams that missed the playoffs, best first (the consolation bracket field). */
  nonPlayoff: PlayoffSeed[];
}

type PlayoffSettingsInput = Pick<LeagueSettings, 'playoffs'>;

/**
 * Seeds the playoffs from final standings: the top `playoffs.teams` by rank. Standings already apply
 * the league's tiebreakers, so seeding is just rank order.
 */
export function seedPlayoffs(
  settings: PlayoffSettingsInput,
  standings: readonly Pick<StandingsRow, 'teamId' | 'rank'>[]
): RuleResult<PlayoffSeeding> {
  const needed = settings.playoffs.teams;
  if (standings.length < needed) {
    return ruleFail([
      ruleError(
        'NOT_ENOUGH_TEAMS_FOR_PLAYOFFS',
        'playoffs.teams',
        `The playoffs need ${needed} teams, but the standings have ${standings.length}.`,
        `Pass the full standings, or set playoffs.teams to ${standings.length} or fewer.`
      )
    ]);
  }
  const ordered = [...standings].sort((a, b) => a.rank - b.rank);
  const all = ordered.map((row, i) => ({ seed: i + 1, teamId: row.teamId }));
  return ruleOk({ seeds: all.slice(0, needed), nonPlayoff: all.slice(needed) });
}

export type BracketKind = 'championship' | 'consolation';

/**
 * Where a bracket side comes from: a seed placed directly, the winner of an earlier game (a fixed
 * bracket), or the teams left after the previous round, re-paired best against worst (reseeding).
 */
export type BracketSource =
  { type: 'seed'; seed: number } | { type: 'winner'; gameId: string } | { type: 'reseed'; round: number };

export interface BracketSide {
  source: BracketSource;
  /** Filled once known (immediately for seeds, after the feeding game for winners). */
  teamId: string | null;
  seed: number | null;
  score: number | null;
}

export interface BracketGame {
  /** e.g. `championship-r1-g2`. */
  id: string;
  bracket: BracketKind;
  /** 1-based round within its bracket. */
  round: number;
  week: number;
  /** The better seed once both sides are known. */
  home: BracketSide;
  away: BracketSide;
  winnerTeamId: string | null;
  /** True when the game was tied and the better seed advanced. */
  decidedBySeed: boolean;
}

export interface Bracket {
  seeds: PlayoffSeed[];
  /** The consolation bracket's field (empty without one). Teams that did not fit sit out. */
  consolationSeeds: PlayoffSeed[];
  /** True when each round after the first re-pairs the teams left, best seed against worst. */
  reseed: boolean;
  /** Weeks of the championship bracket, one per round. */
  weeks: number[];
  games: BracketGame[];
  /** Id of the championship game. */
  finalGameId: string;
  /** Id of the consolation final, when the league plays a consolation bracket. */
  consolationFinalGameId: string | null;
}

export interface BracketOptions {
  /** Also build a bracket for the teams that missed the playoffs (Yahoo's consolation bracket). */
  consolation?: boolean;
  /** Required with `consolation`: the non-playoff teams from `seedPlayoffs`. */
  nonPlayoff?: readonly PlayoffSeed[];
  /**
   * Re-pair the teams left after each round, best remaining seed against worst (defaults to
   * `playoffs.reseed`). Otherwise the bracket is fixed when it is built, as on Yahoo.
   */
  reseed?: boolean;
}

/** Standard bracket order for `size` (a power of two): 1 v size, and the top two seeds meet last. */
function bracketOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) {
    const n = order.length * 2;
    order = order.flatMap((s) => [s, n + 1 - s]);
  }
  return order;
}

function side(source: BracketSource, teamId: string | null, seed: number | null): BracketSide {
  return { source, teamId, seed, score: null };
}

/**
 * Single-elimination games for `seeds` (best first) finishing in the last of `weeks`. Seeds without
 * a first-round opponent (byes) start in round 2. A fixed bracket names each later side as the
 * winner of an earlier game; with `reseed` the later rounds are paired once the round before ends.
 */
function eliminationGames(
  kind: BracketKind,
  seeds: readonly PlayoffSeed[],
  weeks: readonly number[],
  reseed: boolean
) {
  const rounds = weeks.length;
  const size = 2 ** rounds;
  // Each entry is either a seed index into `seeds` or a game id whose winner fills this spot.
  let spots: Array<BracketSource | null> = bracketOrder(size).map((pos) =>
    pos <= seeds.length ? { type: 'seed', seed: (seeds[pos - 1] as PlayoffSeed).seed } : null
  );
  const byNumber = new Map(seeds.map((s) => [s.seed, s]));
  const games: BracketGame[] = [];
  for (let round = 1; round <= rounds; round++) {
    const next: Array<BracketSource | null> = [];
    for (let i = 0; i < spots.length; i += 2) {
      const a = spots[i] ?? null;
      const b = spots[i + 1] ?? null;
      if (!a || !b) {
        // A bye: the present side advances without playing.
        next.push(a ?? b);
        continue;
      }
      const id = `${kind}-r${round}-g${games.filter((g) => g.round === round).length + 1}`;
      const make = (src: BracketSource): BracketSide => {
        // Reseeded rounds are paired only once the round before them ends (byes included).
        if (reseed && round > 1) return side({ type: 'reseed', round }, null, null);
        if (src.type === 'seed') return side(src, byNumber.get(src.seed)?.teamId ?? null, src.seed);
        return side(src, null, null);
      };
      let home = make(a);
      let away = make(b);
      if (home.seed !== null && away.seed !== null && away.seed < home.seed) [home, away] = [away, home];
      games.push({
        id,
        bracket: kind,
        round,
        week: weeks[round - 1] as number,
        home,
        away,
        winnerTeamId: null,
        decidedBySeed: false
      });
      next.push({ type: 'winner', gameId: id });
    }
    spots = next;
  }
  return games;
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let w = from; w <= to; w++) out.push(w);
  return out;
}

/**
 * Builds the playoff bracket from seeds. Byes go to the top seeds (`playoffs.byes`), rounds run one
 * per week from `playoffs.startWeek` to `playoffs.endWeek`, and the bracket is not reseeded.
 *
 * With `consolation`, the non-playoff teams play their own single-elimination bracket that ends in
 * the same final week (byes to its top seeds as needed).
 */
export function buildBracket(
  settings: PlayoffSettingsInput,
  seeds: readonly PlayoffSeed[],
  options: BracketOptions = {}
): RuleResult<Bracket> {
  const p = settings.playoffs;
  const issues: RuleIssue[] = [];
  const rounds = playoffRounds(p);
  const weeks = range(p.startWeek, p.endWeek);
  if (seeds.length !== p.teams) {
    issues.push(
      ruleError(
        'PLAYOFF_SEED_COUNT_MISMATCH',
        'seeds',
        `The settings call for ${p.teams} playoff teams, but ${seeds.length} seeds were given.`,
        `Pass exactly ${p.teams} seeds (seedPlayoffs returns the right number).`
      )
    );
  }
  if (p.teams < 2) {
    issues.push(
      ruleError(
        'PLAYOFF_TOO_FEW_TEAMS',
        'playoffs.teams',
        `A bracket needs at least 2 teams; the settings have ${p.teams}.`,
        'Set playoffs.teams to 2 or more (4 or 6 are the Yahoo defaults).'
      )
    );
  }
  const byes = requiredByes(p.teams);
  if (p.byes !== byes) {
    issues.push(
      ruleError(
        'PLAYOFF_BYES_INVALID',
        'playoffs.byes',
        `A ${p.teams}-team bracket needs exactly ${byes} first-round bye(s), not ${p.byes}.`,
        `Set playoffs.byes to ${byes}.`
      )
    );
  }
  if (weeks.length !== rounds) {
    issues.push(
      ruleError(
        'PLAYOFF_WEEKS_MISMATCH',
        'playoffs.endWeek',
        `A ${p.teams}-team bracket takes ${rounds} week(s), but weeks ${p.startWeek}-${p.endWeek} span ${Math.max(0, weeks.length)}.`,
        `Set playoffs.endWeek to ${p.startWeek + rounds - 1}.`
      )
    );
  }
  const ids = [...seeds, ...(options.nonPlayoff ?? [])].map((s) => s.teamId);
  const seedNumbers = seeds.map((s) => s.seed);
  if (new Set(ids).size !== ids.length || new Set(seedNumbers).size !== seedNumbers.length) {
    issues.push(
      ruleError(
        'PLAYOFF_DUPLICATE_SEED',
        'seeds',
        'Each team and each seed number may appear only once in the bracket.',
        'Pass the output of seedPlayoffs unchanged.'
      )
    );
  }
  const consolationField = options.nonPlayoff ?? [];
  if (options.consolation && consolationField.length < 2) {
    issues.push(
      ruleError(
        'CONSOLATION_TOO_FEW_TEAMS',
        'nonPlayoff',
        `A consolation bracket needs at least 2 non-playoff teams; got ${consolationField.length}.`,
        'Pass nonPlayoff from seedPlayoffs, or turn the consolation bracket off.'
      )
    );
  }
  if (issues.length > 0) return ruleFail(issues);

  const ordered = [...seeds].sort((a, b) => a.seed - b.seed);
  const reseed = options.reseed ?? p.reseed;
  const games = eliminationGames('championship', ordered, weeks, reseed);
  let consolationFinalGameId: string | null = null;
  let consolationSeeds: PlayoffSeed[] = [];
  if (options.consolation) {
    const field = [...consolationField].sort((a, b) => a.seed - b.seed);
    const cRounds = Math.min(Math.ceil(Math.log2(field.length)), weeks.length);
    // Keep only as many teams as fit in the available weeks; the rest sit out.
    consolationSeeds = field.slice(0, 2 ** cRounds);
    const cGames = eliminationGames(
      'consolation',
      consolationSeeds,
      weeks.slice(weeks.length - cRounds),
      reseed
    );
    games.push(...cGames);
    consolationFinalGameId = (cGames[cGames.length - 1] as BracketGame).id;
  }
  return ruleOk({
    seeds: ordered,
    consolationSeeds,
    reseed,
    weeks,
    games,
    finalGameId: (games.filter((g) => g.bracket === 'championship').pop() as BracketGame).id,
    consolationFinalGameId
  });
}

export interface BracketGameResult {
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number;
  awayScore: number;
}

export interface BracketWeekResults {
  week: number;
  /** Final scores for the week. Results for teams not in a bracket game this week are ignored. */
  results: readonly BracketGameResult[];
}

function fillFrom(game: BracketGame, gameId: string, teamId: string, seed: number | null): BracketGame {
  const fill = (s: BracketSide): BracketSide =>
    s.source.type === 'winner' && s.source.gameId === gameId ? { ...s, teamId, seed } : s;
  let home = fill(game.home);
  let away = fill(game.away);
  if (home.seed !== null && away.seed !== null && away.seed < home.seed) [home, away] = [away, home];
  return { ...game, home, away };
}

/**
 * Records a week's results and moves winners into their next games. A tied playoff game goes to
 * the better (lower-numbered) seed, as on Yahoo.
 *
 * Fails when a game that week has no result yet or its teams are not known (an earlier round was
 * never advanced), or when the week has already been recorded.
 */
export function advanceBracket(bracket: Bracket, weekResults: BracketWeekResults): RuleResult<Bracket> {
  const { week, results } = weekResults;
  const thisWeek = bracket.games.filter((g) => g.week === week);
  if (thisWeek.length === 0) {
    return ruleFail([
      ruleError(
        'NO_PLAYOFF_GAMES_THIS_WEEK',
        'week',
        `The bracket has no games in week ${week}.`,
        `Pass one of the playoff weeks: ${[...new Set(bracket.games.map((g) => g.week))].join(', ')}.`
      )
    ]);
  }
  const issues: RuleIssue[] = [];
  let games = [...bracket.games];
  for (const game of thisWeek) {
    const current = games.find((g) => g.id === game.id) as BracketGame;
    if (current.winnerTeamId !== null) {
      issues.push(
        ruleError(
          'PLAYOFF_GAME_ALREADY_DECIDED',
          game.id,
          `${game.id} (week ${week}) already has a winner.`,
          'Advance each playoff week only once.'
        )
      );
      continue;
    }
    const { home, away } = current;
    if (home.teamId === null || away.teamId === null) {
      issues.push(
        ruleError(
          'PLAYOFF_ROUND_NOT_READY',
          game.id,
          `${game.id} (week ${week}) does not know both teams yet.`,
          `Advance week ${week - 1} first.`
        )
      );
      continue;
    }
    const result = results.find(
      (r) =>
        (r.homeTeamId === home.teamId && r.awayTeamId === away.teamId) ||
        (r.homeTeamId === away.teamId && r.awayTeamId === home.teamId)
    );
    if (!result) {
      issues.push(
        ruleError(
          'PLAYOFF_RESULT_MISSING',
          game.id,
          `No result for ${home.teamId} vs ${away.teamId} in week ${week}.`,
          `Include the final score of ${home.teamId} vs ${away.teamId} in the week's results.`
        )
      );
      continue;
    }
    const swapped = result.homeTeamId !== home.teamId;
    const homeScore = swapped ? result.awayScore : result.homeScore;
    const awayScore = swapped ? result.homeScore : result.awayScore;
    const outcome = matchupResult(homeScore, awayScore).winner;
    // `home` is always the better seed, so a tie goes to home.
    const winnerSide = outcome === 'away' ? away : home;
    const decided: BracketGame = {
      ...current,
      home: { ...home, score: homeScore },
      away: { ...away, score: awayScore },
      winnerTeamId: winnerSide.teamId,
      decidedBySeed: outcome === null
    };
    games = games.map((g) =>
      g.id === current.id ? decided : fillFrom(g, current.id, winnerSide.teamId as string, winnerSide.seed)
    );
  }
  if (issues.length > 0) return ruleFail(issues);
  if (bracket.reseed) games = reseedNextRounds({ ...bracket, games }, thisWeek);
  return ruleOk({ ...bracket, games });
}

/** Seeds that skip the first round of a bracket: in no round-1 game. */
function byeSeeds(bracket: Bracket, kind: BracketKind): PlayoffSeed[] {
  const field = kind === 'championship' ? bracket.seeds : bracket.consolationSeeds;
  const playing = new Set(
    bracket.games
      .filter((g) => g.bracket === kind && g.round === 1)
      .flatMap((g) => [g.home.source, g.away.source])
      .flatMap((src) => (src.type === 'seed' ? [src.seed] : []))
  );
  return field.filter((s) => !playing.has(s.seed));
}

/**
 * Reseeding: once every game of a round is decided, the teams left (winners plus first-round
 * byes) are paired for the next round, the best remaining seed against the worst.
 */
function reseedNextRounds(bracket: Bracket, decidedNow: readonly BracketGame[]): BracketGame[] {
  let games = bracket.games;
  const rounds = new Set(decidedNow.map((g) => `${g.bracket}:${g.round}`));
  for (const key of rounds) {
    const [kind, roundText] = key.split(':') as [BracketKind, string];
    const round = Number(roundText);
    const current = games.filter((g) => g.bracket === kind && g.round === round);
    const next = games
      .filter((g) => g.bracket === kind && g.round === round + 1)
      .sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
    if (next.length === 0 || current.some((g) => g.winnerTeamId === null)) continue;
    const winners = current.map((g) => (g.home.teamId === g.winnerTeamId ? g.home : g.away));
    const alive = [
      ...(round === 1 ? byeSeeds(bracket, kind).map((s) => ({ teamId: s.teamId, seed: s.seed })) : []),
      ...winners.map((w) => ({ teamId: w.teamId as string, seed: w.seed as number }))
    ].sort((a, b) => a.seed - b.seed);
    const paired = new Map(
      next.map((g, i) => {
        const best = alive[i] as { teamId: string; seed: number };
        const worst = alive[alive.length - 1 - i] as { teamId: string; seed: number };
        return [
          g.id,
          {
            ...g,
            home: { ...g.home, teamId: best.teamId, seed: best.seed },
            away: { ...g.away, teamId: worst.teamId, seed: worst.seed }
          }
        ];
      })
    );
    games = games.map((g) => paired.get(g.id) ?? g);
  }
  return games;
}

/** The league champion, or null until the championship game is decided. */
export function champion(bracket: Bracket): string | null {
  return bracket.games.find((g) => g.id === bracket.finalGameId)?.winnerTeamId ?? null;
}

/** The consolation bracket winner, or null when there is none yet. */
export function consolationChampion(bracket: Bracket): string | null {
  if (bracket.consolationFinalGameId === null) return null;
  return bracket.games.find((g) => g.id === bracket.consolationFinalGameId)?.winnerTeamId ?? null;
}
