/**
 * The notification inbox (#165): which league events are news to which team, and what the inbox
 * item says. Pure: the server's events consumer (`packages/server/src/notifications/`) turns each
 * draft into a stored item for a team with a person on the seat (agent-only teams get none) and
 * pushes it to that team's private topic.
 *
 * A draft is addressed to one team and never to the team that caused the change: the team that
 * proposes, counters, accepts, rejects, or withdraws a trade already knows. Each draft has a `key`
 * unique within its event, so a redelivered event stores nothing new.
 */

export const NOTIFICATION_KINDS = [
  'trade_offer',
  'trade_countered',
  'trade_accepted',
  'trade_rejected',
  'trade_withdrawn',
  'trade_expired',
  'trade_vetoed',
  'trade_processed',
  'waiver_won',
  'waiver_lost',
  'draft_on_clock',
  'player_status',
  'player_news'
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** The league sections a notification opens. */
export const NOTIFICATION_SECTIONS = ['trades', 'roster', 'draft', 'lineup'] as const;
export type NotificationSection = (typeof NOTIFICATION_SECTIONS)[number];

export interface NotificationTarget {
  section: NotificationSection;
  /** The trade to open, for trade notifications. */
  tradeId: string | null;
  /** The player to highlight, for player notifications (#200). */
  playerId?: string | null;
}

export interface NotificationDraft {
  teamId: string;
  /** Unique within the event (`''` when the event makes one item per team). */
  key: string;
  kind: NotificationKind;
  title: string;
  body: string;
  target: NotificationTarget;
  /** Needs action now (#200: a starter ruled out before his game); shown first and in red. */
  urgent?: boolean;
}

export interface NotificationContext {
  /** A team's display name, or null when unknown. */
  teamName(teamId: string): string | null;
}

/** Event types that may notify someone (for the EventBridge rule and tests). */
export const NOTIFICATION_EVENTS = [
  'Trade Proposed',
  'Trade Countered',
  'Trade Accepted',
  'Trade Rejected',
  'Trade Withdrawn',
  'Trade Expired',
  'Trade Vetoed',
  'Trade Processed',
  'Waivers Processed',
  'Draft Turn Started'
] as const;

type Detail = Record<string, unknown>;

const text = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function playerName(v: unknown): string | null {
  if (typeof v === 'string') return text(v);
  return v !== null && typeof v === 'object' ? text((v as { name?: unknown }).name) : null;
}

/** "A, B and C", or `none` for an empty list. */
export function joinNames(names: readonly string[], none = 'nothing'): string {
  if (names.length === 0) return none;
  if (names.length === 1) return names[0] as string;
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1) as string}`;
}

const players = (v: unknown): string => joinNames(list(v).flatMap((p) => playerName(p) ?? []));

/** Every notification an event produces, one per addressed team (at most two per team). */
export function notificationDrafts(
  detailType: string,
  detail: Detail,
  ctx: NotificationContext
): NotificationDraft[] {
  if (detailType.startsWith('Trade ')) return tradeDrafts(detailType, detail, ctx);
  if (detailType === 'Waivers Processed') return waiverDrafts(detail);
  if (detailType === 'Draft Turn Started') return draftTurnDrafts(detail);
  return [];
}

function tradeDrafts(detailType: string, detail: Detail, ctx: NotificationContext): NotificationDraft[] {
  const from = text(detail.fromTeamId);
  const to = text(detail.toTeamId);
  const tradeId = text(detail.tradeId);
  if (from === null || to === null || tradeId === null) return [];
  const name = (id: string) => ctx.teamName(id) ?? 'The other team';
  const target: NotificationTarget = { section: 'trades', tradeId };
  // What each side would get and give, from its own point of view.
  const view = (teamId: string) => {
    const mine = teamId === from;
    return {
      get: players(mine ? detail.toPlayers : detail.fromPlayers),
      give: players(mine ? detail.fromPlayers : detail.toPlayers),
      other: name(mine ? to : from)
    };
  };
  const one = (teamId: string, kind: NotificationKind, title: string, body: string): NotificationDraft => ({
    teamId,
    key: '',
    kind,
    title,
    body,
    target
  });
  const both = (build: (teamId: string) => NotificationDraft) => [build(from), build(to)];
  switch (detailType) {
    case 'Trade Proposed': {
      const v = view(to);
      return [one(to, 'trade_offer', `Trade offer from ${v.other}`, `You'd get ${v.get} for ${v.give}.`)];
    }
    case 'Trade Countered': {
      // A counter is a new offer from the countering team (`from`) back to the original proposer.
      const v = view(to);
      return [
        one(to, 'trade_countered', `${v.other} countered your offer`, `You'd get ${v.get} for ${v.give}.`)
      ];
    }
    case 'Trade Accepted': {
      const v = view(from);
      const review =
        detail.review === 'none' ? 'It goes through now.' : 'It goes to review before the players move.';
      return [
        one(
          from,
          'trade_accepted',
          `${v.other} accepted your trade`,
          `You get ${v.get} for ${v.give}. ${review}`
        )
      ];
    }
    case 'Trade Rejected': {
      const v = view(from);
      return [
        one(from, 'trade_rejected', `${v.other} rejected your offer`, `You offered ${v.give} for ${v.get}.`)
      ];
    }
    case 'Trade Withdrawn': {
      const v = view(to);
      return [
        one(
          to,
          'trade_withdrawn',
          `${v.other} withdrew its offer`,
          `It had offered you ${v.get} for ${v.give}.`
        )
      ];
    }
    case 'Trade Expired':
      return both((teamId) => {
        const v = view(teamId);
        const why =
          detail.voided === true
            ? (text(detail.reason) ?? 'A player in it changed rosters.')
            : 'Nobody answered it in time.';
        return one(
          teamId,
          'trade_expired',
          `Your trade with ${v.other} expired`,
          `${v.get} for ${v.give}. ${why}`
        );
      });
    case 'Trade Vetoed':
      return both((teamId) => {
        const v = view(teamId);
        return detail.voided === true
          ? one(
              teamId,
              'trade_vetoed',
              `Your trade with ${v.other} was cancelled`,
              `${text(detail.reason) ?? 'It no longer works with the current rosters.'} No players moved.`
            )
          : one(
              teamId,
              'trade_vetoed',
              `Your trade with ${v.other} was vetoed`,
              `No players moved: you keep ${v.give}.`
            );
      });
    case 'Trade Processed':
      return both((teamId) => {
        const v = view(teamId);
        return {
          ...one(teamId, 'trade_processed', `Trade complete with ${v.other}`, processedBody(v.get, v.give)),
          target: { section: 'roster', tradeId }
        };
      });
    default:
      return [];
  }
}

