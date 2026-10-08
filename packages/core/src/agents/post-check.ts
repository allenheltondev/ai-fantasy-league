/**
 * Checks on the free-form posts an agent writes itself (#263, #264): a check-in's board post,
 * matchup talk, and goal DM. Grounded social acts have their own check against their facts
 * (`checkSocialAct`); these posts have no evidence ids, so they are read for what a free-form post
 * has got wrong live (#247's evaluation):
 *
 * - **Action claims** (#264): "Offer sent.", "the trade went through", "you accepted my offer".
 *   Each sentence holding a trade-status claim the caller cannot support (the turn did not make
 *   the move, and the latest trade with that counterpart never reached the status) is cut. A post
 *   with nothing left is withheld (`unsupported_claim`).
 * - **Private detail** (#263, #206): the check-in's one prompt serves several destinations and holds
 *   private options (pickups and trade ideas being weighed, offers pending or turned down, a DM-only
 *   act's facts). In a room anyone may read, a player in a private move that the post's own facts
 *   do not already state is `private_detail`, and talk of an offer that is not public (one turned
 *   down, countered, withdrawn, or sent) is `private_offer`. Either withholds the post: rewording
 *   a secret is not a safe repair. A DM between the two teams skips this half.
 *
 * Narrow by design, like the claim checks it shares its patterns with (sim `claims.ts`): a
 * paraphrase the patterns miss gets through, so the prompt still says what not to post. It is a
 * guard before the post goes out, not a judgment of the prose.
 */

