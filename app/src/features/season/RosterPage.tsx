import { useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { Alert, EmptyState } from '@readysetcloud/ui';
import { useLeagueApi } from '../../api/league';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';
import { useLoad } from '../../lib/useLoad';
import { LoadingSkeleton } from '../../motion/decor';
import { LineupBoard } from './LineupBoard';
import { LineupHelp } from './LineupHelp';
import { nextKickoff, useNow, withLocksAt } from './gameState';
import { connectMomentoEvents, useLiveEvents, type EventConnect } from '../../realtime/leagueEvents';
import { TRADE_EVENTS, TRADES_POLL_MS } from '../../trades/TradesPage';
import { pendingTrades, TradeCallout, tradingAway } from './TradeCallout';

/**
 * The week's games changed (a kickoff, a quarter, a final): the locks may have too (#193). A
 * player's status changed (#200, e.g. ruled out on game day): the OUT chip shows without a reload.
 */
const LINEUP_EVENTS = ['NFL Games Updated', 'Player Status Changed', ...TRADE_EVENTS] as const;
const TRADE_EVENT_TYPES: readonly string[] = TRADE_EVENTS;
/** How often the lock countdowns tick; each kickoff also lands exactly on time. */
export const LOCK_TICK_MS = 30_000;

/** My Team › Lineup (#58, #176, #178): your lineup, with projections, drag and drop, and Optimize. */
export function RosterPage({ connect = connectMomentoEvents }: { connect?: EventConnect }) {
  const { leagueId = '' } = useParams();
  const api = useLeagueApi();
  const state = useLoad(() => api.getLeagueState(leagueId), leagueId);

  let body;
  if (state.data === null) {
    body = state.error ? (
      <ApiErrorAlert error={state.error} />
    ) : (
      <LoadingSkeleton label="Loading your team…" />
    );
  } else if (state.data.yourTeam === null) {
    body = <EmptyState title="No team" description="You do not manage a team in this league." />;
  } else {
    body = <LineupEditor leagueId={leagueId} teamId={state.data.yourTeam.id} connect={connect} />;
  }
  return (
    <div data-testid="league-section-roster" className="space-y-4">
      {body}
    </div>
  );
}

function LineupEditor({
  leagueId,
  teamId,
  connect
}: {
  leagueId: string;
  teamId: string;
  connect: EventConnect;
}) {
  const api = useLeagueApi();
  // `?player=` comes from a player notification (#200): highlight him on the board.
  const [params] = useSearchParams();
  const highlight = params.get('player');
  const roster = useLoad(() => api.getRoster(leagueId, teamId), `${leagueId}:${teamId}`);
  // Trades still in play for this team, for the callout above the lineup. Best effort: a failed
  // read just leaves the callout out.
  const trades = useLoad(() => api.listTrades(leagueId), `trades:${leagueId}`, TRADES_POLL_MS);
  const pending = useMemo(() => pendingTrades(trades.data ?? []), [trades.data]);
  const onTheBlock = useMemo(() => tradingAway(pending), [pending]);
  const [warnings, setWarnings] = useState<{ code: string; message: string }[]>([]);
  // A save that lost the race with a kickoff: who locked, and a fresh board from the server's lineup.
  const [lockRace, setLockRace] = useState<{ names: string[]; round: number } | null>(null);
  useLiveEvents({
    leagueId,
    types: LINEUP_EVENTS,
    global: true,
    realtime: api.getRealtime,
    connect,
    onEvent: (event) => {
      if (TRADE_EVENT_TYPES.includes(event.detailType)) {
        trades.reload();
        // A processed trade moves players on or off this roster.
        if (event.detailType === 'Trade Processed') roster.reload();
        return;
      }
      // Another team's player changing status changes nothing here.
      const playerId = event.detail?.playerId;
      if (
        event.detailType === 'Player Status Changed' &&
        !(roster.data?.players ?? []).some((p) => p.player.id === playerId)
      ) {
        return;
      }
      roster.reload();
    }
  });
  const players = roster.data?.players;
  const now = useNow(LOCK_TICK_MS, (n) => (players === undefined ? null : nextKickoff(players, n)));
  // Players lock at their kickoff without a reload; the server still refuses a locked move.
  const locked = useMemo(
    () => (roster.data === null ? null : { ...roster.data, players: withLocksAt(roster.data.players, now) }),
    [roster.data, now]
  );

  if (roster.data === null) {
    return roster.error ? (
      <ApiErrorAlert error={roster.error} />
    ) : (
      <LoadingSkeleton label="Loading your lineup…" rows={8} />
    );
  }
  const data = locked as NonNullable<typeof locked>;
  if (data.players.length === 0) {
    return (
      <>
        {data.carriedFromWeek !== null && (
          <p className="text-muted-foreground">
            Week {data.week} · carried over from week {data.carriedFromWeek}
          </p>
        )}
        <EmptyState title="No players yet" description="Your roster fills in at the draft." />
      </>
    );
  }
  return (
    <div className="space-y-4">
      {lockRace !== null && (
        <Alert variant="error" role="alert">
          <p className="font-medium" data-testid="lock-race">
            {lockRace.names.length === 0
              ? 'A game kicked off before your changes were saved, so nothing was changed.'
              : `${lockRace.names.join(' and ')} ${lockRace.names.length === 1 ? 'is' : 'are'} locked: ${
                  lockRace.names.length === 1 ? 'his game' : 'their games'
                } kicked off before your changes were saved, so nothing was changed.`}
          </p>
          <p className="text-sm">Here is your lineup as it stands now. Make your other moves again.</p>
        </Alert>
      )}
      <TradeCallout leagueId={leagueId} trades={pending} now={now} />
      {warnings.map((w) => (
        <Alert key={`${w.code}:${w.message}`} variant="info">
          {w.message}
        </Alert>
      ))}
      {/* A fresh board for each loaded lineup, so a save starts from what the server kept, and for
          each player a notification points at (#200), so he starts picked up. */}
      <LineupBoard
        key={`${data.week}:${lockRace?.round ?? 0}:${highlight ?? ''}:${data.players.map((p) => `${p.player.id}=${p.slot}`).join(',')}`}
        leagueId={leagueId}
        teamId={teamId}
        data={data}
        now={now}
        highlight={highlight}
        onTheBlock={onTheBlock}
        help={<LineupHelp slots={data.slots.map((s) => s.slot)} />}
        onSaved={(next) => {
          setWarnings(next);
          setLockRace(null);
          roster.reload();
        }}
        onLocked={(names) => {
          setLockRace((current) => ({ names, round: (current?.round ?? 0) + 1 }));
          roster.reload();
        }}
      />
    </div>
  );
}
