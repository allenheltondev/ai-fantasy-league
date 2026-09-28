import { useParams } from 'react-router';
import { EmptyState, LoadingPage, StatusBadge } from '@readysetcloud/ui';
import { useLeagueApi } from '../../api/league';
import type { MatchupData, MatchupLineup, MatchupSide, RedZoneTeam } from '../../api/types';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';
import { useLoad } from '../../lib/useLoad';
import { connectMomentoEvents, useLiveEvents, type EventConnect } from '../../realtime/leagueEvents';
import { MatchupOutlookPanel } from './MatchupOutlookPanel';
import { NflGamesStrip } from './NflGamesStrip';
import { RedZoneChip, redZoneClass, redZoneFor, usePrefersReducedMotion } from './RedZone';
import { isStarter } from './slots';

/** How often live scores refresh without realtime. The server recomputes them on every read. */
export const MATCHUP_POLL_MS = 30_000;
/** While live, a slow safety refresh in case an event is missed. */
export const MATCHUP_LIVE_POLL_MS = 120_000;

/** The week's NFL games changed (scores, possession, the red zone); on the global topic (#132). */
export const NFL_GAMES_EVENT = 'NFL Games Updated';

/**
 * Events that change the matchup. `Scores Updated` and `NFL Games Updated` come from the live jobs
 * on the global topic (they name no league); the rest on the league topic.
 */
export const MATCHUP_EVENTS = [
  NFL_GAMES_EVENT,
  'Scores Updated',
  'Stat Correction Applied',
  'Week Provisionally Final',
  'Week Official Final'
] as const;

const STATUS_LABEL = { scheduled: 'Upcoming', in_progress: 'Live', final: 'Final' } as const;

/** The Matchup section (#58): both lineups side by side with live scores. */
export function MatchupPage({ connect = connectMomentoEvents }: { connect?: EventConnect }) {
  const { leagueId = '' } = useParams();
  const api = useLeagueApi();
  const live = useLiveEvents({
    leagueId,
    types: MATCHUP_EVENTS,
    global: true,
    realtime: api.getRealtime,
    connect,
    onEvent: (event) => (event.detailType === NFL_GAMES_EVENT ? nfl.reload() : loaded.reload())
  });
  const loaded = useLoad(
    () => api.getMatchup(leagueId),
    leagueId,
    live === 'live' ? MATCHUP_LIVE_POLL_MS : MATCHUP_POLL_MS
  );
  // The NFL games strip and red-zone highlights are extras: while they load or fail, the matchup shows without them.
  const nfl = useLoad(
    () => api.getNflGames(leagueId),
    leagueId,
    live === 'live' ? MATCHUP_LIVE_POLL_MS : MATCHUP_POLL_MS
  );
  const redZone = nfl.data?.redZone ?? [];

  let body;
  if (loaded.data === null) {
    body = loaded.error ? (
      <ApiErrorAlert error={loaded.error} />
    ) : (
      <LoadingPage text="Loading your matchup…" />
    );
  } else if (loaded.data.matchup === null || loaded.data.lineups === null) {
    body = (
      <EmptyState
        title={`No matchup in week ${loaded.data.week}`}
        description="Check back once the schedule is set."
      />
    );
  } else {
    const { matchup, lineups } = loaded.data;
    body = (
      <div className="space-y-4">
        <p className="flex items-center gap-2 text-muted-foreground">
          Week {loaded.data.week}
          <StatusBadge tone={matchup.status === 'in_progress' ? 'success' : 'neutral'}>
            {STATUS_LABEL[matchup.status]}
          </StatusBadge>
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          <Side side={matchup.home} lineup={lineups.home} redZone={redZone} />
          <Side side={matchup.away} lineup={lineups.away} redZone={redZone} />
        </div>
        {nfl.data !== null && <NflGamesStrip data={nfl.data} featured={startedTeams(loaded.data)} />}
      </div>
    );
  }
  return (
    <div data-testid="league-section-matchup" className="space-y-4">
      <h2 className="text-xl font-semibold">Matchup</h2>
      {body}
      <MatchupOutlookPanel
        leagueId={leagueId}
        pollMs={live === 'live' ? MATCHUP_LIVE_POLL_MS : MATCHUP_POLL_MS}
      />
    </div>
  );
}

/** The NFL teams of the viewer's started players, whose games lead the strip. */
function startedTeams(data: MatchupData): Set<string> {
  const lineups = data.lineups === null ? [] : [data.lineups.home, data.lineups.away];
  const mine = lineups.find((l) => l.teamId === data.teamId);
  return new Set(
    (mine?.players ?? []).flatMap((p) => (isStarter(p.slot) && p.player.team !== null ? [p.player.team] : []))
  );
}

function Side({
  side,
  lineup,
  redZone
}: {
  side: MatchupSide;
  lineup: MatchupLineup;
  redZone: readonly RedZoneTeam[];
}) {
  const reducedMotion = usePrefersReducedMotion();
  return (
    <section aria-label={side.teamName} className="rounded-lg border border-border p-4">
      <h3 className="flex items-baseline justify-between font-semibold">
        <span>{side.teamName}</span>
        <span className="text-2xl" data-testid={`score-${side.teamId}`}>
          {(side.score ?? 0).toFixed(2)}
        </span>
      </h3>
      <table className="mt-2 w-full text-sm">
        <tbody>
          {lineup.players
            .filter((p) => isStarter(p.slot))
            .map((p) => {
              const zone = redZoneFor(p, redZone);
              return (
                <tr
                  key={p.player.id}
                  data-testid={`matchup-row-${p.player.id}`}
                  className={zone === null ? undefined : redZoneClass('red-zone-row', reducedMotion)}
                >
                  <td className="w-16 font-mono">{p.slot}</td>
                  <td>
                    {p.player.name} <span className="text-muted-foreground">{p.player.team ?? 'FA'}</span>
                    {zone !== null && <RedZoneChip zone={zone} />}
                  </td>
                  <td className="text-right text-muted-foreground">{p.projectedPoints ?? '–'}</td>
                  <td className="w-16 text-right">{p.points ?? '–'}</td>
                </tr>
              );
            })}
        </tbody>
      </table>
    </section>
  );
}
