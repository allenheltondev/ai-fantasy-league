import {
  answeredBefore,
  asksSomething,
  checkSocialAct,
  continuationAddressee,
  emptySocialActs,
  looksLikeInstructions,
  mayHear,
  selectSocialAct,
  socialActPack,
  type MemoryAudience,
  type MemoryVisibility,
  type SocialCandidate,
  type SocialEvidence,
  type SocialReason
} from '@fantasy/core';
import type {
  Capability,
  Delivery,
  Disposition,
  Observation,
  Operation,
  OperationIssue,
  ParticipantIdentity,
  ParticipantMemory
} from './contract.js';

/**
 * A second domain for the persistent-participant contract (#213, ADR 009): a shopkeeper in a
 * trading game, with in-memory adapters and no infrastructure. Players and the shopkeeper share one
 * operation boundary (`OPERATIONS`); the shopkeeper decides deterministically (prices, holds) and
 * a model, when present, only words the decision; chat never carries authority; what a player
 * whispers stays in the whisper, before any prompt is built.
 *
 * Reused from the fantasy managers unchanged: chat addressing (`continuationAddressee`), explicit
 * answering (`answeredBefore`), request detection (`asksSomething`), the orders-in-chat check
 * (`looksLikeInstructions`), memory visibility (`mayHear`), and the grounded social-act selector
 * and its checks. Written for this domain: the operations, the pricing and hold policy, the hold
 * lifecycle, and the memory store. See ADR 009 for the full account.
 */

// ---------------------------------------------------------------------------
// The world and its operations
// ---------------------------------------------------------------------------

export const SHOPKEEPER = 'keeper';
export const SHOP_ROOM = 'shop';
export const whisperRoom = (player: string) => `whisper-${player}`;

export interface Item {
  id: string;
  name: string;
  price: number;
  stock: number;
}

export interface Hold {
  id: string;
  itemId: string;
  forPlayer: string;
  until: string;
  status: 'held' | 'sold' | 'expired';
  /** The message that asked for it: a hold is a commitment with a source. */
  sourceMessageId: string;
}

export interface ShopMessage {
  id: string;
  roomId: string;
  kind: 'user' | 'agent' | 'system';
  author: { teamId: string | null };
  text: string;
  mentionedTeamIds: string[];
  addressedTeamIds?: string[];
  replyToId?: string | null;
  answersMessageIds?: string[];
  createdAt: string;
}

export interface ShopState {
  now: string;
  items: Map<string, Item>;
  coins: Map<string, number>;
  /** Per-player discounts the shopkeeper granted (percent), by operation only. */
  discounts: Map<string, number>;
  holds: Hold[];
  sales: { player: string; itemId: string; price: number; at: string }[];
  messages: ShopMessage[];
}

export function newShop(now: string, items: Item[], coins: Record<string, number>): ShopState {
  return {
    now,
    items: new Map(items.map((i) => [i.id, { ...i }])),
    coins: new Map(Object.entries(coins)),
    discounts: new Map(),
    holds: [],
    sales: [],
    messages: []
  };
}

const issue = (code: string, message: string): OperationIssue => ({ code, message });
const onlyKeeper = (actor: string): OperationIssue[] =>
  actor === SHOPKEEPER ? [] : [issue('FORBIDDEN', 'Only the shopkeeper may do that.')];

/** What a player pays: the list price, less a discount the shopkeeper granted by operation. */
export function priceFor(state: ShopState, player: string, itemId: string): number {
  const item = state.items.get(itemId);
  if (item === undefined) return Number.POSITIVE_INFINITY;
  return Math.round(item.price * (1 - (state.discounts.get(player) ?? 0) / 100));
}

/** Stock a player may buy: what is left after holds for other players. */
function available(state: ShopState, player: string, itemId: string): number {
  const held = state.holds.filter(
    (h) => h.status === 'held' && h.itemId === itemId && h.forPlayer !== player
  );
  return (state.items.get(itemId)?.stock ?? 0) - held.length;
}

