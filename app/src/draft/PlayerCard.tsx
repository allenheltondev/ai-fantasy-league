import { useEffect, useState } from 'react';
import { Button, Drawer } from '@readysetcloud/ui';
import { ApiError, type ApiFetch } from '../api';
import type { PlayerRef } from './board';
import { InjuryBadge } from './BestAvailableTable';
import { fmt, sparklinePoints, STAT_NAMES, type PlayerCardData } from './research';

export interface PlayerCardProps {
  api: ApiFetch;
  leagueId: string;
  player: PlayerRef;
  onClose(): void;
  queued: boolean;
  queueReady?: boolean;
  onQueue(player: PlayerRef): void;
  /** True while you are on the clock and the player is still available. */
  canDraft: boolean;
  picking: boolean;
  onDraft(player: PlayerRef): void;
}

const WIDTH = 240;
const HEIGHT = 48;

/** Last season's weekly points as an inline SVG line, with a dot per game. */
export function Sparkline({ weekly }: { weekly: { week: number; points: number }[] }) {
  const values = weekly.map((w) => w.points);
  const points = sparklinePoints(values, WIDTH, HEIGHT);
  const label = `Weekly points last season: ${weekly.map((w) => `week ${w.week} ${fmt(w.points)}`).join(', ')}`;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`-4 -4 ${WIDTH + 8} ${HEIGHT + 8}`}
      className="h-14 w-full text-primary-800"
      data-testid="sparkline"
    >
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
      {points.split(' ').map((p) => {
        const [x, y] = p.split(',');
        return <circle key={p} cx={x} cy={y} r={2} fill="currentColor" />;
      })}
    </svg>
  );
}

function Totals({ totals, label }: { totals: Record<string, number>; label: string }) {
  return (
    <dl aria-label={label} className="grid grid-cols-3 gap-x-3 gap-y-1 text-sm">
      {Object.entries(totals).map(([key, value]) => (
        <div key={key}>
          <dt className="text-xs text-muted-foreground">{STAT_NAMES[key] ?? key}</dt>
          <dd className="font-medium">{fmt(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A player's research card in a drawer: last season's weekly points (sparkline), stat totals, the
 * season projection, bye, injury, and recent news, with Queue and (on the clock) Draft buttons.
 */
export function PlayerCard(props: PlayerCardProps) {
  const { api, leagueId, player } = props;
  const [card, setCard] = useState<PlayerCardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setCard(null);
    setError(null);
    api<PlayerCardData>('/players/card', { query: { playerId: player.id, leagueId } })
      .then((res) => live && setCard(res.data))
      .catch(
        (e: unknown) => live && setError(e instanceof ApiError ? e.message : 'Could not reach the server.')
      );
    return () => {
      live = false;
    };
  }, [api, leagueId, player.id]);

  const last = card?.lastSeason ?? null;
  return (
    <Drawer
      open
      modal
      hideTab
      side="right"
      size="min(26rem, 100vw)"
      title={player.name}
      titleAs="h3"
      aria-label={`${player.name} player card`}
      onOpenChange={(open) => !open && props.onClose()}
    >
      <div className="space-y-4" data-testid="player-card">
        <p className="text-muted-foreground">
          {player.position} · {player.team ?? 'FA'}
          {card !== null && (
            <>
              {' '}
              · bye {card.bye ?? '—'} <InjuryBadge status={card.injuryStatus} />
            </>
          )}
        </p>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={props.queueReady === false || props.queued}
            onClick={() => props.onQueue(player)}
          >
            {props.queued ? 'Queued' : 'Queue'}
          </Button>
          {props.canDraft && (
            <Button size="sm" loading={props.picking} onClick={() => props.onDraft(player)}>
              Draft
            </Button>
          )}
        </div>
        {error !== null && <p role="alert">{error}</p>}
        {card === null && error === null && <p className="text-muted-foreground">Loading…</p>}
        {card !== null && (
          <>
            <section className="space-y-2">
              <h4 className="font-semibold">{last === null ? 'Last season' : `${last.season} season`}</h4>
              {last === null ? (
                <p className="text-muted-foreground">No stats last season.</p>
              ) : (
                <>
                  <p>
                    <strong>{fmt(last.points)}</strong> pts · <strong>{fmt(last.ppg)}</strong> PPG ·{' '}
                    {last.games} games
                  </p>
                  {last.weekly.length > 0 && <Sparkline weekly={last.weekly} />}
                  <Totals totals={last.totals} label="Last season totals" />
                </>
              )}
            </section>
            <section className="space-y-2">
              <h4 className="font-semibold">Projection</h4>
              {card.projection === null ? (
                <p className="text-muted-foreground">No projection yet.</p>
              ) : (
                <>
                  <p>
                    <strong>{fmt(card.projection.points)}</strong> projected pts ({card.projection.season})
                  </p>
                  <Totals totals={card.projection.totals} label="Projected totals" />
                </>
              )}
            </section>
            <section className="space-y-2">
              <h4 className="font-semibold">News</h4>
              {card.news.length === 0 ? (
                <p className="text-muted-foreground">No recent news.</p>
              ) : (
                <ul aria-label="News" className="space-y-1 text-sm">
                  {card.news.map((n) => (
                    <li key={n.id}>
                      <a href={n.url} target="_blank" rel="noreferrer" className="hover:underline">
                        {n.title}
                      </a>{' '}
                      <span className="text-muted-foreground">
                        {n.source} · {n.publishedAt.slice(0, 10)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {card.scoring.source === 'default' && (
              <p className="text-xs text-muted-foreground">Points use default half-PPR scoring.</p>
            )}
          </>
        )}
      </div>
    </Drawer>
  );
}
