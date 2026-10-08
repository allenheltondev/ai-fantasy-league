import { useState } from 'react';
import { useParams } from 'react-router';
import { useLeagueApi } from '../../api/league';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';
import { useLoad } from '../../lib/useLoad';
import { LoadingSkeleton } from '../../motion/decor';
import { connectLiveEvents, useLiveEvents, type EventConnect } from '../../realtime/leagueEvents';
import { ChampionBanner, DraftCard, MatchupsCard, StandingsCard } from './DashboardCards';
import { MAX_MOVES, MORE_MOVES, MOVES_PAGE, MoveBoard } from './MoveBoard';

/** How often the dashboard refreshes without realtime (free-agent moves send no event either). */
export const DASHBOARD_POLL_MS = 30_000;
/** While live, a slow safety refresh in case an event is missed. */
export const DASHBOARD_LIVE_POLL_MS = 120_000;

/** League events that change what the dashboard shows: scores, results, moves, and the draft. */
export const DASHBOARD_EVENTS = [
  'Scores Updated',
  'Stat Correction Applied',
  'Week Provisionally Final',
  'Week Official Final',
  'Waivers Processed',
  'Trade Processed',
  'Draft Turn Started',
  'Draft Pick Made',
  'Draft Completed',
  'Draft Paused',
  'Draft Resumed'
] as const;

/**
 * The league dashboard (#166): this week's matchups, the standings, and the move board, from one
 * get_league_dashboard read, kept live by the league's realtime events (polling without them).
 * Before the season it shows the draft instead, and after it the champion.
 */
export function LeagueDashboard({
  leagueId,
  connect = connectLiveEvents
}: {
  leagueId: string;
  connect?: EventConnect;
}) {
  const api = useLeagueApi();
  const [moves, setMoves] = useState(MOVES_PAGE);
  const live = useLiveEvents({
    leagueId,
    types: DASHBOARD_EVENTS,
    realtime: api.getRealtime,
    connect,
    onEvent: () => loaded.reload()
  });
  const loaded = useLoad(
    () => api.getLeagueDashboard(leagueId, { moves }),
    `${leagueId}:${moves}`,
    live === 'live' ? DASHBOARD_LIVE_POLL_MS : DASHBOARD_POLL_MS
  );
  const data = loaded.data;
  if (data === null) {
    return loaded.error ? (
      <ApiErrorAlert error={loaded.error} />
    ) : (
      <LoadingSkeleton label="Loading the league dashboard…" rows={6} />
    );
  }
  const preSeason = data.draft !== null;
  return (
    <div data-testid="league-dashboard" className="space-y-4">
      {data.champion !== null && (
        <ChampionBanner
          leagueId={leagueId}
          season={data.season}
          champion={data.champion}
          yourTeamId={data.yourTeamId}
        />
      )}
      {data.draft !== null && <DraftCard leagueId={leagueId} draft={data.draft} />}
      {!preSeason && (
        <MatchupsCard
          leagueId={leagueId}
          week={data.week}
          matchups={data.matchups}
          yourTeamId={data.yourTeamId}
        />
      )}
      {/* Side by side on a wide screen, stacked on a phone. */}
      <div className="grid items-start gap-4 lg:grid-cols-2">
        {data.standings.rows.length > 0 && (
          <StandingsCard
            leagueId={leagueId}
            rows={data.standings.rows}
            throughWeek={data.standings.throughWeek}
            yourTeamId={data.yourTeamId}
          />
        )}
        {(!preSeason || data.moves.length > 0) && (
          <MoveBoard
            leagueId={leagueId}
            moves={data.moves}
            hasMore={data.hasMoreMoves}
            yourTeamId={data.yourTeamId}
            loadingMore={loaded.loading && data.moves.length < moves}
            onShowMore={() => setMoves((n) => Math.min(n + MORE_MOVES, MAX_MOVES))}
          />
        )}
      </div>
    </div>
  );
}

/** The league's Home section (#166), its default route. */
export function LeagueHomePage() {
  const { leagueId = '' } = useParams();
  return (
    <div data-testid="league-section-home" className="space-y-4">
      <LeagueDashboard leagueId={leagueId} />
    </div>
  );
}
