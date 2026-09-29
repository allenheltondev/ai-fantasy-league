import { Link } from 'react-router';
import { Card, CardBody, CardHeader, CardTitle, StatusBadge } from '@readysetcloud/ui';
import type {
  DashboardDraft,
  DashboardMatchup,
  DashboardMatchupSide,
  DashboardStanding,
  DashboardTeam
} from '../../api/types';
import { AnimatedNumber } from '../../motion/AnimatedNumber';
import { Confetti } from '../../motion/Confetti';
import { useCelebrateOnce } from '../../motion/celebration';
import { stagger, Trophy } from '../../motion/decor';
import { leaguePath, leagueTabPath, teamPath } from '../../routes/leagueRoutes';
import { managerName, TeamAvatar } from './TeamBadge';

/** The league dashboard's cards (#166): matchups, standings, the draft, and the champion. */

const STATUS = {
  scheduled: { label: 'Upcoming', tone: 'neutral' },
  in_progress: { label: 'Live', tone: 'success' },
  final: { label: 'Final', tone: 'neutral' }
} as const;

function StatusChip({ status }: { status: DashboardMatchup['status'] }) {
  return (
    <StatusBadge tone={STATUS[status].tone}>
      {status === 'in_progress' && <span className="motion-live-dot mr-1" aria-hidden="true" />}
      {STATUS[status].label}
    </StatusBadge>
  );
}

/** The side ahead once scoring starts; null before kickoff and on a tie. */
export function matchupLeader(m: DashboardMatchup): string | null {
  if (m.status === 'scheduled' || m.home.score === null || m.away.score === null) return null;
  if (m.home.score === m.away.score) return null;
  return m.home.score > m.away.score ? m.home.teamId : m.away.teamId;
}

