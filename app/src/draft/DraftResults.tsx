import { useEffect, useState } from 'react';
import { ApiError, type ApiFetch } from '../api';

/** `get_draft_report_card` (packages/server/openapi.json). */
export interface DraftReportCard {
  status: 'draft_in_progress' | 'grading' | 'ready';
  source: 'model' | 'computed' | null;
  summary: string | null;
  generatedAt: string | null;
  teams: ReportTeam[];
}

export interface ReportTeam {
  teamId: string;
  teamName: string;
  yours: boolean;
  grade: string;
  headline: string;
  strengths: string[];
  weaknesses: string[];
  analysis: string;
  projectedWins: number;
  projectedLosses: number;
  projectedRank: number;
  projectedPoints: number;
  expectedWins: number;
}

/** How often to look again while the report card is being written, then after a while. */
export const GRADING_POLL_MS = 4000;
export const SLOW_POLL_MS = 15000;
const PATIENCE = 30;

/** Grade letter → badge colors: A green, B blue, C amber, D and F red. */
function gradeTone(grade: string): string {
  switch (grade[0]) {
    case 'A':
      return 'bg-success-100 text-success-800';
    case 'B':
      return 'bg-primary-100 text-primary-800';
    case 'C':
      return 'bg-warning-100 text-warning-800';
    default:
      return 'bg-error-100 text-error-800';
  }
}

/** 1st, 2nd, 3rd, 4th, … 11th, 12th, 13th, … 21st. */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

export function GradeBadge({ grade, size = 'md' }: { grade: string; size?: 'md' | 'lg' }) {
  return (
    <span
      aria-label={`Grade ${grade}`}
      className={`inline-flex shrink-0 items-center justify-center rounded-lg font-bold ${gradeTone(grade)} ${
        size === 'lg' ? 'h-14 w-14 text-2xl' : 'h-8 w-10 text-base'
      }`}
    >
      {grade}
    </span>
  );
}

function TeamReport({ team, open }: { team: ReportTeam; open: boolean }) {
  const record = `${team.projectedWins}-${team.projectedLosses}`;
  return (
    <details
      open={open}
      data-testid={`report-${team.teamId}`}
      className={`group rounded-lg border bg-surface ${team.yours ? 'border-primary-500' : 'border-border'}`}
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 p-3">
        <GradeBadge grade={team.grade} size={team.yours ? 'lg' : 'md'} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">
            {team.teamName}
            {team.yours && <span className="ml-2 text-xs font-medium text-primary-700">Your team</span>}
          </p>
          <p className="text-sm text-muted-foreground">
            Projected {record}, {ordinal(team.projectedRank)} place
          </p>
          <p className="text-sm">{team.headline}</p>
        </div>
      </summary>
      <div className="space-y-3 border-t border-border p-3 text-sm">
        <div className="grid gap-3 sm:grid-cols-2">
          <section aria-label="What went well">
            <h4 className="mb-1 font-semibold text-success-700">What went well</h4>
            <ul className="list-disc space-y-1 pl-5">
              {team.strengths.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </section>
          <section aria-label="What didn't">
            <h4 className="mb-1 font-semibold text-error-700">What didn&apos;t</h4>
            <ul className="list-disc space-y-1 pl-5">
              {team.weaknesses.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </section>
        </div>
        <p>{team.analysis}</p>
        <p className="text-xs text-muted-foreground">
          {team.projectedPoints.toLocaleString()} projected points · {team.expectedWins} expected wins on the
          schedule
        </p>
      </div>
    </details>
  );
}

export interface DraftResultsProps {
  api: ApiFetch;
  leagueId: string;
  /** Poll interval while grading; tests shorten it. */
  pollMs?: number;
}

/**
 * The draft results: an AI-judged report card (a grade from A+ to F- with what went well and what
 * didn't) for every team, and projected standings whose records add up across the league. While the
 * card is being written it says so and checks back.
 */
export function DraftResults({ api, leagueId, pollMs = GRADING_POLL_MS }: DraftResultsProps) {
  const [report, setReport] = useState<DraftReportCard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tries, setTries] = useState(0);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let count = 0;
    const load = () => {
      api<DraftReportCard>(`/leagues/${leagueId}/draft/report-card`)
        .then((res) => {
          if (!live) return;
          setReport(res.data);
          setError(null);
          if (res.data.status !== 'ready') {
            count++;
            setTries(count);
            timer = setTimeout(load, count > PATIENCE ? SLOW_POLL_MS : pollMs);
          }
        })
        .catch((e: unknown) => {
          if (!live) return;
          setError(e instanceof ApiError ? e.message : 'Could not reach the server.');
          timer = setTimeout(load, SLOW_POLL_MS);
        });
    };
    load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, leagueId, pollMs]);

  if (report === null || report.status !== 'ready') {
    if (error !== null && report === null) return <p role="alert">{error}</p>;
    return (
      <div role="status" data-testid="draft-results-grading" className="space-y-1 p-3 text-sm">
        <p className="font-semibold">The analyst is grading every team&apos;s draft…</p>
        <p className="text-muted-foreground">
          {tries > PATIENCE
            ? 'This is taking longer than usual. The report card will show up here when it is ready.'
            : 'Grades and projected standings usually arrive within a minute of the last pick.'}
        </p>
      </div>
    );
  }

  const yours = report.teams.find((t) => t.yours);
  const others = report.teams.filter((t) => !t.yours);
  return (
    <div className="space-y-4" data-testid="draft-results">
      <header className="space-y-1">
        <h3 className="text-lg font-semibold">Draft report card</h3>
        {report.summary !== null && <p className="text-sm">{report.summary}</p>}
        <p className="text-xs text-muted-foreground">
          {report.source === 'model'
            ? 'Graded by the AI analyst. Projected records are reconciled to the schedule, so every win is someone else’s loss.'
            : 'Graded from projections alone (the AI analyst was unavailable). Every win is someone else’s loss.'}
        </p>
      </header>

      {yours !== undefined && <TeamReport team={yours} open />}

      <section aria-label="Projected standings" className="overflow-x-auto">
        <h4 className="mb-2 font-semibold">Projected standings</h4>
        <table aria-label="Projected standings" className="min-w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th scope="col" className="w-10 py-1">
                #
              </th>
              <th scope="col">Team</th>
              <th scope="col" className="px-2">
                Record
              </th>
              <th scope="col" className="px-2">
                Grade
              </th>
              <th scope="col" className="hidden px-2 text-right sm:table-cell">
                Proj. pts
              </th>
            </tr>
          </thead>
          <tbody>
            {report.teams.map((t) => (
              <tr
                key={t.teamId}
                className={`border-t border-border ${t.yours ? 'bg-primary-50 font-semibold' : ''}`}
              >
                <td className="py-1.5">{t.projectedRank}</td>
                <td className="truncate">{t.teamName}</td>
                <td className="px-2 tabular-nums">
                  {t.projectedWins}-{t.projectedLosses}
                </td>
                <td className="px-2">
                  <span className={`rounded px-1.5 py-0.5 text-xs font-bold ${gradeTone(t.grade)}`}>
                    {t.grade}
                  </span>
                </td>
                <td className="hidden px-2 text-right tabular-nums sm:table-cell">
                  {Math.round(t.projectedPoints).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-label="Every team" className="space-y-2">
        <h4 className="font-semibold">Every team</h4>
        {others.map((t) => (
          <TeamReport key={t.teamId} team={t} open={false} />
        ))}
      </section>
    </div>
  );
}
