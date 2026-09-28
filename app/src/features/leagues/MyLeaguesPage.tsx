import { Link } from 'react-router';
import {
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorState,
  SkeletonLoader,
  StatusBadge,
  type StatusBadgeTone
} from '@readysetcloud/ui';
import { useLeagueApi } from '../../api/league';
import type { MyLeague, Phase } from '../../api/types';
import { errorText } from '../../components/ApiErrorAlert';
import { useLoad } from '../../lib/useLoad';

export const PHASE_LABELS: Record<Phase, { label: string; tone: StatusBadgeTone }> = {
  setup: { label: 'Setup', tone: 'primary' },
  drafting: { label: 'Drafting', tone: 'warning' },
  regular_season: { label: 'Regular season', tone: 'success' },
  playoffs: { label: 'Playoffs', tone: 'success' },
  complete: { label: 'Complete', tone: 'neutral' }
};

export function weekLabel(league: Pick<MyLeague, 'week' | 'startWeek'>): string {
  return league.week === null ? `Starts week ${league.startWeek}` : `Week ${league.week}`;
}

/** Setup happens in Settings; afterwards the league opens on its default section. */
export function leagueHref(league: Pick<MyLeague, 'id' | 'phase'>): string {
  return league.phase === 'setup' ? `/leagues/${league.id}/settings` : `/leagues/${league.id}`;
}

const CreateButton = () => (
  <Link to="/leagues/new">
    <Button variant="primary">Create a league</Button>
  </Link>
);

export function MyLeaguesPage() {
  const api = useLeagueApi();
  const leagues = useLoad(() => api.listMyLeagues(), 'mine');

  return (
    <section aria-labelledby="home-title" className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 id="home-title" className="text-2xl font-semibold">
          My Leagues
        </h1>
        {leagues.data !== null && leagues.data.length > 0 && <CreateButton />}
      </div>
      {leagues.error !== null ? (
        <ErrorState
          heading="Could not load your leagues"
          message={errorText(leagues.error).message}
          action={{ label: 'Try again', onClick: leagues.reload }}
        />
      ) : leagues.data === null ? (
        <SkeletonLoader count={3} />
      ) : leagues.data.length === 0 ? (
        <EmptyState
          title="No leagues yet"
          description="Create a league, invite friends, and fill the other seats with AI managers."
          action={<CreateButton />}
        />
      ) : (
        <ul className="grid gap-4 md:grid-cols-2" aria-label="Leagues">
          {leagues.data.map((league) => (
            <li key={league.id}>
              <LeagueCard league={league} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function LeagueCard({ league }: { league: MyLeague }) {
  const phase = PHASE_LABELS[league.phase];
  return (
    <Card>
      <CardBody className="space-y-2">
        <div className="flex items-start justify-between gap-2">
          <Link to={leagueHref(league)} className="font-display text-lg font-semibold hover:underline">
            {league.name}
          </Link>
          <StatusBadge tone={phase.tone}>{phase.label}</StatusBadge>
        </div>
        <p className="text-sm text-muted-foreground">
          {league.season} season · {league.teamCount} teams · {weekLabel(league)}
        </p>
        <p className="text-sm">
          Record: <span className="font-medium">{league.record ?? '—'}</span>
          {league.youAreCommissioner && <span className="ml-2 text-muted-foreground">· Commissioner</span>}
        </p>
      </CardBody>
    </Card>
  );
}
