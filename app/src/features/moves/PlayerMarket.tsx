import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Button, Select, StatusBadge } from '@readysetcloud/ui';
import { useLeagueApi } from '../../api/league';
import type { MarketPage, MarketPlayer, MarketSort } from '../../api/types';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';
import { LoadingSkeleton } from '../../motion/decor';
import { useOpenPlayerCard } from '../../players/PlayerLink';
import { gameText } from '../season/gameState';
import { pts, standingText, trendOf } from './moves';

export const MARKET_POSITIONS = ['All', 'QB', 'RB', 'WR', 'TE', 'FLEX', 'K', 'DEF'] as const;

const SORTS: { value: MarketSort; label: string }[] = [
  { value: 'projected_week', label: 'Projected this week' },
  { value: 'projected_ros', label: 'Rest of season' },
  { value: 'season_points', label: 'Season points' },
  { value: 'average', label: 'Average' },
  { value: 'trending', label: 'Trending' }
];

const PAGE = 25;

export interface MarketProps {
  leagueId: string;
  /** "Available players" in the workspace, "All players" on League › Players. */
  title: string;
  /** Leave the heading out: the phone sheet's own title names it. */
  titleHidden?: boolean;
  /** The position to open on ('' for all), e.g. from a roster need. */
  position: string;
  /** Changes with each request for `position`, so asking again resets a changed filter. */
  positionKey?: number;
  /** Start with "Available only" on. */
  availableOnly: boolean;
  teamName: (teamId: string) => string;
  /** Your team's id: your own players show as yours, with no trade link. */
  yourTeamId: string | null;
  canAdd: boolean;
  canTrade: boolean;
  /** Bumped after a move, to read the market again. */
  refreshKey: number;
  onAdd: (row: MarketPlayer) => void;
  tradeHref: (row: MarketPlayer) => string;
  /** The market's league context (FAAB, waiver type, when a drop clears), once loaded. */
  onContext?: (page: MarketPage) => void;
}

/**
 * The player market (#205): available players (or everyone) with this week's projection, game,
 * bye, injury, season average, and the crowd's trend, filtered by position, name, and health,
 * sorted five ways, and paged with Show more. Add or Claim hands the row to the add flow; a
 * rostered player offers a trade instead.
 */
