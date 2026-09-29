import { useMemo, useState } from 'react';
import { Button, SegmentedControl } from '@readysetcloud/ui';
import { useLeagueApi } from '../../api/league';
import type { MatchupSide, RedZoneTeam, ScoringLogEntry } from '../../api/types';
import { AgentAvatar } from '../../components/AgentAvatar';
import { useTeamAvatarSeed } from '../../routes/leagueTeams';
import { useLoad } from '../../lib/useLoad';
import { useArrivals } from '../../motion/useArrivals';
import { RedZoneChip, redZoneClass, redZoneFor, usePrefersReducedMotion } from './RedZone';
import './scoringLog.css';
import { PlayerLink } from '../../players/PlayerLink';

/** Entries per page. */
export const SCORING_LOG_PAGE = 20;

export type LogFilter = 'both' | 'mine' | 'theirs';

/** The entry's play description (#164), if it has a usable one. */
export function playText(entry: ScoringLogEntry): string | null {
  const text = entry.play?.text;
  return typeof text === 'string' && text.trim() !== '' ? text : null;
}

/**
 * Merges log entries from pages and live pushes: one per id, newest first. Entry ids are
 * `<at>#<playerId>`, so id order is time order. The first copy of an entry wins, unless a later
 * one has the play description it lacks (#164).
 */
export function mergeEntries(...lists: readonly (readonly ScoringLogEntry[])[]): ScoringLogEntry[] {
  const byId = new Map<string, ScoringLogEntry>();
  for (const list of lists) {
    for (const e of list) {
      const kept = byId.get(e.id);
      if (kept === undefined || (playText(kept) === null && playText(e) !== null)) byId.set(e.id, e);
    }
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? 1 : -1));
}

/** The entries a filter shows: both teams, the viewer's, or the opponent's; the bench on request. */
export function filterEntries(
  entries: readonly ScoringLogEntry[],
  filter: LogFilter,
  myTeamId: string,
  includeBench: boolean
): ScoringLogEntry[] {
  return entries.filter(
    (e) =>
      (includeBench || e.starter) &&
      (filter === 'both' || (filter === 'mine' ? e.teamId === myTeamId : e.teamId !== myTeamId))
  );
}

/** "+7.80", "-0.20". */
export const formatPoints = (points: number) => `${points > 0 ? '+' : ''}${points.toFixed(2)}`;

const TIME = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

interface OlderPages {
  bench: boolean;
  entries: ScoringLogEntry[];
  cursor: string | null;
}

/**
 * The matchup's scoring log (#162): every scoring change for both lineups, newest first, filled by
 * the live stats. New entries (from a poll, or pushed with `Scores Updated`) pop in; touchdowns
 * stand out, and a player whose team is in the red zone right now carries the red-zone highlight on
 * his latest entry (#132). A touchdown or field goal shows ESPN's play description under its stats
 * when the server matched one (#164). Filter by team, include the bench, and load older plays a page at a time.
 */