/** Trade-status claims (#247's `trade_status` kind; the sim's claim checks read the same patterns). */
export const TRADE_STATUS_PATTERNS = {
  completed:
    /\b(trade (?:went|is|has gone) through|deal(?:'s| is) done|done deal|trade (?:is )?(?:complete|completed|processed|official|final))\b/i,
  sent: /\b(offer(?:'s| is)? (?:sent|on its way|went out|is out)|sent (?:you )?(?:an|the|my) offer)\b/i,
  accepted: /\b(you accepted|accepted (?:my|the|our) offer)\b/i
} as const;
export type TradeStatusClaim = keyof typeof TRADE_STATUS_PATTERNS;

const TRADE_WORDS = String.raw`(?:offers?|trades?|deals?|pitch(?:es)?|proposals?)`;
const TURN_DOWN = String.raw`(?:turn(?:ed|s|ing)? down|reject(?:ed|s|ing)?|declin(?:ed|es|ing)|pass(?:ed|es|ing)? on|counter(?:ed|s|ing)|withdr(?:ew|awn|aws?))`;

/**
 * Talk of an offer that is not public: one turned down, countered, or withdrawn (either word
 * order), one sent or made to someone, or the talks themselves. An accepted or processed trade is
 * public (#206), so "you accepted my offer" is not here.
 */
export const PRIVATE_OFFER_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`\b${TURN_DOWN}\b[^.!?]{0,40}?\b${TRADE_WORDS}\b`, 'i'),
  new RegExp(String.raw`\b${TRADE_WORDS}\b[^.!?]{0,30}?\b${TURN_DOWN}\b`, 'i'),
  /\b(?:offered|pitched) (?:you|them|him|her|me|us)\b/i,
  /\btrade talks\b/i,
  TRADE_STATUS_PATTERNS.sent
];

/** Whether a text talks about an offer that is not public (`PRIVATE_OFFER_PATTERNS`). */
export function talksOfPrivateOffer(text: string): boolean {
  return PRIVATE_OFFER_PATTERNS.some((p) => p.test(text));
}

/** The trade-status claims a text makes, in `TRADE_STATUS_PATTERNS` order. */
export function tradeStatusClaims(text: string): TradeStatusClaim[] {
  return (Object.keys(TRADE_STATUS_PATTERNS) as TradeStatusClaim[]).filter((k) =>
    TRADE_STATUS_PATTERNS[k].test(text)
  );
}

export interface PostCheckInput {
  message: string;
  /** The trade-status claims the record supports for this post (see `supportedTradeClaims`). */
  supported: readonly TradeStatusClaim[];
  /** Anyone may read the room (a league board, a matchup room); false for a DM between two teams. */
  public: boolean;
  /** Players in private moves (pickups, trade ideas, offers not public), and other private terms. */
  privateTerms?: readonly string[];
  /** The facts the post's prompt gave it: a private term they already state may be repeated. */
  facts?: readonly string[];
}

export type PostCheck =
  | { ok: true; message: string; cut: TradeStatusClaim[] }
  | { ok: false; reason: 'empty' | 'unsupported_claim' | 'private_detail' | 'private_offer' };

/** Sentences, each with its own end punctuation and trailing space, so they rejoin unchanged. */
const sentences = (text: string) => text.match(/[^.!?]+(?:[.!?]+|$)\s*/g) ?? [];

/** Checks a free-form post before it goes out (see the module comment). */
export function checkPost(input: PostCheckInput): PostCheck {
  const message = input.message.replace(/\s+/g, ' ').trim();
  if (message === '') return { ok: false, reason: 'empty' };
  const cut = new Set<TradeStatusClaim>();
  const kept = sentences(message).filter((s) => {
    const unsupported = tradeStatusClaims(s).filter((c) => !input.supported.includes(c));
    for (const c of unsupported) cut.add(c);
    return unsupported.length === 0;
  });
  const text = kept.join('').trim();
  // A mention or punctuation alone says nothing.
  if (text.replace(/@\S+|[^\p{L}\p{N}]/gu, '') === '')
    return { ok: false, reason: cut.size > 0 ? 'unsupported_claim' : 'empty' };
  if (input.public) {
    const said = text.toLowerCase();
    const facts = (input.facts ?? []).join(' ').toLowerCase();
    const named = (input.privateTerms ?? []).some((t) => {
      const term = t.trim().toLowerCase();
      return term !== '' && said.includes(term) && !facts.includes(term);
    });
    if (named) return { ok: false, reason: 'private_detail' };
    if (talksOfPrivateOffer(text)) return { ok: false, reason: 'private_offer' };
  }
  return { ok: true, message: text, cut: [...cut] };
}

/** A trade this team is in, as its trade list shows it (newest first). */
export interface TradeLine {
  /** The other team. */
  teamId: string;
  outgoing: boolean;
  status: string;
  /** Players either side sends or drops, when known. */
  players?: readonly string[];
}

/** Trade statuses anyone may see (#206): before them an offer is the two teams' business. */
export const PUBLIC_TRADE_STATUSES: ReadonlySet<string> = new Set([
  'accepted',
  'in_review',
  'processed',
  'vetoed'
]);

/** Trade statuses of an offer still on the table: proposed or countered, not yet answered. */
export const OPEN_TRADE_STATUSES: ReadonlySet<string> = new Set(['proposed', 'countered']);

/**
 * Players in this team's open offers: never named in a public post (#263). An offer that closed
 * without going public (turned down, expired, withdrawn) stays private as talk, which
 * `talksOfPrivateOffer` catches, but its players are fair game again: a ban on every player ever
 * offered would hold back ordinary trash talk for the rest of the season.
 */
export function privateTradeTerms(trades: readonly TradeLine[]): string[] {
  return [
    ...new Set(trades.filter((t) => OPEN_TRADE_STATUSES.has(t.status)).flatMap((t) => t.players ?? []))
  ];
}

const ACCEPTED: ReadonlySet<string> = new Set(['accepted', 'in_review', 'processed']);

/**
 * The trade-status claims a post may make (#264), the way #247's claim checks judge them: about the
 * latest trade with the counterpart, or, with no counterpart (a league board), about what this turn
 * did. An offer is "sent" when this turn sent the counterpart one or the latest trade with them is
 * the speaker's own; "completed" needs the latest trade to be processed. "Accepted" also needs it
 * to be the speaker's own offer: the patterns ("you accepted", "accepted my offer") say the
 * counterpart took the speaker's offer, which is false of an offer of theirs the agent accepted.
 */
export function supportedTradeClaims(input: {
  counterpart: string | null;
  /** Teams this turn sent an offer to. */
  offeredTo: readonly string[];
  /** The team's trades, newest first, as read before this turn's moves. */
  trades: readonly TradeLine[];
}): TradeStatusClaim[] {
  const { counterpart } = input;
  if (counterpart === null) return input.offeredTo.length > 0 ? ['sent'] : [];
  // An offer sent just now is the latest trade between them: only "sent" is true of it.
  if (input.offeredTo.includes(counterpart)) return ['sent'];
  const latest = input.trades.find((t) => t.teamId === counterpart);
  if (latest === undefined) return [];
  return [
    ...(latest.status === 'processed' ? (['completed'] as const) : []),
    ...(latest.outgoing ? (['sent'] as const) : []),
    ...(latest.outgoing && ACCEPTED.has(latest.status) ? (['accepted'] as const) : [])
  ];
}
