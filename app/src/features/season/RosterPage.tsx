import { useState } from 'react';
import { useParams } from 'react-router';
import { Alert, EmptyState } from '@readysetcloud/ui';
import { useLeagueApi } from '../../api/league';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';
import { useLoad } from '../../lib/useLoad';
import { LoadingSkeleton } from '../../motion/decor';
import { LineupBoard } from './LineupBoard';

/** My Team › Lineup (#58, #176, #178): your lineup, with projections, drag and drop, and Optimize. */
export function RosterPage() {
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
    body = <LineupEditor leagueId={leagueId} teamId={state.data.yourTeam.id} />;
  }
  return (
    <div data-testid="league-section-roster" className="space-y-4">
      <h2 className="text-xl font-semibold">Lineup</h2>
      {body}
    </div>
  );
}

function LineupEditor({ leagueId, teamId }: { leagueId: string; teamId: string }) {
  const api = useLeagueApi();
  const roster = useLoad(() => api.getRoster(leagueId, teamId), `${leagueId}:${teamId}`);
  const [warnings, setWarnings] = useState<{ code: string; message: string }[]>([]);

  if (roster.data === null) {
    return roster.error ? (
      <ApiErrorAlert error={roster.error} />
    ) : (
      <LoadingSkeleton label="Loading your lineup…" rows={8} />
    );
  }
  const data = roster.data;
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
      {warnings.map((w) => (
        <Alert key={`${w.code}:${w.message}`} variant="info">
          {w.message}
        </Alert>
      ))}
      {/* A fresh board for each loaded lineup, so a save starts from what the server kept. */}
      <LineupBoard
        key={`${data.week}:${data.players.map((p) => `${p.player.id}=${p.slot}`).join(',')}`}
        leagueId={leagueId}
        teamId={teamId}
        data={data}
        onSaved={(next) => {
          setWarnings(next);
          roster.reload();
        }}
      />
    </div>
  );
}
