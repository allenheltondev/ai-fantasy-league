/**
 * Checks on the free-form posts an agent writes itself (#264): a check-in's board post, matchup
 * talk, and goal DM. Grounded social acts have their own check against their facts
 * (`checkSocialAct`); these posts have no evidence ids, so they are read for what a free-form post
 * has got wrong live (#247's evaluation):
 *
 * - **Action claims** (#264): "Offer sent.", "the trade went through", "you accepted my offer".
 *   Each sentence holding a trade-status claim the caller cannot support (the turn did not make
 *   the move, and the latest trade with that counterpart never reached the status) is cut. A post
 *   with nothing left is withheld (`unsupported_claim`).
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
}

export type PostCheck =
  | { ok: true; message: string; cut: TradeStatusClaim[] }
  | { ok: false; reason: 'empty' | 'unsupported_claim' };

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
  return { ok: true, message: text, cut: [...cut] };
}

/** A trade this team is in, as its trade list shows it (newest first). */
export interface TradeLine {
  /** The other team. */
  teamId: string;
  outgoing: boolean;
  status: string;
}

const ACCEPTED: ReadonlySet<string> = new Set(['accepted', 'in_review', 'processed']);

/**
 * The trade-status claims a post may make (#264), the way #247's claim checks judge them: about the
 * latest trade with the counterpart, or, with no counterpart (a league board), about what this turn
 * did. An offer is "sent" when this turn sent the counterpart one or the latest trade with them is
 * the speaker's own; "accepted" and "completed" need the latest trade to have got that far.
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
    ...(ACCEPTED.has(latest.status) ? (['accepted'] as const) : [])
  ];
}
