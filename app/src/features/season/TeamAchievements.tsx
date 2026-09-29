import type { ReactNode } from 'react';
import { StatusBadge } from '@readysetcloud/ui';
import { useLeagueApi } from '../../api/league';
import { useLoad } from '../../lib/useLoad';

/**
 * A team's achievements (#81, #82) for its team view: each badge it has earned, newest first, with
 * what earned it. Until the team has one (or when history cannot be read) it shows `empty`, if any.
 */
export function TeamAchievements({
  leagueId,
  teamId,
  empty = null
}: {
  leagueId: string;
  teamId: string;
  empty?: ReactNode;
}) {
  const api = useLeagueApi();
  const loaded = useLoad(() => api.getLeagueHistory(leagueId), leagueId);
  const earned = (loaded.data?.achievements ?? []).filter((a) => a.teamId === teamId);
  if (earned.length === 0) return loaded.loading ? null : <>{empty}</>;
  return (
    <section aria-labelledby="team-achievements-title" className="space-y-1" data-testid="team-achievements">
      <h3 id="team-achievements-title" className="text-sm font-medium text-muted-foreground">
        Achievements
      </h3>
      <ul className="flex flex-wrap gap-2" aria-label="Team achievements">
        {earned.map((a) => (
          <li key={a.id} title={a.reason}>
            <StatusBadge tone="success">
              {a.name}
              {a.week === null ? '' : ` · week ${a.week}`}
            </StatusBadge>
          </li>
        ))}
      </ul>
    </section>
  );
}
