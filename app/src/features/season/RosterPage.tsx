import { useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { Alert, EmptyState } from '@readysetcloud/ui';
import { useLeagueApi } from '../../api/league';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';
import { useLoad } from '../../lib/useLoad';
import { LoadingSkeleton } from '../../motion/decor';
import { LineupBoard } from './LineupBoard';
import { nextKickoff, useNow, withLocksAt } from './gameState';
import { connectMomentoEvents, useLiveEvents, type EventConnect } from '../../realtime/leagueEvents';

/** The week's games changed (a kickoff, a quarter, a final): the locks may have too (#193). */
const LINEUP_EVENTS = ['NFL Games Updated'] as const;
/** How often the lock countdowns tick; each kickoff also lands exactly on time. */
export const LOCK_TICK_MS = 30_000;

/** My Team › Lineup (#58, #176, #178): your lineup, with projections, drag and drop, and Optimize. */
export function RosterPage({ connect = connectMomentoEvents }: { connect?: EventConnect }) {
  const { leagueId = '' } = useParams();
  const api = useLeagueApi();
  const state = useLoad(() => api.getLeagueState(leagueId), leagueId);

  let body;
  if (state.data === null) {
    body = state.error ? (
      <ApiErrorAlert error={state.error} />
    ) : (
      <LoadingSkeleton label="Loading your team…" />
    );
  } else if (state.data.yourTeam === null) {
    body = <EmptyState title="No team" description="You do not manage a team in this league." />;
  } else {
    body = <LineupEditor leagueId={leagueId} teamId={state.data.yourTeam.id} connect={connect} />;
  }
  return (
    <div data-testid="league-section-roster" className="space-y-4">
      <h2 className="text-xl font-semibold">Lineup</h2>
      {body}
    </div>
  );
}

function LineupEditor({
  leagueId,
  teamId,
  connect
}: {
  leagueId: string;
  teamId: string;
  connect: EventConnect;
}) {
  const api = useLeagueApi();
  const roster = useLoad(() => api.getRoster(leagueId, teamId), `${leagueId}:${teamId}`);
  const [warnings, setWarnings] = useState<{ code: string; message: string }[]>([]);
  // A save that lost the race with a kickoff: who locked, and a fresh board from the server's lineup.
  const [lockRace, setLockRace] = useState<{ names: string[]; round: number } | null>(null);
  useLiveEvents({
    leagueId,
    types: LINEUP_EVENTS,
    global: true,
    realtime: api.getRealtime,
    connect,
    onEvent: () => roster.reload()
  });
  const players = roster.data?.players;
  const now = useNow(LOCK_TICK_MS, (n) => (players === undefined ? null : nextKickoff(players, n)));
  // Players lock at their kickoff without a reload; the server still refuses a locked move.
  const locked = useMemo(
    () => (roster.data === null ? null : { ...roster.data, players: withLocksAt(roster.data.players, now) }),
    [roster.data, now]
  );

  if (roster.data === null) {
    return roster.error ? (
      <ApiErrorAlert error={roster.error} />
    ) : (
      <LoadingSkeleton label="Loading your lineup…" rows={8} />
    );
  }
  const data = locked as NonNullable<typeof locked>;
  if (data.players.length === 0) {
    return (
      <>
        {data.carriedFromWeek !== null && (
          <p className="text-muted-foreground">
            {data.teamName} · Week {data.week} · carried over from week {data.carriedFromWeek}
          </p>
        )}
        <EmptyState title="No players yet" description="Your roster fills in at the draft." />
      </>
    );
  }
  return (
    <div className="space-y-4">
      {lockRace !== null && (
        <Alert variant="error" role="alert">
          <p className="font-medium" data-testid="lock-race">
            {lockRace.names.length === 0
              ? 'A game kicked off before your changes were saved, so nothing was changed.'
              : `${lockRace.names.join(' and ')} ${lockRace.names.length === 1 ? 'is' : 'are'} locked: ${
                  lockRace.names.length === 1 ? 'his game' : 'their games'
                } kicked off before your changes were saved, so nothing was changed.`}
          </p>
          <p className="text-sm">Here is your lineup as it stands now. Make your other moves again.</p>
        </Alert>
      )}
      {warnings.map((w) => (
        <Alert key={`${w.code}:${w.message}`} variant="info">
          {w.message}
        </Alert>
      ))}
      {/* A fresh board for each loaded lineup, so a save starts from what the server kept. */}
      <LineupBoard
        key={`${data.week}:${lockRace?.round ?? 0}:${data.players.map((p) => `${p.player.id}=${p.slot}`).join(',')}`}
        leagueId={leagueId}
        teamId={teamId}
        data={data}
        now={now}
        onSaved={(next) => {
          setWarnings(next);
          setLockRace(null);
          roster.reload();
        }}
        onLocked={(names) => {
          setLockRace((current) => ({ names, round: (current?.round ?? 0) + 1 }));
          roster.reload();
        }}
      />
    </div>
  );
}
