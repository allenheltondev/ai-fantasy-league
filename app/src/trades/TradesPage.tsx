import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { Alert, Button, Card, CardBody, Input, Select, StatusBadge } from '@readysetcloud/ui';
import { apiFetch } from '../api';
import { ApiErrorAlert } from '../components/ApiErrorAlert';
import { useLoad } from '../lib/useLoad';
import { connectMomentoEvents, useLiveEvents, type EventConnect } from '../realtime/leagueEvents';
import {
  createTradesApi,
  type PlayerRef,
  type Selection,
  type TradePreview,
  type TradeAction,
  type TradesApi,
  type TradeView
} from './api';
import { PlayerLink, PlayerList } from '../players/PlayerLink';

const defaultApi = createTradesApi(apiFetch);

/**
 * Events that change what this page shows. Offers, counters, rejections, expiries, and withdrawals
 * arrive on the caller's own team topic (only the two teams hear about them); accepted, processed,
 * and vetoed trades on the league topic.
 */
export const TRADE_EVENTS = [
  'Trade Proposed',
  'Trade Countered',
  'Trade Accepted',
  'Trade Rejected',
  'Trade Expired',
  'Trade Withdrawn',
  'Trade Processed',
  'Trade Vetoed'
] as const;
/** How often the trade list refreshes without realtime. */
export const TRADES_POLL_MS = 60_000;
/** While live, a slow safety refresh in case an event is missed. */
export const TRADES_LIVE_POLL_MS = 300_000;
/** How often the expiry countdowns tick. */
export const COUNTDOWN_TICK_MS = 30_000;

const signed = (n: number) => `${n > 0 ? '+' : ''}${n}`;

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

