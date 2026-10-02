import { Button, StatusBadge } from '@readysetcloud/ui';
import { POSITIONS, type BestAvailableEntry, type PlayerRef, type PositionScarcity } from './board';
import { PlayerHeadshot } from '../players/PlayerHeadshot';
import { PositionChip } from './marks';
import { fmt, type BoardSort } from './research';
import type { DraftDensity } from './preferences';

export interface BestAvailableTableProps {
  rows: BestAvailableEntry[];
  sort: BoardSort;
  onSort(sort: BoardSort): void;
  /** '' for every position. */
  position: string;
  onPosition(position: string): void;
  q: string;
  onQuery(q: string): void;
  isQueued(playerId: string): boolean;
  queueReady?: boolean;
  onQueue(player: PlayerRef): void;
  /** True while you are on the clock. */
  canDraft: boolean;
  /** The player being drafted right now, if any. */
  picking: string | null;
  onDraft(player: PlayerRef): void;
  /** Opens the player card. */
  onOpen(player: PlayerRef): void;
  /** Players who will likely be gone before your next pick (#135), flagged in their rows. */
  likelyGone?: ReadonlySet<string>;
  /** Per position, how many of the top 100 are left (shown on the position chips). */
  scarcity?: readonly PositionScarcity[];
  density?: DraftDensity;
  compared?: ReadonlySet<string>;
  onCompare?(player: PlayerRef): void;
}

/** Designations that keep a player out: shown in red, the rest in amber. */
const OUT = new Set(['Out', 'IR', 'PUP', 'Suspended', 'NA']);

export function InjuryBadge({ status }: { status: string | null | undefined }) {
  if (status === null || status === undefined) return null;
  return (
    <StatusBadge tone={OUT.has(status) ? 'error' : 'warning'} title={status}>
      {status === 'Questionable' ? 'Q' : status === 'Doubtful' ? 'D' : status}
    </StatusBadge>
  );
}

interface Column {
  sort: BoardSort | null;
  label: string;
  title: string;
  /** Tailwind classes that hide the column on narrow screens. */
  show: string;
}

const STATS: Column[] = [
  { sort: 'projection', label: 'Proj', title: 'Season projection', show: 'hidden sm:table-cell' },
  { sort: 'ppg', label: 'PPG', title: 'Last season points per game', show: 'hidden sm:table-cell' },
  {
    sort: 'lastSeasonPoints',
    label: 'Pts',
    title: 'Last season fantasy points',
    show: 'hidden xl:table-cell'
  }
];

const TH = 'sticky top-0 z-10 bg-surface px-2 py-1.5 text-xs font-semibold text-muted-foreground';

function SortHeader({
  column,
  sort,
  onSort
}: {
  column: Column;
  sort: BoardSort;
  onSort(s: BoardSort): void;
}) {
  const active = column.sort === sort;
  return (
    <th
      scope="col"
      title={column.title}
      aria-sort={active ? (sort === 'rank' ? 'ascending' : 'descending') : undefined}
      className={`${TH} text-right ${column.show}`}
    >
      {column.sort === null ? (
        column.label
      ) : (
        <button
          type="button"
          onClick={() => onSort(column.sort as BoardSort)}
          className={`whitespace-nowrap rounded px-1 hover:text-foreground ${active ? 'text-primary-800' : ''}`}
          aria-label={`Sort by ${column.title.toLowerCase()}`}
        >
          {column.label}
          <span aria-hidden="true">{active ? (sort === 'rank' ? ' ▴' : ' ▾') : ''}</span>
        </button>
      )}
    </th>
  );
}

/**
 * The best available players, dense and sortable (the server sorts, so the whole pool counts):
 * rank, player, position, team, bye, projection, last season PPG and points. Position chips carry
 * how many of the top 100 are left at each position; a row is flagged when the player will likely
 * be gone before your next pick. Queue (＋) and Draft are one click; the name opens the player card.
 * On a phone the stat columns fold into a line under the name.
 */
