import { Button, Drawer, StatusBadge } from '@readysetcloud/ui';
import { useLeagueApi } from '../../api/league';
import type { MarketPlayer } from '../../api/types';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';
import { useLoad } from '../../lib/useLoad';
import { Sparkline } from '../../draft/PlayerCard';
import { gameText } from '../season/gameState';
import { pts, trendOf } from './moves';

/**
 * A market player's card (#205): this week and this season from the market row, then last
 * season's weekly points, the season projection, and the latest headlines (get_player_card, the
 * draft room's research card), with the row's Add or Claim.
 */
export function MarketPlayerCard(props: {
  leagueId: string;
  row: MarketPlayer;
  canAdd: boolean;
  onAdd: (row: MarketPlayer) => void;
  onClose: () => void;
}) {
  const { row } = props;
  const api = useLeagueApi();
  const card = useLoad(
    () => api.getPlayerCard(props.leagueId, row.player.id),
    `${props.leagueId}:${row.player.id}`
  );
  const trend = trendOf(row.trend);
  const claim = row.availability.status === 'waivers';
  const last = card.data?.lastSeason ?? null;
  const stat = (label: string, value: string) => (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
    </div>
  );
  return (
    <Drawer
      open
      modal
      hideTab
      side="right"
      size="min(26rem, 100vw)"
      title={row.player.name}
      titleAs="h2"
      aria-label={`${row.player.name} player card`}
      onOpenChange={(open) => !open && props.onClose()}
    >
      <div className="space-y-4" data-testid="market-card">
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          {row.player.position} · {row.player.team ?? 'FA'}
          {row.byeWeek !== null && ` · Bye ${row.byeWeek}`}
          {row.injuryStatus !== null && <StatusBadge tone="warning">{row.injuryStatus}</StatusBadge>}
        </p>
        <section aria-label="This week and season" className="space-y-2">
          <p className="text-sm">{gameText(row.game)}</p>
          <dl className="grid grid-cols-3 gap-2">
            {stat('Proj this week', pts(row.projectedPoints))}
            {stat('Rest of season', pts(row.projectedRos))}
            {stat('Season avg', pts(row.average))}
          </dl>
          {trend !== null && (
            <p className={`text-sm font-medium ${trend.up ? 'text-success-700' : 'text-error-700'}`}>
              <span aria-hidden="true">{trend.up ? '↑' : '↓'}</span> {trend.text} in fantasy leagues today
            </p>
          )}
        </section>
        {row.availability.status !== 'rostered' && (
          <Button
            variant="primary"
            className="min-h-11 w-full"
            disabled={!props.canAdd}
            onClick={() => props.onAdd(row)}
          >
            {claim ? 'Claim' : 'Add'} {row.player.name}
          </Button>
        )}
        <ApiErrorAlert error={card.error} />
        {card.data !== null && (
          <>
            <section className="space-y-1">
              <h3 className="font-semibold">{last === null ? 'Last season' : `${last.season} season`}</h3>
              {last === null ? (
                <p className="text-sm text-muted-foreground">No stats last season.</p>
              ) : (
                <>
                  <p className="text-sm">
                    {pts(last.points)} pts · {pts(last.ppg)} per game · {last.games} games
                  </p>
                  {last.weekly.length > 1 && <Sparkline weekly={last.weekly} />}
                </>
              )}
            </section>
            <section className="space-y-1">
              <h3 className="font-semibold">Latest news</h3>
              {card.data.news.length === 0 ? (
                <p className="text-sm text-muted-foreground">No recent news.</p>
              ) : (
                <ul aria-label="News" className="space-y-1 text-sm">
                  {card.data.news.map((n) => (
                    <li key={n.id}>
                      <a
                        href={n.url}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium hover:underline"
                      >
                        {n.title}
                      </a>{' '}
                      <span className="text-muted-foreground">{n.source}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </Drawer>
  );
}
