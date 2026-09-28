import { useParams } from 'react-router';
import { EmptyState, LoadingPage } from '@readysetcloud/ui';
import { useLeagueApi } from '../../api/league';
import type { BracketGameView, BracketSideView, PlayoffBracketData } from '../../api/types';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';
import { useLoad } from '../../lib/useLoad';

const STATUS_TEXT: Record<PlayoffBracketData['status'], string> = {
  not_started: 'The bracket is seeded once the regular season ends.',
  projected: 'Projected: the bracket if the regular season ended today.',
  in_progress: 'Playoffs in progress.',
  complete: 'Playoffs complete.'
};

function Side({ side, won }: { side: BracketSideView; won: boolean }) {
  return (
    <li className={`flex justify-between gap-2 ${won ? 'font-semibold' : ''}`}>
      <span>
        {side.seed !== null && <span className="mr-1 text-muted-foreground">({side.seed})</span>}
        {side.teamName ?? <span className="italic text-muted-foreground">{side.from}</span>}
      </span>
      <span className="tabular-nums">{side.score === null ? '' : side.score.toFixed(2)}</span>
    </li>
  );
}

function Game({ game }: { game: BracketGameView }) {
  return (
    <div className="rounded-md border border-border p-2 text-sm" data-testid={`bracket-game-${game.id}`}>
      <ul className="space-y-1" aria-label={`Game ${game.id}`}>
        <Side side={game.home} won={game.winnerTeamId !== null && game.winnerTeamId === game.home.teamId} />
        <Side side={game.away} won={game.winnerTeamId !== null && game.winnerTeamId === game.away.teamId} />
      </ul>
      {game.decidedBySeed && (
        <p className="mt-1 text-xs text-muted-foreground">Tie: the better seed advances.</p>
      )}
    </div>
  );
}

function Bracket({ title, games }: { title: string; games: BracketGameView[] }) {
  const weeks = [...new Set(games.map((g) => g.week))].sort((a, b) => a - b);
  return (
    <section aria-label={title} className="space-y-2">
      <h3 className="font-semibold">{title}</h3>
      <div className="grid gap-4 sm:grid-cols-3">
        {weeks.map((week) => (
          <div key={week} className="space-y-2">
            <h4 className="text-sm text-muted-foreground">Week {week}</h4>
            {games
              .filter((g) => g.week === week)
              .map((g) => (
                <Game key={g.id} game={g} />
              ))}
          </div>
        ))}
      </div>
    </section>
  );
}

/** The playoff bracket (#78): seeds, byes, games by week, and the champion. */
export function PlayoffsPanel() {
  const { leagueId = '' } = useParams();
  const api = useLeagueApi();
  const loaded = useLoad(() => api.getPlayoffBracket(leagueId), leagueId);
  if (loaded.data === null) {
    return loaded.error ? <ApiErrorAlert error={loaded.error} /> : <LoadingPage text="Loading bracket…" />;
  }
  const data = loaded.data;
  if (data.games.length === 0) {
    return <EmptyState title="No bracket yet" description={STATUS_TEXT[data.status]} />;
  }
  const champion = data.seeds.find((s) => s.teamId === data.championTeamId);
  return (
    <div className="space-y-4">
      <p className="text-muted-foreground">
        {STATUS_TEXT[data.status]} {data.teams} teams, {data.byes} bye{data.byes === 1 ? '' : 's'},{' '}
        {data.reseed ? 'reseeded each round' : 'fixed bracket'}.
      </p>
      {champion && (
        <p role="status" className="text-lg font-semibold">
          Champion: {champion.teamName}
        </p>
      )}
      <Bracket title="Championship bracket" games={data.games.filter((g) => g.bracket === 'championship')} />
      {data.games.some((g) => g.bracket === 'consolation') && (
        <Bracket title="Consolation bracket" games={data.games.filter((g) => g.bracket === 'consolation')} />
      )}
    </div>
  );
}
