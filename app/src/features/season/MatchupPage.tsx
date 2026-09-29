import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { EmptyState, StatusBadge } from '@readysetcloud/ui';
import { useLeagueApi } from '../../api/league';
import type { MatchupData, MatchupLineup, MatchupSide, RedZoneTeam, ScoringLogEntry } from '../../api/types';
import { ManagerTag } from '../../components/AgentAvatar';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';
import { useLoad } from '../../lib/useLoad';
import {
  connectMomentoEvents,
  useLiveEvents,
  type EventConnect,
  type LeagueEvent
} from '../../realtime/leagueEvents';
import { AnimatedNumber, DeltaFloater } from '../../motion/AnimatedNumber';
import { useCelebrateOnce } from '../../motion/celebration';
import { Confetti } from '../../motion/Confetti';
import { LoadingSkeleton } from '../../motion/decor';
import { MatchupOutlookPanel } from './MatchupOutlookPanel';
import { NflGamesStrip } from './NflGamesStrip';
import { mergeEntries, ScoringLog } from './ScoringLog';
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
  // `?team=` opens another team's matchup (tapped on the league dashboard, #166).
  const [params] = useSearchParams();
  const viewTeam = params.get('team') ?? undefined;
  const api = useLeagueApi();
  // The scoring log (#162): entries pushed with `Scores Updated`, and a bump to reload its newest page.
  const [pushed, setPushed] = useState<{ matchupId: string; entries: ScoringLogEntry[] }[]>([]);
  const [logVersion, setLogVersion] = useState(0);
  const live = useLiveEvents({
    leagueId,
    types: MATCHUP_EVENTS,
    global: true,
    realtime: api.getRealtime,
    connect,
    onEvent: (event) => {
      if (event.detailType === NFL_GAMES_EVENT) return nfl.reload();
      const logs = pushedLog(event);
      if (logs.length > 0) setPushed((current) => [...current, ...logs]);
      else setLogVersion((v) => v + 1);
      loaded.reload();
    }
  });
  const loaded = useLoad(
    () => api.getMatchup(leagueId, viewTeam),
    `${leagueId}:${viewTeam ?? ''}`,
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
      <LoadingSkeleton label="Loading your matchup…" rows={6} />
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
    const leader = leadingTeam(matchup);
    body = (
      <div className="space-y-4">
        <p className="flex items-center gap-2 text-muted-foreground">
          Week {loaded.data.week}
          <StatusBadge tone={matchup.status === 'in_progress' ? 'success' : 'neutral'}>
            {matchup.status === 'in_progress' && <span className="motion-live-dot mr-1" aria-hidden="true" />}
            {STATUS_LABEL[matchup.status]}
          </StatusBadge>
        </p>
        {viewTeam === undefined && <WinCelebration leagueId={leagueId} data={loaded.data} />}
        <div className="grid gap-4 md:grid-cols-2">
          <Side
            side={matchup.home}
            lineup={lineups.home}
            redZone={redZone}
            leading={leader === matchup.home.teamId}
          />
          <Side
            side={matchup.away}
            lineup={lineups.away}
            redZone={redZone}
            leading={leader === matchup.away.teamId}
          />
        </div>
        <ScoringLog
          leagueId={leagueId}
          matchupId={matchup.id}
          myTeamId={loaded.data.teamId}
          teamId={viewTeam}
          sides={[matchup.home, matchup.away]}
          redZone={redZone}
          pushed={mergeEntries(...pushed.filter((p) => p.matchupId === matchup.id).map((p) => p.entries))}
          version={logVersion}
          pollMs={live === 'live' ? MATCHUP_LIVE_POLL_MS : MATCHUP_POLL_MS}
        />
        {nfl.data !== null && <NflGamesStrip data={nfl.data} featured={startedTeams(loaded.data)} />}
      </div>
    );
  }
  return (
    <div data-testid="league-section-matchup" className="space-y-4">
      <h2 className="text-xl font-semibold">Matchup</h2>
      {viewTeam !== undefined && (
        <Link to="." className="text-sm font-medium text-primary-700 hover:underline">
          Back to your matchup
        </Link>
      )}
      {body}
      {viewTeam === undefined && (
        <MatchupOutlookPanel
          leagueId={leagueId}
          pollMs={live === 'live' ? MATCHUP_LIVE_POLL_MS : MATCHUP_POLL_MS}
        />
      )}
    </div>
  );
}