export function ScoringLog({
  leagueId,
  matchupId,
  myTeamId,
  teamId,
  sides,
  redZone,
  pushed,
  version,
  pollMs
}: {
  leagueId: string;
  matchupId: string;
  myTeamId: string;
  /** Another team's matchup (`?team=`); your own when left out. */
  teamId?: string | undefined;
  sides: readonly MatchupSide[];
  redZone: readonly RedZoneTeam[];
  /** Entries pushed live for this matchup (merged by id). */
  pushed: readonly ScoringLogEntry[];
  /** Bumped when a matchup event arrives, to reload the newest page. */
  version: number;
  pollMs: number;
}) {
  const api = useLeagueApi();
  const [filter, setFilter] = useState<LogFilter>('both');
  const [includeBench, setIncludeBench] = useState(false);
  const [older, setOlder] = useState<OlderPages>({ bench: false, entries: [], cursor: null });
  const [loadingOlder, setLoadingOlder] = useState(false);
  const team = teamId === undefined ? {} : { teamId };
  const newest = useLoad(
    () => api.getScoringLog(leagueId, { includeBench, limit: SCORING_LOG_PAGE, ...team }),
    `${leagueId}:${matchupId}:${includeBench}:${version}`,
    pollMs
  );
  const olderPages: OlderPages =
    older.bench === includeBench ? older : { bench: includeBench, entries: [], cursor: null };
  // A page for another matchup (the week just rolled over) is stale; a page with none is empty.
  const data = newest.data;
  const firstPage = data !== null && (data.matchupId === matchupId || data.matchupId === null) ? data : null;
  const olderEntries = olderPages.entries;
  const merged = useMemo(
    () => mergeEntries(pushed, firstPage?.entries ?? [], olderEntries),
    [pushed, firstPage, olderEntries]
  );
  const cursor = olderEntries.length > 0 ? olderPages.cursor : (firstPage?.nextCursor ?? null);
  const shown = filterEntries(merged, filter, myTeamId, includeBench);
  const arrived = useArrivals(firstPage === null ? null : merged.map((e) => e.id));
  const reducedMotion = usePrefersReducedMotion();
  // Only a player's latest entry carries the red-zone highlight: he is near another score.
  const latest = new Set<string>();
  const players = new Set<string>();
  for (const e of merged) {
    if (players.has(e.player.id)) continue;
    players.add(e.player.id);
    latest.add(e.id);
  }

  const loadOlder = async (from: string) => {
    setLoadingOlder(true);
    try {
      const page = await api.getScoringLog(leagueId, {
        includeBench,
        limit: SCORING_LOG_PAGE,
        cursor: from,
        ...team
      });
      setOlder({ bench: includeBench, entries: [...olderEntries, ...page.entries], cursor: page.nextCursor });
    } catch {
      // The button stays; the next tap tries again.
    } finally {
      setLoadingOlder(false);
    }
  };

  const side = (teamId: string) => sides.find((s) => s.teamId === teamId);
  const filteredName = sides
    .filter((s) => (s.teamId === myTeamId) === (filter === 'mine'))
    .map((s) => s.teamName)
    .join(' or ');

  let body;
  if (firstPage === null) {
    body =
      newest.error === null ? (
        <p className="mt-2 text-sm text-muted-foreground">Loading the scoring log…</p>
      ) : (
        <p role="alert" className="mt-2 text-sm text-error-700">
          The scoring log could not load. It will try again shortly.
        </p>
      );
  } else if (shown.length === 0) {
    body = (
      <p className="mt-2 text-sm text-muted-foreground">
        {merged.length === 0
          ? 'No scoring yet. Every play that moves a score shows up here as it happens.'
          : `No scoring for ${filteredName} yet.`}
      </p>
    );
  } else {
    body = (
      <ol aria-label="Scoring plays, newest first" className="mt-2 space-y-2">
        {shown.map((entry) => (
          <LogRow
            key={entry.id}
            entry={entry}
            side={side(entry.teamId)}
            mine={entry.teamId === myTeamId}
            isNew={arrived(entry.id)}
            zone={latest.has(entry.id) ? redZoneFor(entry, redZone) : null}
            reducedMotion={reducedMotion}
          />
        ))}
      </ol>
    );
  }

  return (
    <section
      aria-labelledby="scoring-log-heading"
      data-testid="scoring-log"
      className="motion-side rounded-lg border border-border p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="scoring-log-heading" className="font-semibold">
          Scoring log
        </h3>
        <SegmentedControl
          aria-label="Show scoring for"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'both', label: 'Both' },
            { value: 'mine', label: 'Mine' },
            { value: 'theirs', label: 'Theirs' }
          ]}
        />
      </div>
      <label className="mt-2 flex min-h-11 w-fit items-center gap-2 text-sm text-muted-foreground">
        <input
          type="checkbox"
          className="h-5 w-5"
          checked={includeBench}
          onChange={(e) => setIncludeBench(e.target.checked)}
        />
        Include bench
      </label>
      {body}
      {firstPage !== null && cursor !== null && (
        <Button
          variant="secondary"
          className="mt-3 w-full"
          onClick={() => loadOlder(cursor)}
          disabled={loadingOlder}
        >
          {loadingOlder ? 'Loading…' : 'Show older plays'}
        </Button>
      )}
    </section>
  );
}