export const buy: Operation<ShopState, { itemId: string }, { price: number }> = {
  name: 'buy',
  validate(state, actor, { itemId }) {
    if (!state.items.has(itemId)) return [issue('NOT_FOUND', 'No such item.')];
    if (actor === SHOPKEEPER) return [issue('FORBIDDEN', 'The shopkeeper does not buy its own stock.')];
    if (available(state, actor, itemId) <= 0) return [issue('OUT_OF_STOCK', 'None left for you.')];
    if ((state.coins.get(actor) ?? 0) < priceFor(state, actor, itemId))
      return [issue('INSUFFICIENT_COINS', 'Not enough coins.')];
    return [];
  },
  commit(state, actor, { itemId }) {
    const price = priceFor(state, actor, itemId);
    const item = state.items.get(itemId) as Item;
    item.stock--;
    state.coins.set(actor, (state.coins.get(actor) ?? 0) - price);
    const hold = state.holds.find((h) => h.status === 'held' && h.itemId === itemId && h.forPlayer === actor);
    if (hold !== undefined) hold.status = 'sold';
    state.sales.push({ player: actor, itemId, price, at: state.now });
    return { price };
  }
};

export const holdItem: Operation<
  ShopState,
  { itemId: string; forPlayer: string; until: string; sourceMessageId: string },
  Hold
> = {
  name: 'hold',
  validate(state, actor, input) {
    const own = onlyKeeper(actor);
    if (own.length > 0) return own;
    if (available(state, input.forPlayer, input.itemId) <= 0)
      return [issue('OUT_OF_STOCK', 'Nothing to hold.')];
    if (
      state.holds.some(
        (h) => h.status === 'held' && h.itemId === input.itemId && h.forPlayer === input.forPlayer
      )
    )
      return [issue('DUPLICATE_HOLD', 'Already held for them.')];
    if (input.until <= state.now) return [issue('INVALID_INPUT', 'A hold must end in the future.')];
    return [];
  },
  commit(state, _actor, input) {
    const hold: Hold = { id: `hold:${input.sourceMessageId}`, status: 'held', ...input };
    state.holds.push(hold);
    return hold;
  }
};

export const offerDiscount: Operation<ShopState, { player: string; percent: number }, void> = {
  name: 'offer_discount',
  validate(_state, actor, { percent }) {
    const own = onlyKeeper(actor);
    if (own.length > 0) return own;
    return percent < 0 || percent > DISCOUNT_CAP ? [issue('INVALID_INPUT', `At most ${DISCOUNT_CAP}%.`)] : [];
  },
  commit(state, _actor, { player, percent }) {
    state.discounts.set(player, percent);
  }
};

/** The most a discount may be, whatever anyone says. */
export const DISCOUNT_CAP = 15;

/** Runs an operation through its validation: the one path for people and the shopkeeper alike. */
export function perform<I, O>(
  state: ShopState,
  op: Operation<ShopState, I, O>,
  actor: string,
  input: I
): { ok: true; result: O } | { ok: false; issues: OperationIssue[] } {
  const issues = op.validate(state, actor, input);
  return issues.length > 0 ? { ok: false, issues } : { ok: true, result: op.commit(state, actor, input) };
}

// ---------------------------------------------------------------------------
// In-memory adapters
// ---------------------------------------------------------------------------

type ShopEvent =
  { kind: 'sale'; player: string; itemId: string } | { kind: 'whisper'; player: string; text: string };

export function inMemoryMemory(): ParticipantMemory<ShopEvent> & { all: Observation<ShopEvent>[] } {
  const all: Observation<ShopEvent>[] = [];
  return {
    all,
    remember: (o) => void all.push(o),
    // Filtered before any prompt: a whisper is heard only by its player (#206's `mayHear`).
    forAudience: (audience) => all.filter((o) => mayHear(o.visibility, audience, () => true))
  };
}

export function inMemoryDelivery(): Delivery & { claims: Map<string, string> } {
  const claims = new Map<string, string>();
  return {
    claims,
    claimOnce(key, owner) {
      const held = claims.get(key);
      if (held !== undefined && held !== owner) return false;
      claims.set(key, owner);
      return true;
    },
    release(key, owner) {
      if (claims.get(key) === owner) claims.delete(key);
    }
  };
}

const whisperVisibility = (player: string): MemoryVisibility => ({
  teams: [player],
  trades: [],
  waiverClaims: []
});

// ---------------------------------------------------------------------------
// The participant
// ---------------------------------------------------------------------------

/** Words for a decision (a model in production); null or a throw falls back to the template. */
export type Worder = (pack: { purpose: string; facts: string[] }) => string | null;

export interface ShopReply {
  decision: 'hold' | 'price' | 'refuse_orders' | 'chat';
  message: ShopMessage;
  /** The operation it committed, if any. */
  committed: string | null;
  /** Whether the words came from the model (else the deterministic template). */
  worded: boolean;
}

export const LOYALTY = { purchases: 3, percent: 10 } as const;

