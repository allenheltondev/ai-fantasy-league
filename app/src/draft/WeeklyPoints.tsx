import { fmt } from './research';

/** Bars get value labels up to this many weeks; a longer season labels only its best week. */
const LABEL_ALL_UP_TO = 10;

export interface ProjectedWeek {
  week: number;
  points: number;
}

/**
 * A player's points by week as a bar chart: one bar per week, labeled with the week number, the
 * points on top, a dashed line at his average (above it bold, below it faded), and a weeks he did
 * not play left as gaps (a bye or a missed game). The coming week's projection is a dashed
 * outline, so a manager sees at a glance what he has done and what he is expected to do.
 */
export function WeeklyPoints({
  weekly,
  average,
  projected = null,
  which = 'last season'
}: {
  weekly: readonly { week: number; points: number }[];
  average: number;
  projected?: ProjectedWeek | null;
  /** Which season, for screen readers: "last season" or "this season". */
  which?: string;
}) {
  const played = new Map(weekly.map((w) => [w.week, w.points]));
  const weeks = [...played.keys(), ...(projected === null ? [] : [projected.week])];
  const first = Math.min(...weeks);
  const last = Math.max(...weeks);
  const columns = Array.from({ length: last - first + 1 }, (_, i) => first + i);
  const top = Math.max(1, ...played.values(), projected?.points ?? 0, average);
  const best = Math.max(...played.values());
  const labelAll = columns.length <= LABEL_ALL_UP_TO;
  const height = (points: number) => `${Math.max(0, (points / top) * 100)}%`;

  const label = `Weekly points ${which}: ${weekly
    .map((w) => `week ${w.week} ${fmt(w.points)}`)
    .join(', ')}${projected === null ? '' : `; week ${projected.week} projected ${fmt(projected.points)}`}`;

  return (
    <figure role="img" aria-label={label} data-testid="weekly-points" className="space-y-1">
      <div aria-hidden="true" className="relative pt-4">
        <div className="relative flex h-20 items-end gap-1 border-b border-border">
          <div
            data-testid="weekly-average"
            className="pointer-events-none absolute inset-x-0 border-t border-dashed border-foreground/50"
            style={{ bottom: height(average) }}
          />
          {columns.map((week) => {
            const points = played.get(week);
            const isProjection = projected !== null && week === projected.week && points === undefined;
            const value = isProjection ? projected.points : points;
            return (
              <div
                key={week}
                data-week={week}
                title={
                  value === undefined
                    ? `Week ${week}: did not play`
                    : `Week ${week}: ${fmt(value)} pts${isProjection ? ' (projected)' : ''}`
                }
                className="relative flex h-full min-w-0 flex-1 items-end"
              >
                {value !== undefined && (
                  <div
                    data-bar={isProjection ? 'projected' : value >= average ? 'above' : 'below'}
                    className={`relative w-full rounded-t-sm ${
                      isProjection
                        ? 'border-2 border-dashed border-primary-500 bg-primary-500/10'
                        : value < 0
                          ? 'bg-error-500'
                          : value >= average
                            ? 'bg-primary-600'
                            : 'bg-primary-300'
                    }`}
                    style={{ height: value < 0 ? '2px' : height(value) }}
                  >
                    {(labelAll || (points === best && !isProjection) || isProjection) && (
                      <span
                        className={`absolute -top-3.5 left-1/2 -translate-x-1/2 text-[0.625rem] leading-none tabular-nums ${
                          points === best ? 'font-bold text-foreground' : 'text-muted-foreground'
                        }`}
                      >
                        {fmt(value)}
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="mt-0.5 flex gap-1 text-[0.625rem] leading-none text-muted-foreground">
          {columns.map((week) => (
            <span key={week} className="min-w-0 flex-1 text-center tabular-nums">
              {week}
            </span>
          ))}
        </div>
      </div>
      <figcaption className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
        <span>Points by week</span>
        <span className="flex items-center gap-1">
          <span aria-hidden="true" className="inline-block w-4 border-t border-dashed border-foreground/50" />
          average {fmt(average)}
        </span>
        {projected !== null && (
          <span className="flex items-center gap-1">
            <span
              aria-hidden="true"
              className="inline-block h-2.5 w-2.5 rounded-sm border-2 border-dashed border-primary-500"
            />
            projected
          </span>
        )}
      </figcaption>
    </figure>
  );
}