function LogRow({
  entry,
  side,
  mine,
  isNew,
  zone,
  reducedMotion
}: {
  entry: ScoringLogEntry;
  side: MatchupSide | undefined;
  mine: boolean;
  isNew: boolean;
  zone: RedZoneTeam | null;
  reducedMotion: boolean;
}) {
  const classes = [
    'scoring-log-row flex items-start gap-3 rounded-md border border-border p-2',
    entry.touchdown ? 'scoring-log-td' : '',
    zone !== null ? redZoneClass('red-zone-card', reducedMotion) : '',
    isNew ? 'motion-pop' : ''
  ]
    .filter(Boolean)
    .join(' ');
  const teamName = entry.teamName;
  const play = playText(entry);
  return (
    <li
      data-testid={`log-entry-${entry.player.id}`}
      data-touchdown={entry.touchdown || undefined}
      data-new={isNew || undefined}
      className={classes}
    >
      <TeamMark side={side} teamName={teamName} mine={mine} />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <PlayerLink player={entry.player} className="break-words font-medium" />
          <span className="text-xs text-muted-foreground">
            {entry.player.position} · {entry.player.team ?? 'FA'}
          </span>
          {entry.touchdown && (
            <span className="rounded-full bg-success-100 px-2 py-0.5 text-xs font-bold text-success-700">
              Touchdown
            </span>
          )}
          {entry.kind === 'correction' && (
            <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
              Stat correction
            </span>
          )}
          {!entry.starter && (
            <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
              Bench
            </span>
          )}
          {zone !== null && <RedZoneChip zone={zone} className="" />}
        </p>
        <p className="break-words text-sm">{entry.summary}</p>
        {play !== null && (
          <p data-testid="log-play" className="break-words text-sm italic text-muted-foreground">
            {play}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          <time dateTime={entry.at}>{TIME.format(new Date(entry.at))}</time>
          <span aria-hidden="true"> · </span>
          <span>{teamName}</span>
        </p>
      </div>
      <span
        data-testid="log-points"
        className={`shrink-0 font-semibold tabular-nums ${entry.points < 0 ? 'text-error-700' : 'text-success-700'}`}
      >
        {formatPoints(entry.points)}
      </span>
    </li>
  );
}

/** The team's AI manager avatar (#159), its person's picked avatar (#178), or its initial; your side gets a ring. */
function TeamMark({
  side,
  teamName,
  mine
}: {
  side: MatchupSide | undefined;
  teamName: string;
  mine: boolean;
}) {
  const ring = mine ? ' ring-2 ring-primary-500' : '';
  const manager = side?.manager ?? null;
  const picked = useTeamAvatarSeed(side?.teamId);
  if (manager === null && picked !== null) {
    return (
      <span className={`shrink-0 rounded-lg${ring}`} title={teamName}>
        <AgentAvatar seed={picked} label={teamName} size={32} />
      </span>
    );
  }
  if (manager !== null) {
    return (
      <span className={`shrink-0 rounded-lg${ring}`} title={`${manager.name} · ${teamName}`}>
        <AgentAvatar seed={manager.avatarSeed} label={`${manager.name} (${teamName})`} size={32} />
      </span>
    );
  }
  return (
    <span
      role="img"
      aria-label={teamName}
      title={teamName}
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary-100 text-sm font-semibold text-primary-700${ring}`}
    >
      {teamName.charAt(0).toUpperCase()}
    </span>
  );
}