export class Shopkeeper {
  readonly identity: ParticipantIdentity = {
    id: SHOPKEEPER,
    displayName: 'Mara the Merchant',
    tenure: '2026-01-01'
  };
  readonly disposition: Disposition = {
    voice: 'dry, fair, a little proud',
    chattiness: 0.6,
    persuadability: 0
  };
  readonly memory = inMemoryMemory();
  readonly delivery = inMemoryDelivery();
  #social = emptySocialActs();
  #n = 0;

  constructor(
    readonly state: ShopState,
    readonly worder: Worder | null = null
  ) {}

  /** Observe: a sale is public; a whisper is heard only by its player. */
  observe(message: ShopMessage): void {
    this.state.messages.push(message);
    const player = message.author.teamId;
    if (message.kind === 'user' && player !== null && message.roomId === whisperRoom(player))
      this.memory.remember({
        id: message.id,
        at: message.createdAt,
        event: { kind: 'whisper', player, text: message.text },
        visibility: whisperVisibility(player)
      });
  }

  recordSale(player: string, itemId: string): void {
    this.memory.remember({
      id: `sale:${this.state.sales.length}`,
      at: this.state.now,
      event: { kind: 'sale', player, itemId },
      visibility: 'public'
    });
  }

  /** Attend: a whisper, a mention, or a player still talking to it (the fantasy rule, unchanged). */
  addressed(message: ShopMessage): boolean {
    if (message.kind !== 'user' || message.author.teamId === null) return false;
    if (
      message.roomId.startsWith('whisper-') ||
      message.mentionedTeamIds.includes(SHOPKEEPER) ||
      (message.addressedTeamIds ?? []).includes(SHOPKEEPER)
    )
      return true;
    const before = this.state.messages.filter((m) => m.roomId === message.roomId && m.id !== message.id);
    return (
      continuationAddressee({
        author: { kind: 'user', teamId: message.author.teamId },
        mentioned: message.mentionedTeamIds,
        dm: false,
        recent: [...before].reverse(),
        now: message.createdAt
      }) === SHOPKEEPER
    );
  }

  /** The player's messages to it in that room it has not answered, oldest first (explicit, #215). */
  pending(roomId: string, player: string): ShopMessage[] {
    const newestFirst = this.state.messages.filter((m) => m.roomId === roomId).reverse();
    return newestFirst
      .filter(
        (m, i) =>
          m.author.teamId === player && this.addressed(m) && !answeredBefore(newestFirst, i, SHOPKEEPER)
      )
      .reverse();
  }

  /** One reply to everything the player has pending in the room: decide, commit, then word it. */
  respond(roomId: string, player: string, taskId: string): ShopReply | null {
    const open = this.pending(roomId, player);
    const target = open.at(-1);
    if (target === undefined || !this.delivery.claimOnce(`reply#${target.id}`, taskId)) return null;
    const capability = this.#capability(open, player);
    const prep = capability.prepare();
    const decision = capability.decide(prep);
    const text = capability.explain(prep, decision);
    const message: ShopMessage = {
      id: `keeper-${++this.#n}`,
      roomId,
      kind: 'agent',
      author: { teamId: SHOPKEEPER },
      text,
      mentionedTeamIds: [],
      replyToId: target.id,
      answersMessageIds: open.slice(0, -1).map((m) => m.id),
      createdAt: this.state.now
    };
    this.state.messages.push(message);
    return { decision: decision.kind, message, committed: decision.committed, worded: decision.worded };
  }