export function BestAvailableTable(props: BestAvailableTableProps) {
  const { rows, sort } = props;
  const research = props.density !== 'essentials';
  const left = new Map((props.scarcity ?? []).map((s) => [s.position, s]));
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          aria-label="Search players"
          placeholder="Search players"
          value={props.q}
          onChange={(e) => props.onQuery(e.target.value)}
          className="input min-w-0 flex-1 py-1 sm:w-52 sm:flex-none"
        />
        <select
          aria-label="Sort by"
          value={sort}
          onChange={(e) => props.onSort(e.target.value as BoardSort)}
          className="input w-40 shrink-0"
        >
          <option value="rank">Sort: rank</option>
          <option value="projection">Sort: projection</option>
          <option value="ppg">Sort: last season PPG</option>
          <option value="lastSeasonPoints">Sort: last season points</option>
        </select>
        <div
          role="group"
          aria-label="Position"
          className="-mb-1 flex w-full gap-1 overflow-x-auto pb-1 sm:mb-0 sm:w-auto sm:flex-wrap sm:overflow-visible sm:pb-0"
        >
          {['', ...POSITIONS].map((p) => {
            const s = left.get(p);
            return (
              <button
                key={p || 'all'}
                type="button"
                aria-pressed={props.position === p}
                aria-label={p || 'All'}
                title={s === undefined ? undefined : scarcityTitle(s)}
                onClick={() => props.onPosition(p)}
                className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                  props.position === p
                    ? 'border-primary-500 bg-primary-100 text-primary-800'
                    : 'border-border text-muted-foreground hover:text-foreground'
                }`}
              >
                {p || 'All'}
                {s !== undefined && (
                  <span aria-hidden="true" className="font-mono text-[0.6875rem] opacity-70">
                    {s.left}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border"
        data-testid="available-scroll"
      >
        <table aria-label="Best available" className="w-full text-sm">
          <thead>
            <tr>
              <SortHeader
                column={{ sort: 'rank', label: 'Rk', title: 'Consensus rank', show: 'hidden sm:table-cell' }}
                sort={sort}
                onSort={props.onSort}
              />
              <th scope="col" className={`${TH} w-full text-left`}>
                Player
              </th>
              <th scope="col" className={`${TH} hidden text-left sm:table-cell`}>
                Pos
              </th>
              <th scope="col" className={`${TH} hidden text-left md:table-cell`}>
                Team
              </th>
              <th scope="col" title="Bye week" className={`${TH} hidden text-right md:table-cell`}>
                Bye
              </th>
              {STATS.filter((c) => research || c.sort === 'projection').map((c) => (
                <SortHeader key={c.label} column={c} sort={sort} onSort={props.onSort} />
              ))}
              {research && (
                <th
                  scope="col"
                  title="Games played last season"
                  className={`${TH} hidden text-right xl:table-cell`}
                >
                  GP
                </th>
              )}
              <th scope="col" className={TH}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 && (
              <tr>
                <td colSpan={research ? 10 : 7} className="px-3 py-4 text-center text-muted-foreground">
                  No available players match.
                </td>
              </tr>
            )}
            {rows.map((row) => {
              const { player } = row;
              const gone = props.likelyGone?.has(player.id) === true;
              const queued = props.isQueued(player.id);
              return (
                <tr key={player.id} data-testid={`available-${player.id}`} className="motion-row">
                  <td className="hidden px-2 py-1 text-right font-mono text-xs text-muted-foreground sm:table-cell">
                    {row.rank ?? '—'}
                  </td>
                  <td className="w-full min-w-[10rem] px-2 py-1 sm:min-w-[12rem]">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <PlayerHeadshot player={player} size={28} />
                      <span className="sm:hidden">
                        <PositionChip position={player.position} />
                      </span>
                      <button
                        type="button"
                        className="min-w-0 text-left font-medium hover:underline"
                        onClick={() => props.onOpen(player)}
                      >
                        {player.name}
                      </button>
                      <InjuryBadge status={row.injuryStatus} />
                      {gone && (
                        <span
                          className="h-2 w-2 shrink-0 rounded-full bg-warning-500 sm:h-auto sm:w-auto sm:rounded sm:bg-warning-100 sm:px-1 sm:text-[0.6875rem] sm:font-medium sm:text-warning-800"
                          title="Likely gone before your next pick"
                        >
                          <span className="sr-only sm:not-sr-only">likely gone</span>
                        </span>
                      )}
                    </div>
                    <div
                      className="truncate text-xs text-muted-foreground sm:hidden"
                      data-testid="compact-stats"
                    >
                      #{row.rank ?? '—'} · {player.team ?? 'FA'}
                      {row.bye != null && ` · bye ${row.bye}`} · proj {fmt(row.projection?.points)}
                      {research && ' · '}
                      {research && `${fmt(row.lastSeason?.ppg)} PPG · ${row.lastSeason?.games ?? '—'} GP`}
                    </div>
                    {props.onCompare && (
                      <button
                        type="button"
                        className="min-h-11 text-xs font-medium text-primary-800 sm:hidden"
                        aria-label={`Compare ${player.name}`}
                        aria-pressed={props.compared?.has(player.id) ?? false}
                        disabled={!props.compared?.has(player.id) && (props.compared?.size ?? 0) >= 3}
                        onClick={() => props.onCompare?.(player)}
                      >
                        {props.compared?.has(player.id) ? 'Pinned to research ✓' : 'Compare'}
                      </button>
                    )}
                  </td>
                  <td className="hidden px-2 py-1 sm:table-cell">
                    <PositionChip position={player.position} />
                  </td>
                  <td className="hidden px-2 py-1 text-xs md:table-cell">{player.team ?? 'FA'}</td>
                  <td className="hidden px-2 py-1 text-right text-xs md:table-cell">{row.bye ?? '—'}</td>
                  <td className="hidden px-2 py-1 text-right tabular-nums sm:table-cell">
                    {fmt(row.projection?.points)}
                  </td>
                  {research && (
                    <td className="hidden px-2 py-1 text-right tabular-nums sm:table-cell">
                      {fmt(row.lastSeason?.ppg)}
                    </td>
                  )}
                  {research && (
                    <td className="hidden px-2 py-1 text-right tabular-nums xl:table-cell">
                      {fmt(row.lastSeason?.points)}
                    </td>
                  )}
                  {research && (
                    <td className="hidden px-2 py-1 text-right tabular-nums xl:table-cell">
                      {row.lastSeason?.games ?? '—'}
                    </td>
                  )}
                  <td className="py-1 pl-1 pr-2">
                    <span className="flex justify-end gap-1">
                      {props.onCompare && (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Compare ${player.name}`}
                          aria-pressed={props.compared?.has(player.id) ?? false}
                          disabled={!props.compared?.has(player.id) && (props.compared?.size ?? 0) >= 3}
                          onClick={() => props.onCompare?.(player)}
                          className="hidden sm:inline-flex lg:min-h-0 lg:px-2 lg:py-0.5"
                        >
                          {props.compared?.has(player.id) ? 'Pinned' : 'Compare'}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={props.queueReady === false || queued}
                        onClick={() => props.onQueue(player)}
                        aria-label={`Queue ${player.name}`}
                        title={queued ? 'In your queue' : 'Add to your queue'}
                        className="min-w-11 lg:min-h-0 lg:min-w-0 lg:px-2 lg:py-0.5"
                      >
                        {queued ? '✓' : '＋'}
                      </Button>
                      <Button
                        size="sm"
                        disabled={!props.canDraft || props.picking !== null}
                        loading={props.picking === player.id}
                        onClick={() => props.onDraft(player)}
                        aria-label={`Draft ${player.name}`}
                        className="lg:min-h-0 lg:px-2 lg:py-0.5"
                      >
                        Draft
                      </Button>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function scarcityTitle(s: PositionScarcity): string {
  const gone = s.likelyGone > 0 ? `, ${s.likelyGone} likely gone before your pick` : '';
  return `${s.left} ${s.position} among the 100 best remaining players (unranked positions count the full pool)${gone}`;
}
