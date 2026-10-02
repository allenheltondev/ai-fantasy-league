import { useEffect, useState } from 'react';
import { Button, Drawer } from '@readysetcloud/ui';
import { ApiError, type ApiFetch } from '../api';
import type { PlayerRef } from './board';
import { InjuryBadge } from './BestAvailableTable';
import { NflTeamLink } from '../players/NflTeamLink';
import { PlayerHeadshot, TeamLogo } from '../players/PlayerHeadshot';
import { fmt, STAT_NAMES, type PlayerCardData } from './research';
import { RecentGames } from './RecentGames';
import { WeeklyPoints } from './WeeklyPoints';

export interface PlayerCardProps {
  api: ApiFetch;
  leagueId: string;
  player: PlayerRef;
  onClose(): void;
  /** Draft room only: the Queue button (shown when `onQueue` is given) and the Draft button. */
  queued?: boolean;
  queueReady?: boolean;
  onQueue?(player: PlayerRef): void;
  /** True while you are on the clock and the player is still available. */
  canDraft?: boolean;
  picking?: boolean;
  onDraft?(player: PlayerRef): void;
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

/** True when the card has nothing to show: no games this or last season, and no projection at all. */
function noData(card: PlayerCardData): boolean {
  return (
    (card.thisSeason ?? null) === null &&
    card.lastSeason === null &&
    card.projection === null &&
    (card.nextWeek?.points ?? null) === null
  );
}

/** "vs BAL, Sun 1:00 PM" / "at BAL" / "BYE". */
function matchupText(next: NonNullable<PlayerCardData['nextWeek']>): string {
  if (next.bye) return 'BYE';
  if (next.opponent === null) return 'Opponent not scheduled yet';
  const where = `${next.opponent.home ? 'vs' : 'at'} ${next.opponent.team}`;
  if (next.kickoff === null) return where;
  const at = new Date(next.kickoff);
  return `${where}, ${at.toLocaleDateString(undefined, { weekday: 'short' })} ${at.toLocaleTimeString(
    undefined,
    {
      hour: 'numeric',
      minute: '2-digit'
    }
  )}`;
}

/**
 * A player's card in a drawer: this season so far (sparkline, points per game, stat totals), the
 * current week's projection and matchup, last season, the season projection, bye, injury, and
 * recent news. In the draft room it also has Queue and (on the clock) Draft buttons.
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
        <div className="flex items-center gap-3">
          <PlayerHeadshot player={player} size={64} eager />
          <p className="flex flex-wrap items-center gap-x-1 text-muted-foreground">
            {player.position} · <TeamLogo team={player.team} size={18} eager />
            <NflTeamLink team={player.team} leagueId={leagueId} onClick={props.onClose} />
            {card !== null && (
              <>
                {' '}
                · bye {card.bye ?? '—'} <InjuryBadge status={card.injuryStatus} />
              </>
            )}
          </p>
        </div>
        {props.onQueue !== undefined && (
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={props.queueReady === false || props.queued === true}
              onClick={() => props.onQueue?.(player)}
            >
              {props.queued === true ? 'Queued' : 'Queue'}
            </Button>
            {props.canDraft === true && props.onDraft !== undefined && (
              <Button size="sm" loading={props.picking === true} onClick={() => props.onDraft?.(player)}>
                Draft
              </Button>
            )}
          </div>
        )}
        {error !== null && <p role="alert">{error}</p>}
        {card === null && error === null && <p className="text-muted-foreground">Loading…</p>}
        {card !== null && noData(card) && (
          <p
            className="rounded-md border border-border p-3 text-sm text-muted-foreground"
            data-testid="card-no-data"
          >
            No NFL stats or projections for him yet. He is most likely a rookie or a reserve who has not
            played, and no source projects him to.
          </p>
        )}
        {card !== null && (
          <>
            {card.thisSeason != null && (
              <section className="space-y-2" aria-label="This season" data-testid="card-this-season">
                <h4 className="font-semibold">This season ({card.thisSeason.season})</h4>
                <p>
                  <strong>{fmt(card.thisSeason.points)}</strong> pts ·{' '}
                  <strong>{fmt(card.thisSeason.ppg)}</strong> PPG · {card.thisSeason.games} games
                </p>
                {card.thisSeason.weekly.length > 0 && (
                  <WeeklyPoints
                    weekly={card.thisSeason.weekly}
                    average={card.thisSeason.ppg}
                    which="this season"
                    projected={
                      card.nextWeek != null &&
                      !card.nextWeek.bye &&
                      card.nextWeek.points !== null &&
                      !card.thisSeason.weekly.some((w) => w.week === card.nextWeek?.week)
                        ? { week: card.nextWeek.week, points: card.nextWeek.points }
                        : null
                    }
                  />
                )}
                <RecentGames
                  recent={card.thisSeason.recent ?? []}
                  ppg={card.thisSeason.ppg}
                  games={card.thisSeason.games}
                />
                <Totals totals={card.thisSeason.totals} label="This season totals" />
              </section>
            )}
            {card.nextWeek != null && (
              <section className="space-y-2" aria-label="Next game" data-testid="card-next-week">
                <h4 className="font-semibold">Week {card.nextWeek.week}</h4>
                <p className="flex items-center gap-1 text-sm text-muted-foreground">
                  <TeamLogo team={card.nextWeek.opponent?.team} size={16} eager />
                  {matchupText(card.nextWeek)}
                </p>
                {card.nextWeek.bye ? (
                  <p>On bye: no points this week.</p>
                ) : card.nextWeek.points === null ? (
                  <p className="text-muted-foreground">
                    No projection for this week yet
                    {card.thisSeason != null && card.thisSeason.games > 0
                      ? `; he's averaging ${fmt(card.thisSeason.ppg)} pts a game this season.`
                      : '.'}
                  </p>
                ) : (
                  <>
                    <p>
                      <strong>{fmt(card.nextWeek.points)}</strong> projected pts
                    </p>
                    <Totals totals={card.nextWeek.totals} label={`Week ${card.nextWeek.week} projection`} />
                  </>
                )}
              </section>
            )}
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
                  {last.weekly.length > 0 && <WeeklyPoints weekly={last.weekly} average={last.ppg} />}
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