/** Time left until `iso`, e.g. "1d 4h" or "35m". */
export function countdown(iso: string, now: number): string {
  const ms = Date.parse(iso) - now;
  if (ms <= 0) return 'expired';
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

function PlayerPicker(props: {
  label: string;
  players: PlayerRef[] | null;
  selected: string[];
  onToggle: (id: string) => void;
}) {
  return (
    <fieldset className="space-y-1">
      <legend className="font-medium">{props.label}</legend>
      {props.players === null && <p className="text-sm text-muted-foreground">Pick a team first.</p>}
      {props.players?.map((p) => (
        <div key={p.id} className="flex items-center gap-1 text-sm">
          {/* The box picks the player; his name opens his card. */}
          <label className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center">
            <input
              type="checkbox"
              checked={props.selected.includes(p.id)}
              onChange={() => props.onToggle(p.id)}
              aria-label={`${props.label}: ${p.name}`}
            />
          </label>
          <PlayerLink player={p} /> <span className="text-muted-foreground">{p.position}</span>
        </div>
      ))}
    </fieldset>
  );
}

function PreviewPanel({ preview }: { preview: TradePreview }) {
  const favors = preview.sides.find((s) => s.team.id === preview.fairness.favors)?.team.name;
  return (
    <section aria-label="Trade preview" className="space-y-2 rounded-md border border-border p-3 text-sm">
      <p className="font-medium">
        {preview.valid ? 'This trade is legal.' : 'This trade is not legal yet.'}{' '}
        {preview.fairness.lopsided ? 'It looks lopsided' : 'It looks fair'}
        {favors ? ` (favors ${favors}).` : '.'}
      </p>
      {preview.issues.map((i) => (
        <p key={i.code + i.message} className="text-danger-700">
          {i.message} {i.fix}
        </p>
      ))}
      {preview.warnings.map((w) => (
        <p key={w.code} className="text-warning-700">
          {w.message}
        </p>
      ))}
      <ul>
        {preview.sides.map((s) => (
          <li key={s.team.id}>
            {s.team.name}: lineup {signed(s.lineupDelta)} pts, value {signed(s.valueDelta)}, roster{' '}
            {s.activeAfter}/{s.activeLimit}
            {s.dropsNeeded > 0 && ` (must drop ${s.dropsNeeded})`}
          </li>
        ))}
      </ul>
    </section>
  );
}

const ACTION_LABELS: Record<TradeAction, string> = {
  accept: 'Accept',
  reject: 'Reject',
  counter: 'Counter',
  withdraw: 'Withdraw',
  vote: 'Veto',
  approve: 'Approve'
};

function TradeCard(props: {
  trade: TradeView;
  now: number;
  /** The trade a notification opened (`?trade=<id>`, #165): scrolled to and ringed. */
  focused: boolean;
  onAction: (trade: TradeView, action: TradeAction) => void;
}) {
  const t = props.trade;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (props.focused) ref.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }, [props.focused]);
  return (
    <div ref={ref} aria-current={props.focused ? 'true' : undefined}>
      <Card className={props.focused ? 'motion-attention ring-2 ring-primary-500' : undefined}>
        <CardBody>
          <div data-testid={`trade-${t.id}`} className="space-y-1 text-sm">
            <p>
              <strong>{t.fromTeam.name}</strong> sends <PlayerList players={t.fromSends} /> to{' '}
              <strong>{t.toTeam.name}</strong> for <PlayerList players={t.toSends} />.
            </p>
            <p className="flex flex-wrap items-center gap-2">
              <StatusBadge
                tone={t.status === 'processed' ? 'success' : t.status === 'proposed' ? 'warning' : 'neutral'}
              >
                {t.status.replace('_', ' ')}
              </StatusBadge>
              {t.status === 'proposed' && <span>Expires in {countdown(t.expiresAt, props.now)}</span>}
              {t.status === 'in_review' && t.reviewEndsAt && (
                <span>
                  Review ends {formatTime(t.reviewEndsAt)} · {t.vetoVotes}/{t.vetoVotesRequired} veto votes
                </span>
              )}
              {t.round > 0 && <span>Counter #{t.round}</span>}
            </p>
            {t.message && <p className="italic">“{t.message}”</p>}
            {t.reply && <p className="italic">Reply: “{t.reply}”</p>}
            {t.voidReason && <p>Cancelled: {t.voidReason.message}</p>}
            <div className="flex gap-2">
              {t.yourActions.map((a) => (
                <Button
                  key={a}
                  size="sm"
                  variant={a === 'accept' || a === 'approve' ? 'primary' : 'secondary'}
                  onClick={() => props.onAction(t, a)}
                >
                  {ACTION_LABELS[a]}
                </Button>
              ))}
            </div>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

function TradeList(props: {
  title: string;
  trades: TradeView[];
  empty: string;
  now: number;
  focus: string | null;
  onAction: (trade: TradeView, action: TradeAction) => void;
}) {
  return (
    <section aria-label={props.title} className="space-y-2">
      <h3 className="text-lg font-semibold">{props.title}</h3>
      {props.trades.length === 0 && <p className="text-sm text-muted-foreground">{props.empty}</p>}
      {props.trades.map((t) => (
        <TradeCard
          key={t.id}
          trade={t}
          now={props.now}
          focused={t.id === props.focus}
          onAction={props.onAction}
        />
      ))}
    </section>
  );
}

const EMPTY: Selection = { withTeamId: '', send: [], receive: [], drops: [] };

/**
 * The trades section: a builder (pick a team and players on both sides, with a live preview_trade
 * readout of legality and fairness), the inbox and outbox with accept, reject, counter, and
 * withdraw, and the league's trades under review with veto votes.
 */
export function TradesPage({
  api = defaultApi,
  now = Date.now,
  connect = connectMomentoEvents
}: {
  api?: TradesApi;
  now?: () => number;
  connect?: EventConnect;
}) {
  const { leagueId = '' } = useParams();
  const [params] = useSearchParams();
  const setup = useLoad(() => api.setup(leagueId), leagueId);
  const live = useLiveEvents({
    leagueId,
    types: TRADE_EVENTS,
    realtime: api.realtime,
    connect,
    onEvent: () => trades.reload()
  });
  const trades = useLoad(
    () => api.list(leagueId),
    leagueId,
    live === 'live' ? TRADES_LIVE_POLL_MS : TRADES_POLL_MS
  );
  const [clock, setClock] = useState(now);
  useEffect(() => {
    setClock(now());
    const tick = setInterval(() => setClock(now()), COUNTDOWN_TICK_MS);
    return () => clearInterval(tick);
  }, [now]);
  // `?with=<teamId>` (another team's page, #178) starts the builder with that team picked.
  const [selection, setSelection] = useState<Selection>(() => ({
    ...EMPTY,
    withTeamId: params.get('with') ?? ''
  }));
  const [countering, setCountering] = useState<TradeView | null>(null);
  const [mine, setMine] = useState<PlayerRef[] | null>(null);
  const [theirs, setTheirs] = useState<PlayerRef[] | null>(null);
  const [preview, setPreview] = useState<TradePreview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const myTeam = setup.data?.yourTeam ?? null;
  useEffect(() => {
    if (myTeam === null) return;
    api.roster(leagueId, myTeam.id).then(setMine, setError);
  }, [api, leagueId, myTeam]);
  useEffect(() => {
    setTheirs(null);
    if (selection.withTeamId === '') return;
    api.roster(leagueId, selection.withTeamId).then(setTheirs, setError);
  }, [api, leagueId, selection.withTeamId]);
  useEffect(() => {
    setPreview(null);
    if (selection.withTeamId === '' || selection.send.length + selection.receive.length === 0) return;
    let current = true;
    api.preview(leagueId, selection).then(
      (p) => current && setPreview(p),
      (e: unknown) => current && setError(e)
    );
    return () => {
      current = false;
    };
  }, [api, leagueId, selection]);

  const toggle = (key: 'send' | 'receive' | 'drops', id: string) =>
    setSelection((s) => ({
      ...s,
      [key]: s[key].includes(id) ? s[key].filter((x) => x !== id) : [...s[key], id]
    }));

  const run = async (label: string, action: () => Promise<TradeView>) => {
    setError(null);
    setNotice(null);
    try {
      const t = await action();
      setNotice(`${label}: the trade is now ${t.status.replace('_', ' ')}.`);
      trades.reload();
      return true;
    } catch (e) {
      setError(e);
      return false;
    }
  };

  const onAction = (t: TradeView, action: TradeAction) => {
    if (action === 'counter') {
      setCountering(t);
      setSelection({
        withTeamId: t.fromTeam.id,
        send: t.toSends.map((p) => p.id),
        receive: t.fromSends.map((p) => p.id),
        drops: []
      });
      return;
    }
    const call = {
      accept: () => api.respond(leagueId, t.id, 'accept'),
      reject: () => api.respond(leagueId, t.id, 'reject'),
      withdraw: () => api.withdraw(leagueId, t.id),
      vote: () => api.vote(leagueId, t.id, 'veto'),
      approve: () => api.vote(leagueId, t.id, 'approve')
    }[action];
    void run(ACTION_LABELS[action], call);
  };

  const submit = async () => {
    const ok = countering
      ? await run('Counter sent', () => api.counter(leagueId, countering.id, selection))
      : await run('Offer sent', () => api.propose(leagueId, selection));
    if (ok) {
      setSelection(EMPTY);
      setCountering(null);
    }
  };

  const all = trades.data ?? [];
  const canTrade = setup.data?.allowedActions.includes('propose_trade') === true;
  const others = (setup.data?.teams ?? []).filter((t) => t.id !== myTeam?.id);
  const listProps = { now: clock, focus: params.get('trade'), onAction };

  return (
    <div data-testid="league-section-trades" className="space-y-6">
      {notice && <Alert variant="success">{notice}</Alert>}
      <ApiErrorAlert error={error ?? setup.error ?? trades.error} />

      {myTeam !== null && (
        <section aria-label="Trade builder" className="space-y-3">
          <h3 className="text-lg font-semibold">
            {countering ? `Counter ${countering.fromTeam.name}'s offer` : 'Propose a trade'}
          </h3>
          {!canTrade && !countering && (
            <p className="text-sm text-muted-foreground">Trading is closed right now.</p>
          )}
          <Select
            label="Trade with"
            value={selection.withTeamId}
            disabled={countering !== null}
            onChange={(e) => setSelection({ ...EMPTY, withTeamId: e.target.value })}
          >
            <option value="">Pick a team</option>
            {others.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
          <div className="grid gap-4 md:grid-cols-2">
            <PlayerPicker
              label="You send"
              players={mine}
              selected={selection.send}
              onToggle={(id) => toggle('send', id)}
            />
            <PlayerPicker
              label="You receive"
              players={theirs}
              selected={selection.receive}
              onToggle={(id) => toggle('receive', id)}
            />
          </div>
          {preview && preview.sides[0].dropsNeeded > 0 && (
            <PlayerPicker
              label="You drop"
              players={(mine ?? []).filter((p) => !selection.send.includes(p.id))}
              selected={selection.drops}
              onToggle={(id) => toggle('drops', id)}
            />
          )}
          <Input
            label="Note (optional)"
            value={selection.message ?? ''}
            onChange={(e) => setSelection((s) => ({ ...s, message: e.target.value }))}
          />
          {preview && <PreviewPanel preview={preview} />}
          <div className="flex gap-2">
            <Button variant="primary" disabled={!preview?.valid} onClick={() => void submit()}>
              {countering ? 'Send counter' : 'Propose trade'}
            </Button>
            {countering && (
              <Button
                variant="secondary"
                onClick={() => {
                  setCountering(null);
                  setSelection(EMPTY);
                }}
              >
                Cancel counter
              </Button>
            )}
          </div>
        </section>
      )}

      <TradeList
        title="Inbox"
        empty="No offers waiting for you."
        trades={all.filter((t) => t.direction === 'incoming' && t.status === 'proposed')}
        {...listProps}
      />
      <TradeList
        title="Sent offers"
        empty="You have no open offers."
        trades={all.filter((t) => t.direction === 'outgoing' && t.status === 'proposed')}
        {...listProps}
      />
      <TradeList
        title="League review"
        empty="No trades are under review."
        trades={all.filter((t) => t.status === 'in_review' || t.status === 'accepted')}
        {...listProps}
      />
      <TradeList
        title="History"
        empty="No finished trades yet."
        trades={all.filter((t) => !['proposed', 'in_review', 'accepted'].includes(t.status))}
        {...listProps}
      />
    </div>
  );
}
