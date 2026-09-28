/**
 * League history (#81) as pure functions: season records (highest and lowest scores, the biggest
 * blowout, the closest game) and head-to-head results between teams, from final matchups. Records
 * cover every final game, playoffs included; head-to-head counts both kinds too.
 */

export interface PlayedGame {
  week: number;
  kind: 'regular' | 'playoff';
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number;
  awayScore: number;
}

export interface TeamWeekScoreRecord {
  teamId: string;
  week: number;
  points: number;
}

export interface MarginRecord {
  week: number;
  kind: 'regular' | 'playoff';
  winnerTeamId: string;
  loserTeamId: string;
  winnerScore: number;
  loserScore: number;
  margin: number;
}

export interface SeasonRecords {
  highestScore: TeamWeekScoreRecord | null;
  lowestScore: TeamWeekScoreRecord | null;
  /** The largest winning margin. */
  biggestBlowout: MarginRecord | null;
  /** The smallest winning margin (ties excluded). */
  closestGame: MarginRecord | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function teamScores(games: readonly PlayedGame[]): TeamWeekScoreRecord[] {
  return games.flatMap((g) => [
    { teamId: g.homeTeamId, week: g.week, points: g.homeScore },
    { teamId: g.awayTeamId, week: g.week, points: g.awayScore }
  ]);
}

function margins(games: readonly PlayedGame[]): MarginRecord[] {
  return games.flatMap((g) => {
    if (g.homeScore === g.awayScore) return [];
    const homeWon = g.homeScore > g.awayScore;
    return [
      {
        week: g.week,
        kind: g.kind,
        winnerTeamId: homeWon ? g.homeTeamId : g.awayTeamId,
        loserTeamId: homeWon ? g.awayTeamId : g.homeTeamId,
        winnerScore: homeWon ? g.homeScore : g.awayScore,
        loserScore: homeWon ? g.awayScore : g.homeScore,
        margin: round2(Math.abs(g.homeScore - g.awayScore))
      }
    ];
  });
}

/** The first item by `better`, ties going to the earlier week and then the smaller team id. */
function best<T extends { week: number }>(
  items: readonly T[],
  better: (a: T, b: T) => number,
  team: (t: T) => string
): T | null {
  const sorted = [...items].sort(
    (a, b) => better(a, b) || a.week - b.week || team(a).localeCompare(team(b))
  );
  return sorted[0] ?? null;
}

export function seasonRecords(games: readonly PlayedGame[]): SeasonRecords {
  const scores = teamScores(games);
  const wins = margins(games);
  return {
    highestScore: best(scores, (a, b) => b.points - a.points, (s) => s.teamId),
    lowestScore: best(scores, (a, b) => a.points - b.points, (s) => s.teamId),
    biggestBlowout: best(wins, (a, b) => b.margin - a.margin, (m) => m.winnerTeamId),
    closestGame: best(wins, (a, b) => a.margin - b.margin, (m) => m.winnerTeamId)
  };
}

export interface HeadToHeadRecord {
  /** The pair, in id order. Wins and points are from `teamId`'s side. */
  teamId: string;
  opponentId: string;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
}

/** Every pair of teams that has played, with the record from the first team's side. */
export function headToHead(games: readonly PlayedGame[]): HeadToHeadRecord[] {
  const pairs = new Map<string, HeadToHeadRecord>();
  for (const g of games) {
    const [a, b] = [g.homeTeamId, g.awayTeamId].sort() as [string, string];
    const aScore = a === g.homeTeamId ? g.homeScore : g.awayScore;
    const bScore = a === g.homeTeamId ? g.awayScore : g.homeScore;
    const key = `${a}\u0000${b}`;
    const row = pairs.get(key) ?? {
      teamId: a,
      opponentId: b,
      wins: 0,
      losses: 0,
      ties: 0,
      pointsFor: 0,
      pointsAgainst: 0
    };
    if (aScore > bScore) row.wins++;
    else if (aScore < bScore) row.losses++;
    else row.ties++;
    row.pointsFor = round2(row.pointsFor + aScore);
    row.pointsAgainst = round2(row.pointsAgainst + bScore);
    pairs.set(key, row);
  }
  return [...pairs.values()].sort(
    (x, y) => x.teamId.localeCompare(y.teamId) || x.opponentId.localeCompare(y.opponentId)
  );
}
