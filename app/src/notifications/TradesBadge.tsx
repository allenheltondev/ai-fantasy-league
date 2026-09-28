import { countLabel } from './types';
import { useNotifications } from './NotificationsContext';

/** The league nav's Trades badge (#165): open offers waiting on your answer. */
export function TradesBadge({ leagueId }: { leagueId: string }) {
  const waiting = useNotifications().offersWaiting(leagueId);
  if (waiting === 0) return null;
  return (
    <span
      key={waiting}
      data-testid="trades-badge"
      aria-label={`${countLabel(waiting)} ${waiting === 1 ? 'offer' : 'offers'} waiting`}
      className="motion-pop ml-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-error-600 px-1 text-xs font-bold leading-none text-white"
    >
      {countLabel(waiting)}
    </span>
  );
}
