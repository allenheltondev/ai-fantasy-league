import { Button, StatTile, StatusBadge, type StatusBadgeTone } from '@readysetcloud/ui';
import { useLeagueApi } from '../../api/league';
import type { DataJobRun, DataSeasonSet, DataStatus } from '../../api/types';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';
import { TableScroll } from '../../components/TableScroll';
import { useLoad } from '../../lib/useLoad';

const RUN_STATUS: Record<DataJobRun['status'], { tone: StatusBadgeTone; label: string }> = {
  ok: { tone: 'success', label: 'OK' },
  skipped: { tone: 'neutral', label: 'Skipped' },
  failed: { tone: 'error', label: 'Failed' }
};

const SEASON_TYPES: Record<NonNullable<DataStatus['nflState']>['seasonType'], string> = {
  pre: 'preseason',
  regular: 'regular season',
  post: 'postseason',
  off: 'offseason'
};

/** Which Sleeper endpoint served a projection snapshot (#184). */
const PROJECTION_SOURCES: Record<'v1' | 'app', string> = { v1: 'v1', app: 'app (fallback)' };

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—');

function RunCell({ run }: { run: DataJobRun | null }) {
  if (run === null) return <span className="text-muted-foreground">No run recorded</span>;
  const status = RUN_STATUS[run.status];
  return (
    <span className="flex flex-wrap items-center gap-2">
      <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
      <span>{when(run.finishedAt)}</span>
      {run.reason !== null && <span className="text-muted-foreground">{run.reason.replace(/_/g, ' ')}</span>}
    </span>
  );
}

function SeasonSetRow({ label, set }: { label: string; set: DataSeasonSet | null }) {
  return (
    <tr>
      <th scope="row" className="font-normal">
        {label}
      </th>
      {set === null ? (
        <td colSpan={4} className="text-muted-foreground">
          Not stored
        </td>
      ) : (
        <>
          <td>{set.season}</td>
          <td>{set.players}</td>
          <td>{set.weeks.length}</td>
          <td>{when(set.checkedAt ?? set.updatedAt)}</td>
        </>
      )}
    </tr>
  );
}

/**
 * The commissioner's data status (#181): the NFL data behind projections, research, and scores as
 * the scheduled jobs stored it, and each job's latest run, so an empty page can be traced to a job
 * that skipped, failed, or never ran.
 */
export function DataStatusPanel({ leagueId }: { leagueId: string }) {
  const api = useLeagueApi();
  const loaded = useLoad(() => api.getDataStatus(leagueId), leagueId);

  if (loaded.data === null) {
    return loaded.error ? (
      <ApiErrorAlert error={loaded.error} />
    ) : (
      <p className="text-sm text-muted-foreground">Loading data status…</p>
    );
  }
  const { nflState, players, weeks, research, jobs } = loaded.data;

  return (
    <div className="space-y-6" data-testid="data-status">
      <ApiErrorAlert error={loaded.error} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">Checked {when(loaded.data.checkedAt)}</p>
        <Button size="sm" variant="ghost" loading={loaded.loading} onClick={loaded.reload}>
          Refresh
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile
          label="NFL state"
          value={nflState === null ? 'Not stored' : `${nflState.season} week ${nflState.week}`}
          meta={
            nflState === null
              ? 'Projections and research stay empty until the NFL state job stores it.'
              : `${SEASON_TYPES[nflState.seasonType]} · league season ${nflState.leagueSeason} · updated ${when(nflState.updatedAt)}`
          }
          {...(nflState === null ? { status: { tone: 'error' as const, label: 'Missing' } } : {})}
        />
        <StatTile
          label="Players"
          value={String(players.total)}
          meta={`${players.byPosition.DEF} DEF · ${players.byPosition.K} K`}
        />
        <StatTile
          label="League week"
          value={loaded.data.league.week === null ? 'Not started' : `Week ${loaded.data.league.week}`}
          meta={`Season ${loaded.data.league.season}`}
        />
      </div>

      <section aria-labelledby="data-weeks-title" className="space-y-2">
        <h4 id="data-weeks-title" className="font-semibold">
          Weekly projections and stats
        </h4>
        <TableScroll label="Weekly projections and stats">
          <table className="w-full text-sm" aria-label="Weekly projections and stats">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th scope="col">Week</th>
                <th scope="col">Projections</th>
                <th scope="col">Captured</th>
                <th scope="col">Source</th>
                <th scope="col">Stat lines</th>
              </tr>
            </thead>
            <tbody>
              {weeks.map((w) => (
                <tr key={`${w.season}-${w.week}`}>
                  <th scope="row" className="font-normal">
                    {w.week}
                  </th>
                  <td>{w.projections === null ? 'None' : `${w.projections.count} players`}</td>
                  <td>{when(w.projections?.capturedAt)}</td>
                  <td>{w.projections?.source ? PROJECTION_SOURCES[w.projections.source] : '—'}</td>
                  <td>{w.statLines}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </section>

      <section aria-labelledby="data-research-title" className="space-y-2">
        <h4 id="data-research-title" className="font-semibold">
          Draft research
        </h4>
        <TableScroll label="Draft research">
          <table className="w-full text-sm" aria-label="Draft research">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th scope="col">Set</th>
                <th scope="col">Season</th>
                <th scope="col">Players</th>
                <th scope="col">Weeks</th>
                <th scope="col">Checked</th>
              </tr>
            </thead>
            <tbody>
              <SeasonSetRow label="Last season's stats" set={research.stats} />
              <SeasonSetRow label="Season projections" set={research.projections} />
              {research.currentStats !== undefined && (
                <SeasonSetRow label="This season's stats so far" set={research.currentStats} />
              )}
            </tbody>
          </table>
        </TableScroll>
      </section>

      <section aria-labelledby="data-jobs-title" className="space-y-2">
        <h4 id="data-jobs-title" className="font-semibold">
          Data jobs
        </h4>
        <TableScroll label="Data jobs">
          <table className="w-full text-sm" aria-label="Data jobs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th scope="col">Job</th>
                <th scope="col">Latest run</th>
                <th scope="col">Last OK</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.job}>
                  <th scope="row" className="font-normal">
                    {j.job}
                  </th>
                  <td>
                    <RunCell run={j.latest} />
                  </td>
                  <td>{when(j.lastOk?.finishedAt)}</td>
                  <td className="max-w-md break-words font-mono text-xs">
                    {j.latest?.summary ?? j.lastOk?.summary ?? ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </section>
    </div>
  );
}
