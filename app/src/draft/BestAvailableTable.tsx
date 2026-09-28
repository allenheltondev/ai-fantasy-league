import { Button, Input, StatusBadge } from '@readysetcloud/ui';
import { POSITIONS, type BestAvailableEntry, type PlayerRef } from './board';
import { fmt, type BoardSort } from './research';

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
  onQueue(player: PlayerRef): void;
  /** True while you are on the clock. */
  canDraft: boolean;
  /** The player being drafted right now, if any. */
  picking: string | null;
  onDraft(player: PlayerRef): void;
  /** Opens the player card. */
  onOpen(player: PlayerRef): void;
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

const COLUMNS: { sort: BoardSort | null; label: string; title: string; wide?: boolean }[] = [
  { sort: 'rank', label: 'Rank', title: 'Consensus rank' },
  { sort: 'lastSeasonPoints', label: 'Pts', title: 'Last season fantasy points', wide: true },
  { sort: 'ppg', label: 'PPG', title: 'Last season points per game' },
  { sort: 'projection', label: 'Proj', title: 'Season projection', wide: true },
  { sort: null, label: 'Bye', title: 'Bye week', wide: true }
];

/**
 * Best available players: rank, last season (points and PPG), the projection, bye, and injury,
 * with sortable headers (the server sorts, so the whole pool is considered), position chips, and a
 * sticky header. On narrow screens the stat columns collapse into one line under the name.
 */
export function BestAvailableTable(props: BestAvailableTableProps) {
  const { rows, sort } = props;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <Input label="Search players" value={props.q} onChange={(e) => props.onQuery(e.target.value)} />
        <div role="group" aria-label="Position" className="flex flex-wrap gap-1">
          {['', ...POSITIONS].map((p) => (
            <button
              key={p || 'all'}
              type="button"
              aria-pressed={props.position === p}
              onClick={() => props.onPosition(p)}
              className={`rounded-full border border-border px-3 py-1 text-xs ${
                props.position === p ? 'bg-primary-100 text-primary-800' : 'text-muted-foreground'
              }`}
            >
              {p || 'All'}
            </button>
          ))}
        </div>
      </div>
      <div className="max-h-[32rem] overflow-y-auto">
        <table aria-label="Best available" className="min-w-full text-sm">
          <thead>
            <tr>
              <th scope="col" className="sticky top-0 z-10 bg-background py-2 text-left">
                Player
              </th>
              {COLUMNS.map((c) => (
                <th
                  key={c.label}
                  scope="col"
                  title={c.title}
                  aria-sort={
                    c.sort !== null && c.sort === sort
                      ? sort === 'rank'
                        ? 'ascending'
                        : 'descending'
                      : undefined
                  }
                  className={`sticky top-0 z-10 bg-background px-2 py-2 text-right ${c.wide ? 'hidden sm:table-cell' : 'hidden md:table-cell'}`}
                >
                  {c.sort === null ? (
                    c.label
                  ) : (
                    <button
                      type="button"
                      onClick={() => props.onSort(c.sort as BoardSort)}
                      className={c.sort === sort ? 'font-semibold text-primary-800' : ''}
                      aria-label={`Sort by ${c.title.toLowerCase()}`}
                    >
                      {c.label}
                      {c.sort === sort ? ' ▾' : ''}
                    </button>
                  )}
                </th>
              ))}
              <th scope="col" className="sticky top-0 z-10 bg-background py-2">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) => {
              const { player } = row;
              return (
                <tr key={player.id} data-testid={`available-${player.id}`}>
                  <td className="py-2">
                    <button
                      type="button"
                      className="text-left font-medium hover:underline"
                      onClick={() => props.onOpen(player)}
                    >
                      {player.name}
                    </button>{' '}
                    <InjuryBadge status={row.injuryStatus} />
                    <div className="text-muted-foreground">
                      {player.position} · {player.team ?? 'FA'} · rank {row.rank ?? '—'}
                      <span className="md:hidden" data-testid="compact-stats">
                        {' '}
                        · {fmt(row.lastSeason?.ppg)} PPG · proj {fmt(row.projection?.points)}
                        {row.bye != null && ` · bye ${row.bye}`}
                      </span>
                    </div>
                  </td>
                  <td className="hidden px-2 text-right md:table-cell">{row.rank ?? '—'}</td>
                  <td className="hidden px-2 text-right sm:table-cell">{fmt(row.lastSeason?.points)}</td>
                  <td className="hidden px-2 text-right md:table-cell">{fmt(row.lastSeason?.ppg)}</td>
                  <td className="hidden px-2 text-right sm:table-cell">{fmt(row.projection?.points)}</td>
                  <td className="hidden px-2 text-right sm:table-cell">{row.bye ?? '—'}</td>
                  <td className="py-2 pl-2">
                    <span className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={props.isQueued(player.id)}
                        onClick={() => props.onQueue(player)}
                        aria-label={`Queue ${player.name}`}
                      >
                        Queue
                      </Button>
                      <Button
                        size="sm"
                        disabled={!props.canDraft || props.picking !== null}
                        loading={props.picking === player.id}
                        onClick={() => props.onDraft(player)}
                        aria-label={`Draft ${player.name}`}
                      >
                        Pick
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
