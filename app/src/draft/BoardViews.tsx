import { useEffect, useRef } from 'react';
import {
  overallPick,
  positionTone,
  roundPick,
  shortName,
  teamAt,
  type DraftBoard,
  type PlayerRef
} from './board';
import { PlayerHeadshot } from '../players/PlayerHeadshot';
import { PositionChip, TeamMark } from './marks';

type Team = DraftBoard['order'][number];
type Pick = DraftBoard['picks'][number];

/** How many made picks the ticker shows, and how many upcoming slots after the one on the clock. */
const TICKER_PICKS = 16;
const TICKER_UPCOMING = 4;

/**
 * The pick ticker: the latest picks, oldest to newest, then the pick on the clock and the next few
 * slots. Each made pick is a card with the team's mark, round.pick, the player and his position
 * color. New picks slide in (`arrived`); the strip keeps the newest pick in view.
 */
export function PickTicker({
  board,
  arrived,
  onOpen
}: {
  board: DraftBoard;
  arrived(key: string): boolean;
  onOpen(player: PlayerRef): void;
}) {
  const strip = useRef<HTMLOListElement>(null);
  const teams = board.order.length;
  const recent = board.picks.slice(-TICKER_PICKS);
  const clock = board.onTheClock;
  const upcoming =
    clock === null
      ? []
      : Array.from({ length: TICKER_UPCOMING + 1 }, (_, i) => clock.overall + i).filter(
          (o) => o <= board.rounds * teams
        );
  const byId = new Map(board.order.map((t) => [t.teamId, t]));

  // Keep the newest pick (and the clock after it) in view as picks land.
  useEffect(() => {
    const el = strip.current;
    const current = el?.querySelector('[data-current="true"]');
    if (el === null || current === null || current === undefined) return;
    const left = (current as HTMLElement).offsetLeft - el.clientWidth / 3;
    el.scrollTo?.({ left: Math.max(0, left) });
  }, [board.picks.length]);

  return (
    <ol
      ref={strip}
      aria-label="Recent picks"
      data-testid="pick-ticker"
      className="flex min-w-0 gap-2 overflow-x-auto pb-1 [scrollbar-width:thin]"
    >
      {recent.length === 0 && clock !== null && (
        <li className="flex items-center px-2 text-sm text-muted-foreground">No picks yet.</li>
      )}
      {recent.map((pick) => {
        const team = byId.get(pick.teamId);
        const mine = pick.teamId === board.yourTeamId;
        return (
          <li
            key={pick.overall}
            data-testid={`ticker-${pick.overall}`}
            className={`flex w-40 shrink-0 items-center gap-2 rounded-md border-l-4 bg-surface px-2 py-1 shadow-sm ${positionTone(pick.player.position).cell} ${mine ? 'ring-1 ring-primary-400' : ''} ${arrived(String(pick.overall)) ? 'motion-slide-in' : ''}`}
            title={pick.reason ?? undefined}
          >
            {team !== undefined && (
              <TeamMark teamId={team.teamId} teamName={team.teamName} manager={team.manager} size={24} />
            )}
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="flex items-center gap-1 text-[0.6875rem] text-muted-foreground">
                <span className="font-mono">{roundPick(pick.round, pick.pick)}</span>
                <span className="truncate">{team?.teamName ?? pick.teamId}</span>
              </span>
              <button
                type="button"
                className="truncate text-left text-sm font-semibold hover:underline"
                onClick={() => onOpen(pick.player)}
                aria-label={`${pick.player.name}, pick ${roundPick(pick.round, pick.pick)} by ${team?.teamName ?? pick.teamId}`}
              >
                {shortName(pick.player)}
              </button>
              <span className="flex items-center gap-1 text-[0.6875rem] text-muted-foreground">
                <PositionChip position={pick.player.position} />
                {pick.player.team ?? 'FA'}
                {pick.auto && <span title="Autopick">· auto</span>}
              </span>
            </span>
          </li>
        );
      })}
      {upcoming.map((overall, i) => {
        const team = teamAt(board.order, overall);
        const round = Math.ceil(overall / teams);
        const pick = overall - (round - 1) * teams;
        const now = i === 0;
        const mine = team?.teamId === board.yourTeamId;
        return (
          <li
            key={`slot-${overall}`}
            data-current={now ? 'true' : undefined}
            data-testid={now ? 'ticker-clock' : undefined}
            className={`flex w-36 shrink-0 items-center gap-2 rounded-md border border-dashed px-2 py-1 ${
              now ? 'border-primary-500 bg-primary-50' : 'border-border'
            } ${mine ? 'font-semibold text-primary-800' : 'text-muted-foreground'}`}
          >
            {team !== undefined && (
              <TeamMark teamId={team.teamId} teamName={team.teamName} manager={team.manager} size={20} />
            )}
            <span className="flex min-w-0 flex-col text-xs leading-tight">
              <span className="font-mono">{roundPick(round, pick)}</span>
              <span className="truncate">{mine ? 'You' : (team?.teamName ?? '')}</span>
              {now && <span className="text-[0.6875rem] uppercase tracking-wide">On the clock</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The full draft board: teams across (round-1 order), rounds down, snaking. Each pick is a square
 * in its position color; your column is highlighted and the pick on the clock is ringed.
 */
export function BoardGrid({
  board,
  arrived,
  onOpen
}: {
  board: DraftBoard;
  arrived(key: string): boolean;
  onOpen(player: PlayerRef): void;
}) {
  const byOverall = new Map<number, Pick>(board.picks.map((p) => [p.overall, p]));
  const current = board.onTheClock?.overall ?? 0;
  const teams = board.order.length;
  return (
    <div className="h-full overflow-auto" data-testid="board-grid">
      <table
        aria-label="Draft board"
        className="w-full table-fixed border-separate border-spacing-1 text-xs"
        style={{ minWidth: `${2 + teams * 6.5}rem` }}
      >
        <colgroup>
          <col className="w-8" />
          {board.order.map((t) => (
            <col key={t.teamId} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className="sticky top-0 z-10 bg-background text-muted-foreground">
              Rd
            </th>
            {board.order.map((team: Team) => {
              const mine = team.teamId === board.yourTeamId;
              return (
                <th
                  key={team.teamId}
                  scope="col"
                  className={`sticky top-0 z-10 rounded-md px-1 py-1 text-left font-semibold ${
                    mine ? 'bg-primary-100 text-primary-800' : 'bg-background'
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-1">
                    <TeamMark
                      teamId={team.teamId}
                      teamName={team.teamName}
                      manager={team.manager}
                      size={18}
                    />
                    <span className="truncate">{team.teamName}</span>
                  </span>
                  {team.manager != null && (
                    <span className="block truncate text-[0.6875rem] font-normal text-muted-foreground">
                      {team.manager.name}
                    </span>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: board.rounds }, (_, r) => r + 1).map((round) => (
            <tr key={round}>
              <th scope="row" className="text-center font-mono text-muted-foreground">
                {round}
              </th>
              {board.order.map((team, index) => {
                const overall = overallPick(round, index, teams);
                const pick = byOverall.get(overall);
                const onClock = current === overall;
                const mine = team.teamId === board.yourTeamId;
                const pickInRound = overall - (round - 1) * teams;
                if (pick === undefined) {
                  return (
                    <td
                      key={team.teamId}
                      data-testid={`cell-${overall}`}
                      className={`h-12 rounded-md border border-dashed px-1 align-top ${
                        onClock
                          ? 'motion-clock-cell border-primary-500 bg-primary-50 text-primary-800'
                          : mine
                            ? 'border-primary-300 bg-primary-50/50 text-muted-foreground'
                            : 'border-border text-muted-foreground'
                      }`}
                    >
                      <span className="font-mono text-[0.6875rem]">{roundPick(round, pickInRound)}</span>
                      {onClock && <span className="block font-semibold">On the clock</span>}
                    </td>
                  );
                }
                return (
                  <td
                    key={team.teamId}
                    data-testid={`cell-${overall}`}
                    data-position={pick.player.position}
                    title={pick.reason ?? undefined}
                    className={`h-12 rounded-md border-l-4 px-1 align-top ${positionTone(pick.player.position).cell} ${
                      mine ? 'ring-1 ring-primary-400' : ''
                    }`}
                  >
                    <span
                      key={pick.player.id}
                      className={`flex min-w-0 items-start gap-1 ${arrived(String(overall)) ? 'motion-flip-in' : ''}`}
                    >
                      <PlayerHeadshot player={pick.player} size={24} className="mt-0.5" />
                      <span className="block min-w-0 flex-1">
                        <button
                          type="button"
                          className="block w-full truncate text-left font-semibold hover:underline"
                          onClick={() => onOpen(pick.player)}
                          aria-label={pick.player.name}
                        >
                          {shortName(pick.player)}
                        </button>
                        <span className="block truncate text-[0.6875rem] text-muted-foreground">
                          {pick.player.position} · {pick.player.team ?? 'FA'}
                          {pick.auto ? ' · auto' : ''}
                        </span>
                      </span>
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
