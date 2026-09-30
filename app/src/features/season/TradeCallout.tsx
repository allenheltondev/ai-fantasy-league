import { Link } from 'react-router';
import type { PlayerRef, TradeView } from '../../trades/api';
import { countdown } from '../../trades/TradesPage';
import { PlayerHeadshot } from '../../players/PlayerHeadshot';
import { PlayerList } from '../../players/PlayerLink';

/** Trades still in play for your team: offers either way, and accepted ones in league review. */
export function pendingTrades(trades: readonly TradeView[]): TradeView[] {
  const rank = (t: TradeView) => (t.status === 'proposed' ? (t.direction === 'incoming' ? 0 : 2) : 1);
  return trades
    .filter((t) => t.direction !== 'league' && ['proposed', 'in_review', 'accepted'].includes(t.status))
    .sort((a, b) => rank(a) - rank(b) || Date.parse(a.expiresAt) - Date.parse(b.expiresAt));
}

/** The ids of your players a pending trade would send away. */
export function tradingAway(trades: readonly TradeView[]): Set<string> {
  return new Set(
    trades.flatMap((t) => (t.direction === 'incoming' ? t.toSends : t.fromSends)).map((p) => p.id)
  );
}

/** How many trades the callout lists before "and N more". */
const SHOWN = 2;

/**
 * A card above the lineup while a trade involving your team is pending: who is offering what, the
 * players you would give and get side by side, how long is left, and a link to the offer on the
 * trades page. Incoming offers come first, since they are waiting on you.
 */
export function TradeCallout(props: { leagueId: string; trades: TradeView[]; now: number }) {
  const { trades } = props;
  if (trades.length === 0) return null;
  const tradesHref = `/leagues/${encodeURIComponent(props.leagueId)}/team/trades`;
  const yourMove = trades.some((t) => t.direction === 'incoming' && t.status === 'proposed');
  return (
    <section
      aria-label="Pending trades"
      data-testid="trade-callout"
      className="motion-pop overflow-hidden rounded-lg border border-primary-300 bg-gradient-to-br from-primary-50 via-surface to-surface shadow-sm"
    >
      <h3 className="flex items-center gap-2 px-3 pt-3 text-sm font-semibold sm:px-4">
        <span aria-hidden="true" className="relative flex h-2.5 w-2.5">
          {yourMove && (
            <span className="absolute inline-flex h-full w-full rounded-full bg-primary-400 opacity-75 motion-safe:animate-ping" />
          )}
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary-500" />
        </span>
        {trades.length === 1 ? 'Trade pending' : `${trades.length} trades pending`}
        {yourMove && <span className="font-normal text-primary-700">· your move</span>}
      </h3>
      <ul className="divide-y divide-primary-100">
        {trades.slice(0, SHOWN).map((t) => (
          <TradeRow
            key={t.id}
            trade={t}
            href={`${tradesHref}?trade=${encodeURIComponent(t.id)}`}
            now={props.now}
          />
        ))}
      </ul>
      {trades.length > SHOWN && (
        <p className="px-3 pb-3 text-sm sm:px-4">
          <Link to={tradesHref} className="font-medium text-primary-700 hover:underline">
            and {trades.length - SHOWN} more on the trades page
          </Link>
        </p>
      )}
    </section>
  );
}

function TradeRow({ trade: t, href, now }: { trade: TradeView; href: string; now: number }) {
  const incoming = t.direction === 'incoming';
  const partner = incoming ? t.fromTeam : t.toTeam;
  const give = incoming ? t.toSends : t.fromSends;
  const get = incoming ? t.fromSends : t.toSends;
  const waitingOnYou = incoming && t.status === 'proposed';
  const headline =
    t.status !== 'proposed'
      ? `Accepted with ${partner.name}`
      : incoming
        ? `${partner.name} ${t.round > 0 ? 'countered' : 'sent you an offer'}`
        : `Waiting on ${partner.name}`;
  const when =
    t.status === 'proposed'
      ? countdown(t.expiresAt, now) === 'expired'
        ? 'Expiring now'
        : `Expires in ${countdown(t.expiresAt, now)}`
      : t.status === 'in_review'
        ? 'In league review'
        : 'Processing';
  return (
    <li
      data-testid={`trade-callout-${t.id}`}
      className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-3 sm:px-4"
    >
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="text-sm">
          <strong>{headline}</strong> <span className="text-muted-foreground">· {when}</span>
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <Side label="You give" players={give} tone="text-error-700" />
          <SwapIcon />
          <Side label="You get" players={get} tone="text-success-700" />
        </div>
      </div>
      <Link
        to={href}
        className={`inline-flex min-h-11 shrink-0 items-center rounded-md px-4 text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500 max-sm:w-full max-sm:justify-center ${
          waitingOnYou
            ? 'bg-primary-600 text-white hover:bg-primary-700'
            : 'border border-border bg-surface hover:bg-muted'
        }`}
      >
        {waitingOnYou ? 'Review offer' : 'View trade'}
      </Link>
    </li>
  );
}

function Side({ label, players, tone }: { label: string; players: PlayerRef[]; tone: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="flex shrink-0 -space-x-2" aria-hidden="true">
        {players.slice(0, 3).map((p) => (
          <PlayerHeadshot key={p.id} player={p} size={28} className="rounded-full ring-2 ring-surface" />
        ))}
      </span>
      <span className="min-w-0">
        <span className={`block text-[0.7rem] font-semibold uppercase tracking-wide ${tone}`}>{label}</span>
        <span className="block">
          <PlayerList players={players} empty="nobody" />
        </span>
      </span>
    </span>
  );
}

function SwapIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 shrink-0 text-muted-foreground">
      <path
        fill="currentColor"
        d="M13.3 2.3a1 1 0 0 1 1.4 0l3 3a1 1 0 0 1 0 1.4l-3 3a1 1 0 1 1-1.4-1.4L14.6 7H5a1 1 0 0 1 0-2h9.6l-1.3-1.3a1 1 0 0 1 0-1.4Zm-6.6 8a1 1 0 0 1 0 1.4L5.4 13H15a1 1 0 1 1 0 2H5.4l1.3 1.3a1 1 0 1 1-1.4 1.4l-3-3a1 1 0 0 1 0-1.4l3-3a1 1 0 0 1 1.4 0Z"
      />
    </svg>
  );
}
