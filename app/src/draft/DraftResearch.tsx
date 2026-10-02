import { useEffect, useState } from 'react';
import { Button } from '@readysetcloud/ui';
import { claims } from '@readysetcloud/ui/auth';
import type { ApiFetch } from '../api';
import { PlayerHeadshot } from '../players/PlayerHeadshot';
import { InjuryBadge } from './BestAvailableTable';
import type { PlayerRef } from './board';
import { fmt, STAT_NAMES, type PlayerCardData } from './research';
import { WeeklyPoints } from './WeeklyPoints';

/** Each column keeps its own request alive across picks and refreshes. */
function ResearchColumn({
  player,
  api,
  leagueId,
  drafted,
  queued,
  queueReady,
  canDraft,
  picking,
  onQueue,
  onDraft,
  onRemove
}: {
  player: PlayerRef;
  api: ApiFetch;
  leagueId: string;
  drafted: boolean;
  queued: boolean;
  queueReady: boolean;
  canDraft: boolean;
  picking: string | null;
  onQueue(player: PlayerRef): void;
  onDraft(player: PlayerRef): void;
  onRemove(): void;
}) {
  const [data, setData] = useState<PlayerCardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setData(null);
    setError(null);
    void api<PlayerCardData>('/players/card', { query: { playerId: player.id, leagueId } }).then(
      (res) => {
        if (active) setData(res.data);
      },
      () => {
        if (active) setError('Research could not load. Your draft is still available.');
      }
    );
    return () => {
      active = false;
    };
  }, [api, leagueId, player.id, attempt]);
  return (
    <article
      className="min-w-0 rounded-lg border border-border bg-surface"
      aria-label={`${player.name} research`}
    >
      <header className="sticky top-[var(--draft-clock-height,0px)] z-10 space-y-2 rounded-t-lg border-b border-border bg-surface p-3 lg:top-0">
        <div className="flex items-center gap-2">
          <PlayerHeadshot player={player} size={32} />
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold">{player.name}</h3>
            <p className="text-xs text-muted-foreground">
              {player.position} · {player.team ?? 'FA'} · Bye {data?.bye ?? '—'}
            </p>
          </div>
          <button
            type="button"
            className="rounded p-2 text-muted-foreground hover:bg-muted"
            onClick={onRemove}
            aria-label={`Remove ${player.name} from research`}
          >
            ×
          </button>
        </div>
        {drafted ? (
          <p role="status" className="rounded bg-muted px-2 py-1 text-sm font-medium">
            Drafted · research kept for reference
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={!queueReady || queued}
              onClick={() => onQueue(player)}
            >
              {queued ? 'Queued ✓' : '＋ Queue'}
            </Button>
            <Button
              size="sm"
              disabled={!canDraft || picking !== null}
              loading={picking === player.id}
              onClick={() => onDraft(player)}
            >
              Draft {player.name}
            </Button>
          </div>
        )}
      </header>
      <div className="space-y-4 p-3 text-sm">
        {error !== null && (
          <div role="alert">
            <p>{error}</p>
            <Button size="sm" variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
              Retry research
            </Button>
          </div>
        )}
        {data === null && error === null && <p className="text-muted-foreground">Loading research…</p>}
        {data !== null && (
          <>
            <dl className="divide-y divide-border" aria-label="Comparable player metrics">
              {[
                ['Consensus rank', data.player.rank == null ? 'Unranked' : `#${data.player.rank}`],
                [
                  `Season projection${data.projection ? ` · ${data.projection.season}` : ''}`,
                  data.projection == null ? 'Not available' : `${fmt(data.projection.points)} pts`
                ],
                [
                  'Last season PPG',
                  data.lastSeason == null
                    ? 'Not available'
                    : `${fmt(data.lastSeason.ppg)} · ${data.lastSeason.games} games`
                ],
                [
                  'This season PPG',
                  data.thisSeason == null
                    ? 'Not available'
                    : `${fmt(data.thisSeason.ppg)} · ${data.thisSeason.games} games`
                ],
                ['Health designation', data.injuryStatus ?? 'None reported']
              ].map(([label, value]) => (
                <div key={label} className="flex flex-wrap justify-between gap-x-2 py-2">
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="font-medium tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
            <p className="text-xs text-muted-foreground">
              {data.scoring.source === 'league'
                ? 'Points use your league scoring.'
                : 'Points use default half-PPR scoring.'}{' '}
              Season projections are full-season totals.
            </p>
            <section aria-label="Latest news" className="space-y-2">
              <h4 className="flex items-center gap-2 font-semibold">
                Latest news <InjuryBadge status={data.injuryStatus} />
              </h4>
              {data.news.length === 0 ? (
                <p className="text-muted-foreground">No recent news available.</p>
              ) : (
                <ul className="space-y-3">
                  {data.news.slice(0, 3).map((n) => (
                    <li key={n.id}>
                      <a
                        className="font-medium hover:underline"
                        href={n.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {n.title}
                      </a>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {n.source} · {n.publishedAt.slice(0, 10)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <details className="border-t border-border pt-3">
              <summary className="cursor-pointer font-medium">Weekly production & stat detail</summary>
              <div className="mt-3 space-y-4">
                {data.nextWeek != null && (
                  <section>
                    <h4 className="font-medium">Week {data.nextWeek.week}</h4>
                    <p>
                      {data.nextWeek.bye
                        ? 'On bye'
                        : `${data.nextWeek.opponent ? `${data.nextWeek.opponent.home ? 'vs' : 'at'} ${data.nextWeek.opponent.team}` : 'Matchup unavailable'} · ${data.nextWeek.points == null ? 'No weekly projection' : `${fmt(data.nextWeek.points)} projected pts`}`}
                    </p>
                  </section>
                )}
                {data.thisSeason != null && (
                  <section>
                    <h4 className="font-medium">This season · {data.thisSeason.season}</h4>
                    <WeeklyPoints
                      weekly={data.thisSeason.weekly}
                      average={data.thisSeason.ppg}
                      which="this season"
                    />
                    <StatTotals totals={data.thisSeason.totals} />
                  </section>
                )}
                {data.lastSeason != null && (
                  <section>
                    <h4 className="font-medium">Last season · {data.lastSeason.season}</h4>
                    <WeeklyPoints weekly={data.lastSeason.weekly} average={data.lastSeason.ppg} />
                    <StatTotals totals={data.lastSeason.totals} />
                  </section>
                )}
                {data.projection != null && (
                  <section>
                    <h4 className="font-medium">Projected season totals</h4>
                    <StatTotals totals={data.projection.totals} />
                  </section>
                )}
                {data.thisSeason == null && data.lastSeason == null && data.projection == null && (
                  <p className="text-muted-foreground">No production data available yet.</p>
                )}
              </div>
            </details>
          </>
        )}
        <PrivateNote noteId={`${leagueId}:${player.id}`} playerName={player.name} />
      </div>
    </article>
  );
}

/**
 * A note kept in this browser for one league and player. Scoped to the signed-in account, so another
 * manager who signs in on the same device never sees it.
 */
function PrivateNote({ noteId, playerName }: { noteId: string; playerName: string }) {
  const storageKey = `fantasy:draft-note:${claims().sub ?? 'signed-out'}:${noteId}`;
  const inputId = `draft-note-${noteId}`;
  const [note, setNote] = useState(() => {
    try {
      return localStorage.getItem(storageKey) ?? '';
    } catch {
      return '';
    }
  });
  const [saved, setSaved] = useState(true);
  return (
    <details className="border-t border-border pt-3" open={note.length > 0 ? true : undefined}>
      <summary className="cursor-pointer font-medium">Private notes</summary>
      <label className="sr-only" htmlFor={inputId}>
        Notes for {playerName}
      </label>
      <textarea
        id={inputId}
        value={note}
        maxLength={2000}
        rows={3}
        placeholder="Your take, a reminder, a reason to wait…"
        className="mt-2 w-full resize-y rounded-md border border-border bg-background p-2 text-sm"
        onChange={(event) => {
          const next = event.target.value;
          setNote(next);
          try {
            localStorage.setItem(storageKey, next);
            setSaved(true);
          } catch {
            setSaved(false);
          }
        }}
      />
      <p className="mt-1 text-xs text-muted-foreground">
        {saved
          ? 'Saved on this device only. Never shared in chat.'
          : 'Device storage is unavailable. Keep this page open to retain your note.'}
      </p>
    </details>
  );
}

function StatTotals({ totals }: { totals: Record<string, number> }) {
  return (
    <dl className="mt-2 grid grid-cols-2 gap-2">
      {Object.entries(totals).map(([key, value]) => (
        <div key={key}>
          <dt className="text-xs text-muted-foreground">{STAT_NAMES[key] ?? key}</dt>
          <dd className="tabular-nums">{fmt(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function DraftResearch({
  players,
  onShare,
  ...props
}: {
  players: PlayerRef[];
  api: ApiFetch;
  leagueId: string;
  drafted: ReadonlySet<string>;
  isQueued(id: string): boolean;
  queueReady: boolean;
  canDraft: boolean;
  picking: string | null;
  onQueue(player: PlayerRef): void;
  onDraft(player: PlayerRef): void;
  onRemove(id: string): void;
  onShare?(players: PlayerRef[]): void;
}) {
  if (players.length === 0)
    return (
      <div className="mx-auto max-w-md px-4 py-12 text-center">
        <h3 className="text-lg font-semibold">Find your next difference-maker.</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          Open a player or use Compare in the player list. Keep up to three candidates here while the draft
          unfolds.
        </p>
      </div>
    );
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">Your research stays here as picks come in.</p>
        {onShare && (
          <Button variant="ghost" size="sm" onClick={() => onShare(players)}>
            Discuss in chat →
          </Button>
        )}
      </div>
      <div
        className={`grid items-start gap-3 ${players.length === 1 ? 'mx-auto max-w-2xl' : 'grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))]'}`}
      >
        {players.map((player) => (
          <ResearchColumn
            key={`${props.leagueId}:${player.id}`}
            {...props}
            player={player}
            drafted={props.drafted.has(player.id)}
            queued={props.isQueued(player.id)}
            onRemove={() => props.onRemove(player.id)}
          />
        ))}
      </div>
    </div>
  );
}