export function PlayerMarket(props: MarketProps) {
  const api = useLeagueApi();
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState(props.position);
  const [sort, setSort] = useState<MarketSort>('projected_week');
  const [healthy, setHealthy] = useState(false);
  const [available, setAvailable] = useState(props.availableOnly);
  const [page, setPage] = useState<MarketPage | null>(null);
  const [rows, setRows] = useState<MarketPlayer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const { leagueId, onContext } = props;

  useEffect(() => setPosition(props.position), [props.position, props.positionKey]);

  const criteria = {
    q: query === '' ? undefined : query,
    position: position === '' ? undefined : position,
    availability: available ? ('available' as const) : ('all' as const),
    healthy: healthy || undefined,
    sort,
    limit: PAGE
  };
  const key = JSON.stringify(criteria);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    api.listLeaguePlayers(leagueId, JSON.parse(key) as typeof criteria).then(
      (next) => {
        if (!live) return;
        setPage(next);
        setRows(next.players);
        setLoading(false);
        onContext?.(next);
      },
      (e: unknown) => {
        if (!live) return;
        setError(e);
        setLoading(false);
      }
    );
    return () => {
      live = false;
    };
    // `api` and `onContext` are stable for a page; the criteria and refreshes decide when to read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leagueId, key, props.refreshKey]);

  const more = (offset: number) => {
    setLoading(true);
    api.listLeaguePlayers(leagueId, { ...criteria, offset }).then(
      (next) => {
        setPage(next);
        setRows((current) => [...current, ...next.players]);
        setLoading(false);
      },
      (e: unknown) => {
        setError(e);
        setLoading(false);
      }
    );
  };

  const search = (e: FormEvent) => {
    e.preventDefault();
    setQuery(draft.trim());
  };

  return (
    <section aria-label={props.title} className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        {props.titleHidden !== true && <h2 className="text-lg font-semibold">{props.title}</h2>}
        {page !== null && (
          <span className="text-sm text-muted-foreground" data-testid="market-count">
            {page.total} {page.total === 1 ? 'player' : 'players'} · week {page.week}
          </span>
        )}
      </div>
      <form role="search" aria-label="Search players" onSubmit={search} className="flex gap-2">
        <input
          type="search"
          aria-label="Player name"
          placeholder="Search by name"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (e.target.value === '') setQuery('');
          }}
          className="input min-h-11 min-w-0 flex-1"
        />
        <Button type="submit" variant="secondary" className="min-h-11">
          Search
        </Button>
      </form>
      <div
        role="group"
        aria-label="Position"
        className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 [scrollbar-width:thin]"
      >
        {MARKET_POSITIONS.map((p) => {
          const value = p === 'All' ? '' : p;
          const on = position === value;
          return (
            <button
              key={p}
              type="button"
              aria-pressed={on}
              onClick={() => setPosition(value)}
              className={`min-h-11 shrink-0 rounded-full border px-4 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500 ${
                on
                  ? 'border-primary-500 bg-primary-100 font-semibold text-primary-800'
                  : 'border-border bg-surface text-foreground hover:bg-muted'
              }`}
            >
              {p}
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
        <Select
          label="Sort by"
          value={sort}
          onChange={(e) => setSort(e.target.value as MarketSort)}
          className="min-h-11"
        >
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" checked={healthy} onChange={(e) => setHealthy(e.target.checked)} />
          Healthy only
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" checked={available} onChange={(e) => setAvailable(e.target.checked)} />
          Available only
        </label>
      </div>
      <ApiErrorAlert error={error} />
      {page === null && loading ? (
        <LoadingSkeleton label="Loading players…" rows={6} />
      ) : rows.length === 0 && error === null ? (
        <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
          No players match. Try another position, or turn off Healthy only.
        </p>
      ) : (
        <ul
          aria-label={props.title}
          className="divide-y divide-border rounded-lg border border-border bg-surface"
        >
          {rows.map((row) => (
            <MarketRow key={row.player.id} row={row} {...props} />
          ))}
        </ul>
      )}
      {page?.nextOffset != null && (
        <Button
          variant="secondary"
          onClick={() => more(page.nextOffset as number)}
          loading={loading}
          loadingLabel="Loading…"
          className="min-h-11 w-full"
        >
          Show more ({page.total - rows.length} more)
        </Button>
      )}
    </section>
  );
}

function MarketRow(props: MarketProps & { row: MarketPlayer }) {
  const openCard = useOpenPlayerCard();
  const { row } = props;
  const { player, availability } = row;
  const trend = trendOf(row.trend);
  const mine = availability.status === 'rostered' && availability.teamId === props.yourTeamId;
  const injured = row.status !== 'active';
  const standing = mine ? 'Your team' : standingText(availability, props.teamName);
  return (
    <li className="flex items-center gap-3 px-3 py-2.5" data-testid={`market-row-${player.id}`}>
      <button
        type="button"
        onClick={() => openCard?.(row.player)}
        aria-haspopup="dialog"
        className="group -my-1 min-h-11 min-w-0 flex-1 rounded-md py-1 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500"
      >
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium group-hover:text-primary-700 group-hover:underline">
            {player.name}
          </span>
          <span className="text-xs text-muted-foreground">
            {player.position} · {player.team ?? 'FA'}
          </span>
          <StatusBadge
            tone={
              availability.status === 'free_agent'
                ? 'success'
                : availability.status === 'waivers'
                  ? 'warning'
                  : 'neutral'
            }
          >
            {standing}
          </StatusBadge>
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span data-testid="market-game">{gameText(row.game)}</span>
          {row.byeWeek !== null && row.game.state !== 'bye' && <span>· Bye {row.byeWeek}</span>}
          {injured && (
            <StatusBadge tone={['questionable', 'doubtful'].includes(row.status) ? 'warning' : 'error'}>
              {row.injuryStatus ?? row.status.toUpperCase()}
            </StatusBadge>
          )}
          {trend !== null && (
            <span
              data-testid="market-trend"
              className={trend.up ? 'font-medium text-success-700' : 'font-medium text-error-700'}
            >
              <span aria-hidden="true">{trend.up ? '↑' : '↓'}</span> {trend.text}
            </span>
          )}
        </span>
      </button>
      <div className="flex shrink-0 flex-col items-end text-right tabular-nums">
        <span className="text-base font-semibold" data-testid="market-projection">
          <span className="sr-only">Projected </span>
          {pts(row.projectedPoints)}
        </span>
        <span className="text-[0.7rem] text-muted-foreground">
          <span aria-hidden="true">avg </span>
          <span className="sr-only">Season average </span>
          {pts(row.average)}
        </span>
      </div>
      <div className="w-20 shrink-0 text-right">
        {availability.status !== 'rostered' ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={!props.canAdd}
            aria-label={`${availability.status === 'waivers' ? 'Claim' : 'Add'} ${player.name}`}
            onClick={() => props.onAdd(row)}
            className="min-h-11 w-full"
          >
            {availability.status === 'waivers' ? 'Claim' : 'Add'}
          </Button>
        ) : !mine && props.canTrade ? (
          <Link
            to={props.tradeHref(row)}
            aria-label={`Propose a trade for ${player.name}`}
            className="inline-flex min-h-11 items-center text-sm font-medium text-primary-700 hover:underline"
          >
            Trade
          </Link>
        ) : null}
      </div>
    </li>
  );
}
