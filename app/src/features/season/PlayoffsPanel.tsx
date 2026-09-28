import { useParams } from 'react-router';
import { EmptyState } from '@readysetcloud/ui';
import { useLeagueApi } from '../../api/league';
import type { BracketGameView, BracketSideView, PlayoffBracketData } from '../../api/types';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';
import { useLoad } from '../../lib/useLoad';
import { useCelebrateOnce } from '../../motion/celebration';
import { Confetti } from '../../motion/Confetti';
import { LoadingSkeleton, Trophy } from '../../motion/decor';
import { useYourTeamId } from '../../routes/leagueContext';

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

const score = (side: BracketSideView) => side.score?.toFixed(2) ?? '-';

/**
 * Your latest playoff moment: the title, or else your most recent championship-bracket win. The
 * key includes the final score so a new season's bracket (same game ids) celebrates afresh.
 */
export function playoffMoment(
  data: PlayoffBracketData,
  yourTeamId: string | null
): { kind: 'title' | 'advance'; key: string } | null {
  if (yourTeamId === null) return null;
  const wins = data.games
    .filter((g) => g.bracket === 'championship' && g.winnerTeamId === yourTeamId)
    .sort((a, b) => b.round - a.round);
  const latest = wins[0];
  if (latest === undefined) return null;
  const key = `${latest.id}:${score(latest.home)}-${score(latest.away)}`;
  return data.championTeamId === yourTeamId
    ? { kind: 'title', key: `title:${key}` }
    : { kind: 'advance', key: `advance:${key}` };
}

/** The bigger moment: a playoff win, or the title, celebrated once per browser. */
function PlayoffCelebration({ leagueId, data }: { leagueId: string; data: PlayoffBracketData }) {
  const moment = playoffMoment(data, useYourTeamId());
  const celebrate = useCelebrateOnce(moment === null ? null : `${leagueId}:${moment.key}`);
  if (!celebrate || moment === null) return null;
  return (
    <>
      <p role="status" className="motion-pop text-lg font-semibold text-success-700">
        {moment.kind === 'title'
          ? 'You are the league champion!'
          : 'You won your playoff game. On to the next round!'}
      </p>
      <Confetti size="big" />
    </>
  );
}

/** The playoff bracket (#78): seeds, byes, games by week, and the champion. */
export function PlayoffsPanel() {
  const { leagueId = '' } = useParams();
  const api = useLeagueApi();
  const loaded = useLoad(() => api.getPlayoffBracket(leagueId), leagueId);
  if (loaded.data === null) {
    return loaded.error ? (
      <ApiErrorAlert error={loaded.error} />
    ) : (
      <LoadingSkeleton label="Loading bracket…" />
    );
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
      <PlayoffCelebration leagueId={leagueId} data={data} />
      {champion && (
        <p role="status" className="flex items-center gap-2 text-lg font-semibold">
          <Trophy className="motion-trophy h-6 w-6" />
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