/**
 * The scoring log entries a `Scores Updated` push carries (#162), per matchup. The detail is the
 * server's; anything malformed is dropped rather than shown.
 */
export function pushedLog(event: LeagueEvent): { matchupId: string; entries: ScoringLogEntry[] }[] {
  const logs = event.detail?.scoringLog;
  if (!Array.isArray(logs)) return [];
  return logs.flatMap((log: unknown) => {
    if (typeof log !== 'object' || log === null) return [];
    const { matchupId, entries } = log as { matchupId?: unknown; entries?: unknown };
    if (typeof matchupId !== 'string' || !Array.isArray(entries)) return [];
    const valid = entries.filter(
      (e: unknown): e is ScoringLogEntry =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as ScoringLogEntry).id === 'string' &&
        typeof (e as ScoringLogEntry).points === 'number' &&
        typeof (e as ScoringLogEntry).player?.id === 'string'
    );
    return valid.length > 0 ? [{ matchupId, entries: valid }] : [];
  });
}

/** The NFL teams of the viewer's started players, whose games lead the strip. */
function startedTeams(data: MatchupData): Set<string> {
  const lineups = data.lineups === null ? [] : [data.lineups.home, data.lineups.away];
  const mine = lineups.find((l) => l.teamId === data.teamId);
  return new Set(
    (mine?.players ?? []).flatMap((p) => (isStarter(p.slot) && p.player.team !== null ? [p.player.team] : []))
  );
}

type Matchup = NonNullable<MatchupData['matchup']>;

/** The team ahead once scoring starts, or null before kickoff and on a tie. */
export function leadingTeam(matchup: Matchup): string | null {
  const { home, away } = matchup;
  if (matchup.status === 'scheduled' || home.score === null || away.score === null) return null;
  if (home.score === away.score) return null;
  return home.score > away.score ? home.teamId : away.teamId;
}

/**
 * The first time you open a final you won: confetti and a banner. The banner stays for the visit;
 * the confetti never shows again in this browser (and never under reduced motion).
 */
function WinCelebration({ leagueId, data }: { leagueId: string; data: MatchupData }) {
  const matchup = data.matchup;
  const won = matchup !== null && matchup.status === 'final' && leadingTeam(matchup) === data.teamId;
  const celebrate = useCelebrateOnce(won ? `win:${leagueId}:${matchup.id}` : null);
  if (!celebrate) return null;
  return (
    <>
      <p role="status" className="motion-pop text-lg font-semibold text-success-700">
        You won week {data.week}!
      </p>
      <Confetti size="burst" />
    </>
  );
}

function Side({
  side,
  lineup,
  redZone,
  leading
}: {
  side: MatchupSide;
  lineup: MatchupLineup;
  redZone: readonly RedZoneTeam[];
  leading: boolean;
}) {
  const reducedMotion = usePrefersReducedMotion();
  return (
    <section
      aria-label={side.teamName}
      data-leading={leading || undefined}
      className={`motion-side rounded-lg border border-border p-4${leading ? ' motion-leader' : ''}`}
    >
      <h3 className="flex items-baseline justify-between gap-2 font-semibold">
        <span className="flex min-w-0 flex-col">
          <span className="break-words">{side.teamName}</span>
          <ManagerTag manager={side.manager} teamId={side.teamId} />
        </span>
        <AnimatedNumber className="text-2xl" data-testid={`score-${side.teamId}`} value={side.score ?? 0} />
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
                  <td className="relative w-16 text-right">
                    {p.points ?? '–'}
                    <DeltaFloater value={p.points} />
                  </td>
                </tr>
              );
            })}
        </tbody>
      </table>
    </section>
  );
}