function SideRow({ side, leading, you }: { side: DashboardMatchupSide; leading: boolean; you: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <TeamAvatar team={side} size={28} />
      <div className="min-w-0 flex-1">
        <p className={`truncate ${leading ? 'font-semibold' : 'font-medium'}`}>
          {side.teamName}
          {you && <span className="sr-only"> (you)</span>}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {managerName(side)}
          {side.record !== null && ` · ${side.record}`}
        </p>
      </div>
      {side.score === null ? (
        <span className="min-w-[6ch] text-right text-muted-foreground">–</span>
      ) : (
        <AnimatedNumber
          value={side.score}
          data-testid={`dashboard-score-${side.teamId}`}
          className={`text-lg ${leading ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}
        />
      )}
    </div>
  );
}

function MatchupTile({
  leagueId,
  matchup,
  yourTeamId
}: {
  leagueId: string;
  matchup: DashboardMatchup;
  yourTeamId: string | null;
}) {
  const yours = yourTeamId !== null && [matchup.home.teamId, matchup.away.teamId].includes(yourTeamId);
  const leader = matchupLeader(matchup);
  const href = yours
    ? teamPath(leagueId, 'matchup')
    : `${teamPath(leagueId, 'matchup')}?team=${encodeURIComponent(matchup.home.teamId)}`;
  return (
    <Link
      to={href}
      data-testid={`dashboard-matchup-${matchup.id}`}
      data-yours={yours || undefined}
      className={`motion-lift block space-y-2 rounded-lg border p-3 transition-colors ${
        yours
          ? 'border-primary-300 bg-primary-50 ring-1 ring-primary-200'
          : 'border-border hover:border-primary-200'
      }`}
    >
      <span className="flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
        <span className={yours ? 'text-primary-700' : undefined}>
          {yours ? 'Your matchup' : matchup.kind === 'playoff' ? 'Playoffs' : 'Matchup'}
        </span>
        <StatusChip status={matchup.status} />
      </span>
      {[matchup.away, matchup.home].map((side) => (
        <SideRow
          key={side.teamId}
          side={side}
          leading={leader === side.teamId}
          you={side.teamId === yourTeamId}
        />
      ))}
    </Link>
  );
}

export function MatchupsCard({
  leagueId,
  week,
  matchups,
  yourTeamId
}: {
  leagueId: string;
  week: number | null;
  matchups: DashboardMatchup[];
  yourTeamId: string | null;
}) {
  // Yours first, then the rest as scheduled.
  const ordered = [...matchups].sort(
    (a, b) => Number(isYours(b, yourTeamId)) - Number(isYours(a, yourTeamId))
  );
  const live = matchups.some((m) => m.status === 'in_progress');
  const done = matchups.length > 0 && matchups.every((m) => m.status === 'final');
  return (
    <Card role="region" aria-label="Matchups">
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>{week === null ? 'Matchups' : `Week ${week} ${done ? 'results' : 'matchups'}`}</CardTitle>
        {live && <StatusChip status="in_progress" />}
      </CardHeader>
      <CardBody>
        {ordered.length === 0 ? (
          <p className="text-muted-foreground">No games this week.</p>
        ) : (
          <ul aria-label="This week's matchups" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {ordered.map((m, i) => (
              <li key={m.id} className={stagger(i).className} style={stagger(i).style}>
                <MatchupTile leagueId={leagueId} matchup={m} yourTeamId={yourTeamId} />
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

const isYours = (m: DashboardMatchup, teamId: string | null) =>
  teamId !== null && (m.home.teamId === teamId || m.away.teamId === teamId);

/** Rows the compact standings show before "…" and your own row. */
export const STANDINGS_TOP = 6;

/** The top rows, plus yours at the end when it is further down. */
export function compactRows(rows: DashboardStanding[], yourTeamId: string | null): DashboardStanding[] {
  const top = rows.slice(0, STANDINGS_TOP);
  const yours = rows.find((r) => r.teamId === yourTeamId);
  return yours === undefined || top.includes(yours) ? top : [...top, yours];
}

export function StandingsCard({
  leagueId,
  rows,
  throughWeek,
  yourTeamId
}: {
  leagueId: string;
  rows: DashboardStanding[];
  throughWeek: number | null;
  yourTeamId: string | null;
}) {
  const shown = compactRows(rows, yourTeamId);
  return (
    <Card role="region" aria-label="Standings">
      <CardHeader>
        <CardTitle>Standings</CardTitle>
        <p className="text-sm text-muted-foreground">
          {throughWeek === null ? 'No games final yet' : `Through week ${throughWeek}`}
        </p>
      </CardHeader>
      <CardBody className="space-y-3">
        <ol aria-label="Standings" className="space-y-1">
          {shown.map((row, i) => {
            const you = row.teamId === yourTeamId;
            const gap = i > 0 && row.rank - (shown[i - 1] as DashboardStanding).rank > 1;
            return (
              <li
                key={row.teamId}
                aria-current={you ? 'true' : undefined}
                className={`grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-x-2 rounded-md px-2 py-1.5 ${
                  you ? 'bg-primary-50 ring-1 ring-primary-200' : ''
                } ${gap ? 'mt-3 border-t border-dashed border-border pt-2' : ''}`}
              >
                <span className="text-sm font-semibold tabular-nums text-muted-foreground">{row.rank}</span>
                <span className="flex min-w-0 items-center gap-2">
                  <TeamAvatar team={row} size={24} />
                  <span className="min-w-0">
                    <span className={`block truncate ${you ? 'font-semibold' : 'font-medium'}`}>
                      {row.teamName}
                      {you && <span className="sr-only"> (you)</span>}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">{managerName(row)}</span>
                  </span>
                </span>
                <span className="text-right">
                  <span className="block font-semibold tabular-nums">{row.record}</span>
                  <span className="block text-xs tabular-nums text-muted-foreground">
                    {row.pointsFor.toFixed(1)} PF{row.streak === null ? '' : ` · ${row.streak}`}
                  </span>
                </span>
              </li>
            );
          })}
        </ol>
        <Link
          to={leagueTabPath(leagueId, 'standings')}
          className="inline-flex min-h-11 items-center text-sm font-medium text-primary-700 hover:underline"
        >
          Full standings
        </Link>
      </CardBody>
    </Card>
  );
}

/** A draft time in the viewer's zone: "Sat, Sep 12, 8:00 PM". */
export function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function Progress({ value, max, label }: { value: number; max: number; label: string }) {
  const percent = Math.round((value / Math.max(max, 1)) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      className="h-2 overflow-hidden rounded-full bg-muted"
    >
      <div
        className="h-full rounded-full bg-primary-500 transition-[width]"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

const CTA =
  'inline-flex min-h-11 items-center rounded-md bg-primary-600 px-4 text-sm font-semibold text-white hover:bg-primary-700';

/** Before the season: when the draft starts and who is missing, or who is on the clock. */
export function DraftCard({ leagueId, draft }: { leagueId: string; draft: DashboardDraft }) {
  const room = leaguePath(leagueId, 'draft');
  if (draft.status === 'not_started') {
    const open = draft.seats - draft.seatsFilled;
    return (
      <Card role="region" aria-label="Draft">
        <CardHeader>
          <CardTitle>Draft day</CardTitle>
          <p className="text-muted-foreground">
            {draft.scheduledAt === null
              ? 'The commissioner starts the draft.'
              : `Starts ${formatWhen(draft.scheduledAt)}`}
          </p>
        </CardHeader>
        <CardBody className="space-y-3">
          <p className="text-sm">
            {draft.seatsFilled} of {draft.seats} seats filled
            {open > 0 && <span className="text-muted-foreground"> · {open} open</span>}
          </p>
          <Progress value={draft.seatsFilled} max={draft.seats} label="Seats filled" />
          <Link to={room} className={CTA}>
            Open the draft lobby
          </Link>
        </CardBody>
      </Card>
    );
  }
  const clock = draft.onTheClock;
  return (
    <Card role="region" aria-label="Draft">
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>{draft.status === 'complete' ? 'The draft is done' : 'The draft is live'}</CardTitle>
        {draft.status === 'paused' ? (
          <StatusBadge tone="warning">Paused</StatusBadge>
        ) : (
          draft.status === 'in_progress' && <StatusChip status="in_progress" />
        )}
      </CardHeader>
      <CardBody className="space-y-3">
        {draft.totalPicks !== null && (
          <>
            <p className="text-sm">
              {draft.picksMade} of {draft.totalPicks} picks made
            </p>
            <Progress value={draft.picksMade} max={draft.totalPicks} label="Picks made" />
          </>
        )}
        {clock !== null && (
          <div className="flex min-w-0 items-center gap-2">
            <TeamAvatar team={clock} size={32} />
            <p className="min-w-0">
              <span className="block text-xs text-muted-foreground">
                On the clock · Round {clock.round}, pick {clock.overall}
              </span>
              <span className="block truncate font-semibold">{clock.teamName}</span>
            </p>
          </div>
        )}
        {draft.yourPickIn === 0 ? (
          <p role="status" className="motion-attention font-semibold text-primary-700">
            You're on the clock!
          </p>
        ) : (
          draft.yourPickIn !== null && (
            <p className="text-sm text-muted-foreground">
              Your pick is {draft.yourPickIn} {draft.yourPickIn === 1 ? 'pick' : 'picks'} away.
            </p>
          )
        )}
        <Link to={room} className={CTA}>
          Go to the draft room
        </Link>
      </CardBody>
    </Card>
  );
}

/** After the final: the champion, with confetti the first time you see your own title. */
export function ChampionBanner({
  leagueId,
  season,
  champion,
  yourTeamId
}: {
  leagueId: string;
  season: number;
  champion: DashboardTeam;
  yourTeamId: string | null;
}) {
  const yours = champion.teamId === yourTeamId;
  const celebrate = useCelebrateOnce(yours ? `champion:${leagueId}:${season}` : null);
  return (
    <section
      aria-label="Champion"
      className="motion-pop flex min-w-0 items-center gap-3 rounded-lg border border-warning-200 bg-warning-50 p-4"
    >
      <Trophy className="motion-trophy h-10 w-10 shrink-0" />
      <TeamAvatar team={champion} size={40} />
      <div className="min-w-0">
        <p className="text-sm text-muted-foreground">{season} champion</p>
        <p className="break-words text-lg font-semibold">{champion.teamName}</p>
        <p className="truncate text-sm text-muted-foreground">
          {yours ? 'That’s you. Congratulations!' : managerName(champion)}
        </p>
      </div>
      {celebrate && <Confetti size="burst" />}
    </section>
  );
}
