import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useLeagueApi } from '../api/league';
import type { MyLeague } from '../api/types';
import { NotificationBell } from '../notifications/NotificationBell';
import { leaguePath } from '../routes/leagueRoutes';
import { useCurrentLeague } from '../routes/currentLeague';

/** Your leagues, to jump between them; the current one alone until the list loads. */
function LeagueSwitcher({ leagueId, name }: { leagueId: string; name: string }) {
  const api = useLeagueApi();
  const navigate = useNavigate();
  const [leagues, setLeagues] = useState<MyLeague[] | null>(null);
  useEffect(() => {
    let live = true;
    api.listMyLeagues().then(
      (list) => live && setLeagues(list),
      () => undefined
    );
    return () => {
      live = false;
    };
  }, [api]);
  const options = leagues ?? [];
  return (
    <label className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
      <span className="shrink-0 max-sm:sr-only">League</span>
      <select
        className="input min-h-11 min-w-0 max-w-[16rem] truncate py-1.5 text-sm font-medium text-foreground max-sm:text-base"
        value={leagueId}
        onChange={(e) => navigate(leaguePath(e.target.value, 'home'))}
      >
        {!options.some((l) => l.id === leagueId) && <option value={leagueId}>{name}</option>}
        {options.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * The quiet bar above the page (#178): the league switcher inside a league, and the notification
 * bell (#165) everywhere. The side nav carries the sections, so there are no links here.
 */
export function PageHeaderBar({ onOpenNotifications }: { onOpenNotifications: () => void }) {
  const current = useCurrentLeague();
  return (
    <div className="border-b border-border bg-surface">
      <div className="mx-auto flex min-h-14 max-w-[90rem] items-center gap-3 px-[clamp(1rem,4vw,2rem)] py-1.5">
        {current !== null && (
          <LeagueSwitcher leagueId={current.leagueId} name={current.state.data?.name ?? 'League'} />
        )}
        <div className="ml-auto flex items-center">
          <NotificationBell onOpen={onOpenNotifications} className="relative" />
        </div>
      </div>
    </div>
  );
}
