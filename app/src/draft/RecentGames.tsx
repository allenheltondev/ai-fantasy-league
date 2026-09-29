import { TeamLogo } from '../players/PlayerHeadshot';
import { fmt, type RecentGame } from './research';

/** Fewer points than this a game is not a trend, whatever his average. */
const TREND_FLOOR = 1.5;
/** How far, as a share of his average, the last games must sit from it to call a trend. */
const TREND_SHARE = 0.15;

export type Trend = 'up' | 'down' | 'steady';

/**
 * Whether his last games are running hot or cold against his season: their average against his
 * points per game, by at least a share of his average (and a floor, so a low scorer's noise is not
 * a trend). Null when the recent games are all of his season, since then they are the average.
 */
export function trendOf(recent: readonly RecentGame[], ppg: number, games: number): Trend | null {
  if (recent.length === 0 || games <= recent.length) return null;
  const average = recent.reduce((sum, g) => sum + g.points, 0) / recent.length;
  const gap = average - ppg;
  const needed = Math.max(TREND_FLOOR, ppg * TREND_SHARE);
  return gap >= needed ? 'up' : gap <= -needed ? 'down' : 'steady';
}

const TREND_TEXT: Record<Trend, string> = {
  up: 'Trending up',
  down: 'Trending down',
  steady: 'Steady'
};
const TREND_MARK: Record<Trend, string> = { up: '▲', down: '▼', steady: '●' };
const TREND_TONE: Record<Trend, string> = {
  up: 'bg-success-100 text-success-800',
  down: 'bg-error-100 text-error-800',
  steady: 'bg-muted text-muted-foreground'
};

/** Touchdowns, yardage, and everything else get their own color, so games compare at a glance. */
function toneOf(stat: string): { dot: string; bar: string } {
  if (stat.endsWith('_td')) return { dot: 'bg-warning-500', bar: 'bg-warning-500' };
  if (stat.endsWith('_yd') || stat.endsWith('_yds')) return { dot: 'bg-primary-600', bar: 'bg-primary-600' };
  return { dot: 'bg-secondary-500', bar: 'bg-secondary-500' };
}

const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmt(Math.abs(n))}`;

function Game({ game, showDelta }: { game: RecentGame; showDelta: boolean }) {
  const earned = game.breakdown.filter((l) => l.points > 0);
  const total = earned.reduce((sum, l) => sum + l.points, 0);
  const delta = game.vsAverage;
  return (
    <li data-testid={`recent-${game.week}`} className="space-y-1.5 rounded-md border border-border p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-sm">
          <span className="font-semibold">Week {game.week}</span>
          {game.opponent !== null && (
            <span className="flex items-center gap-1 text-muted-foreground">
              <TeamLogo team={game.opponent.team} size={16} />
              {game.opponent.home ? 'vs' : 'at'} {game.opponent.team}
            </span>
          )}
        </span>
        <span className="flex items-baseline gap-2">
          {showDelta && delta !== 0 && (
            <span
              className={`rounded px-1 text-xs font-medium ${
                delta > 0 ? 'bg-success-100 text-success-800' : 'bg-error-100 text-error-800'
              }`}
            >
              <span aria-hidden="true">{delta > 0 ? '▲' : '▼'}</span> {fmt(Math.abs(delta))}
              <span className="sr-only"> {delta > 0 ? 'above' : 'below'} his average</span>
            </span>
          )}
          <span className="text-lg font-semibold tabular-nums">
            {fmt(game.points)}
            <span className="ml-0.5 text-xs font-normal text-muted-foreground">pts</span>
          </span>
        </span>
      </div>
      {total > 0 && (
        <div aria-hidden="true" className="flex h-1.5 gap-px overflow-hidden rounded-full bg-muted">
          {earned.map((l) => (
            <span
              key={l.stat}
              className={toneOf(l.stat).bar}
              style={{ width: `${(l.points / total) * 100}%` }}
            />
          ))}
        </div>
      )}
      {game.breakdown.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing that scored.</p>
      ) : (
        <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
          {game.breakdown.map((l) => (
            <li key={l.stat} className="flex items-center gap-1">
              <span
                aria-hidden="true"
                className={`inline-block h-2 w-2 rounded-full ${l.points < 0 ? 'bg-error-500' : l.stat === 'other' ? 'bg-muted-foreground/50' : toneOf(l.stat).dot}`}
              />
              <span className="text-muted-foreground">{l.text}</span>
              <span className={`tabular-nums ${l.points < 0 ? 'text-error-700' : 'font-medium'}`}>
                {signed(l.points)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * His last three games in detail (newest first): each with its opponent, its points and how they
 * compare with his average, a bar of where the points came from (touchdowns, yardage, the rest),
 * and the lines that earned them ("82 rec yds +8.2"). A trend chip says whether he is running
 * hot or cold against his season.
 */
export function RecentGames({
  recent,
  ppg,
  games
}: {
  recent: readonly RecentGame[];
  ppg: number;
  /** Games played this season, for the trend. */
  games: number;
}) {
  if (recent.length === 0) return null;
  const trend = trendOf(recent, ppg, games);
  const average = recent.reduce((sum, g) => sum + g.points, 0) / recent.length;
  return (
    <section aria-label="Recent games" data-testid="recent-games" className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h5 className="text-sm font-semibold">
          {recent.length === 1 ? 'Last game' : `Last ${recent.length} games`}
        </h5>
        {trend !== null && (
          <span
            data-trend={trend}
            className={`rounded px-1.5 py-0.5 text-xs font-medium ${TREND_TONE[trend]}`}
          >
            <span aria-hidden="true">{TREND_MARK[trend]}</span> {TREND_TEXT[trend]} · {fmt(average)} a game vs{' '}
            {fmt(ppg)} on the year
          </span>
        )}
      </div>
      <ol className="space-y-2">
        {recent.map((game) => (
          <Game key={game.week} game={game} showDelta={games > 1} />
        ))}
      </ol>
    </section>
  );
}