function processedBody(get: string, give: string): string {
  if (get === 'nothing') return `${give} left your roster.`;
  if (give === 'nothing') return `${get} joined your roster.`;
  return `${get} joined your roster; ${give} left.`;
}

interface LostClaim {
  teamId: string;
  name: string;
  reason: string;
}

function waiverDrafts(detail: Detail): NotificationDraft[] {
  const won = new Map<string, string[]>();
  for (const raw of list(detail.awarded)) {
    const award = (raw ?? {}) as { teamId?: unknown; player?: unknown; playerId?: unknown; cost?: unknown };
    const teamId = text(award.teamId);
    if (teamId === null) continue;
    const name = playerName(award.player) ?? text(award.playerId) ?? 'a player';
    const cost = typeof award.cost === 'number' && award.cost > 0 ? ` ($${award.cost})` : '';
    won.set(teamId, [...(won.get(teamId) ?? []), `${name}${cost}`]);
  }
  const lost = new Map<string, LostClaim[]>();
  for (const raw of list(detail.lost)) {
    const claim = (raw ?? {}) as { teamId?: unknown; player?: unknown; playerId?: unknown; reason?: unknown };
    const teamId = text(claim.teamId);
    if (teamId === null) continue;
    const entry = {
      teamId,
      name: playerName(claim.player) ?? text(claim.playerId) ?? 'a player',
      reason: text(claim.reason) ?? 'The claim did not go through.'
    };
    lost.set(teamId, [...(lost.get(teamId) ?? []), entry]);
  }
  const drafts: NotificationDraft[] = [];
  const roster: NotificationTarget = { section: 'roster', tradeId: null };
  for (const [teamId, names] of won) {
    drafts.push({
      teamId,
      key: 'won',
      kind: 'waiver_won',
      title: names.length === 1 ? 'Waiver claim won' : `You won ${names.length} waiver claims`,
      body: `Added to your roster: ${joinNames(names)}.`,
      target: roster
    });
  }
  for (const [teamId, claims] of lost) {
    drafts.push({
      teamId,
      key: 'lost',
      kind: 'waiver_lost',
      title:
        claims.length === 1 ? `Waiver claim lost: ${claims[0]?.name}` : `${claims.length} waiver claims lost`,
      body: claims.map((c) => (claims.length === 1 ? c.reason : `${c.name}: ${c.reason}`)).join(' '),
      target: roster
    });
  }
  return drafts;
}

function draftTurnDrafts(detail: Detail): NotificationDraft[] {
  const teamId = text(detail.teamId);
  if (teamId === null) return [];
  const round = typeof detail.round === 'number' ? detail.round : null;
  const pick = typeof detail.pick === 'number' ? detail.pick : null;
  return [
    {
      teamId,
      key: '',
      kind: 'draft_on_clock',
      title: "You're on the clock",
      body:
        pick === null
          ? 'Make your pick in the draft room.'
          : `Pick ${pick}${round === null ? '' : ` (round ${round})`} is yours. Make it in the draft room.`,
      target: { section: 'draft', tradeId: null }
    }
  ];
}