  #capability(
    open: ShopMessage[],
    player: string
  ): Capability<
    { player: string; texts: string[]; purchases: number; item: Item | null; orders: boolean; asks: boolean },
    { kind: ShopReply['decision']; committed: string | null; facts: string[]; worded: boolean }
  > {
    const state = this.state;
    const { memory, worder } = this;
    return {
      prepare() {
        const texts = open.map((m) => m.text);
        const all = texts.join(' ').toLowerCase();
        const item = [...state.items.values()].find((i) => all.includes(i.name.toLowerCase())) ?? null;
        return {
          player,
          texts,
          // Its own records only: public sales it saw, never a claim in chat.
          purchases: memory
            .forAudience({ teams: [player] })
            .filter((o) => o.event.kind === 'sale' && o.event.player === player).length,
          item,
          orders: texts.some(looksLikeInstructions),
          asks: texts.some(asksSomething)
        };
      },
      decide(prep) {
        const all = prep.texts.join(' ').toLowerCase();
        if (prep.item !== null && /\bhold\b|\bsave\b|\breserve\b/.test(all)) {
          const source = open.at(-1) as ShopMessage;
          const until = new Date(Date.parse(state.now) + 24 * 3_600_000).toISOString();
          const held = perform(state, holdItem, SHOPKEEPER, {
            itemId: prep.item.id,
            forPlayer: prep.player,
            until,
            sourceMessageId: source.id
          });
          return {
            kind: 'hold',
            committed: held.ok ? 'hold' : null,
            facts: [
              held.ok
                ? `Holding ${prep.item.name} for you until tomorrow.`
                : `Cannot hold ${prep.item.name}: ${held.issues[0]?.code}.`
            ],
            worded: false
          };
        }
        if (prep.item !== null && prep.asks) {
          // The price is the shopkeeper's rule, never the chat's: loyalty earns a discount.
          const loyal = prep.purchases >= LOYALTY.purchases;
          if (loyal)
            perform(state, offerDiscount, SHOPKEEPER, { player: prep.player, percent: LOYALTY.percent });
          const price = priceFor(state, prep.player, prep.item.id);
          return {
            kind: prep.orders ? 'refuse_orders' : 'price',
            committed: loyal ? 'offer_discount' : null,
            facts: [
              `${prep.item.name} is ${price} coins for you${loyal ? ` (${LOYALTY.percent}% off for a regular)` : ''}.`,
              ...(prep.orders ? ['Orders in chat change no price.'] : [])
            ],
            worded: false
          };
        }
        return {
          kind: prep.orders ? 'refuse_orders' : 'chat',
          committed: null,
          facts: ['Browse all you like.'],
          worded: false
        };
      },
      explain(_prep, decision) {
        // A model may word it; the decision above stands either way (the fallback is the facts).
        try {
          const worded = worder?.({ purpose: decision.kind, facts: decision.facts }) ?? null;
          if (worded !== null && worded.trim() !== '') {
            decision.worded = true;
            return worded.trim();
          }
        } catch {
          // A failed model is a quiet fallback, as in the fantasy runtime.
        }
        return decision.facts.join(' ');
      }
    };
  }

  /** Once a day: expire lapsed holds (explicit outcomes), then maybe one grounded public remark. */
  dayStart(seed: string): { expired: string[]; remark: string | null; dropped: string[] } {
    const expired = this.state.holds
      .filter((h) => h.status === 'held' && h.until <= this.state.now)
      .map((h) => {
        h.status = 'expired';
        return h.id;
      });
    const evidence: SocialEvidence[] = [];
    const candidates: SocialCandidate[] = [];
    const audience: MemoryAudience = 'public';
    for (const o of this.memory.all.slice(-5)) {
      const id = `obs:${o.id}`;
      const line =
        o.event.kind === 'sale'
          ? `${o.event.player} bought ${this.state.items.get(o.event.itemId)?.name ?? o.event.itemId}.`
          : `${o.event.player} whispered: ${o.event.text}`;
      evidence.push({ id, line, at: o.at, visibility: o.visibility });
      candidates.push({
        act: 'callback',
        // The selector's reasons are fantasy words: a second domain needs the union widened (ADR 009).
        reason: 'regular_customer' as unknown as SocialReason,
        counterpartTeamId: o.event.player,
        subject: `${o.event.player}'s ${o.event.kind}`,
        topic: `callback:${o.id}`,
        eventKey: `callback:${o.id}`,
        roomId: SHOP_ROOM,
        audience,
        evidence: [id],
        at: o.at,
        expiresAt: new Date(Date.parse(this.state.now) + 3_600_000).toISOString(),
        human: false,
        relevance: 0.9,
        salience: 0.5,
        agendaId: null,
        commitmentId: null,
        replyToId: null
      });
    }
    const selection = selectSocialAct({
      now: this.state.now,
      taskId: `day:${seed}`,
      seed,
      personality: {
        chattiness: this.disposition.chattiness,
        persuadability: this.disposition.persuadability
      },
      candidates,
      evidence,
      history: this.#social,
      postsLeft: null,
      lastWord: []
    });
    const dropped = selection.dropped
      .filter((d) => d.why === 'private_evidence')
      .map((d) => d.candidate.topic);
    if (selection.chosen === null) return { expired, remark: null, dropped };
    const pack = socialActPack(selection.chosen, evidence);
    const first = pack.facts[0] as { id: string; line: string };
    const check = checkSocialAct(pack, { message: `A regular! ${first.line}`, evidence: [first.id] });
    return { expired, remark: check.ok ? check.message : null, dropped };
  }
}
