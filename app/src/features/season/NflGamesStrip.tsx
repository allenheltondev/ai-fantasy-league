import type { NflGame, NflGamesData } from '../../api/types';
import { RedZoneChip, redZoneClass, usePrefersReducedMotion } from './RedZone';

const STATE_ORDER = { in: 0, pre: 1, post: 2 } as const;

/**
 * Games with the viewer's started players first, then live, upcoming, and final games, each in
 * kickoff order.
 */
export function orderGames(games: readonly NflGame[], featured: ReadonlySet<string>): NflGame[] {
  const mine = (g: NflGame) =>
    (g.homeTeam !== null && featured.has(g.homeTeam)) || (g.awayTeam !== null && featured.has(g.awayTeam))
      ? 0
      : 1;
  return [...games].sort(
    (a, b) =>
      mine(a) - mine(b) ||
      STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
      (a.kickoff ?? '').localeCompare(b.kickoff ?? '')
  );
}

/** `Q3 4:12`, `Final`, or the kickoff (`Sun 1:00 PM`), preferring the feed's own status. */
export function gameStatus(game: NflGame): string {
  if (game.status !== null) return game.status;
  if (game.state === 'post') return 'Final';
  if (game.state === 'in') {
    if (game.period === null) return 'Live';
    const period = game.period > 4 ? 'OT' : `Q${game.period}`;
    return game.clock === null ? period : `${period} ${game.clock}`;
  }
  if (game.kickoff === null) return 'Upcoming';
  return new Date(game.kickoff).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

/** The week's NFL games (#132) as a strip of cards: a horizontal scroller on phones, a grid on wider screens. */
export function NflGamesStrip({ data, featured }: { data: NflGamesData; featured: ReadonlySet<string> }) {
  const reducedMotion = usePrefersReducedMotion();
  if (data.games.length === 0) return null;
  return (
    <section aria-labelledby="nfl-games-heading" data-testid="nfl-games" className="min-w-0 space-y-2">
      <h3 id="nfl-games-heading" className="font-semibold">
        NFL games · week {data.week}
      </h3>
      <ul className="relative flex snap-x gap-3 overflow-x-auto pb-2 sm:grid sm:grid-cols-2 sm:overflow-visible lg:grid-cols-4">
        {orderGames(data.games, featured).map((game) => (
          <li
            key={game.gameId ?? `${game.awayTeam}@${game.homeTeam}`}
            className="w-60 shrink-0 snap-start sm:w-auto"
          >
            <GameCard game={game} reducedMotion={reducedMotion} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function GameCard({ game, reducedMotion }: { game: NflGame; reducedMotion: boolean }) {
  const away = game.awayTeam ?? 'TBD';
  const home = game.homeTeam ?? 'TBD';
  const live = game.state === 'in';
  return (
    <article
      aria-label={`${away} at ${home}`}
      data-testid={`nfl-game-${away}-${home}`}
      data-state={game.state}
      className={`h-full rounded-lg border border-border p-3 text-sm ${game.isRedZone ? redZoneClass('red-zone-card', reducedMotion) : ''}`}
    >
      <TeamLine team={away} score={game.awayScore} hasBall={live && game.possessionTeam === game.awayTeam} />
      <TeamLine team={home} score={game.homeScore} hasBall={live && game.possessionTeam === game.homeTeam} />
      <p className="mt-1 text-xs text-muted-foreground" data-testid="game-status">
        {gameStatus(game)}
      </p>
      {live && game.downDistance !== null && !game.isRedZone && (
        <p className="text-xs" data-testid="down-distance">
          {game.downDistance}
        </p>
      )}
      {game.isRedZone && game.possessionTeam !== null && (
        <RedZoneChip
          className="mt-1"
          zone={{
            team: game.possessionTeam,
            downDistance: game.downDistance,
            fieldPosition: game.fieldPosition
          }}
        />
      )}
      {live && game.possessionTeam !== null && game.yardsToGoal !== null && (
        <FieldBar offense={game.possessionTeam} yardsToGoal={game.yardsToGoal} />
      )}
    </article>
  );
}

function TeamLine({ team, score, hasBall }: { team: string; score: number | null; hasBall: boolean }) {
  return (
    <p className="flex items-center justify-between font-medium">
      <span className="flex items-center gap-1.5">
        {team}
        {hasBall && (
          <>
            <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full bg-warning-600" />
            <span className="sr-only">has the ball</span>
          </>
        )}
      </span>
      <span className="tabular-nums">{score ?? ''}</span>
    </p>
  );
}

/**
 * Where the ball is, drawn from the offense's side: its own goal line on the left, the end zone it
 * attacks on the right, the red zone (the last 20 yards) shaded.
 */
function FieldBar({ offense, yardsToGoal }: { offense: string; yardsToGoal: number }) {
  const at = Math.min(100, Math.max(0, 100 - yardsToGoal));
  return (
    <div
      role="img"
      aria-label={`${offense} ball, ${yardsToGoal} ${yardsToGoal === 1 ? 'yard' : 'yards'} from the end zone`}
      data-testid="field-bar"
      className="relative mt-2 h-2 rounded-full bg-muted"
    >
      <div className="absolute inset-y-0 right-0 w-1/5 rounded-r-full bg-error-500/25" />
      <div
        className="absolute -top-0.5 h-3 w-1.5 -translate-x-1/2 rounded-full bg-foreground"
        style={{ left: `${at}%` }}
      />
    </div>
  );
}
