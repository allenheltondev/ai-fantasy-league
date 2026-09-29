import type { NotificationDraft } from './inbox.js';

/**
 * Player status and news notices for managers (#200). Pure: the server's consumer finds the teams
 * a person holds that roster the player, and says whether he starts and whether his game has
 * kicked off; this decides whether the change is news, how loud it is, and what it says.
 *
 * Intentional, not noisy: depth-chart and team moves say nothing, a repeat of the same designation
 * says nothing, and only a starter ruled out (or doubtful) before his game is urgent.
 */

/** Events that may notify a manager about one of their players. */
export const PLAYER_NOTIFICATION_EVENTS = ['Player Status Changed', 'Player News Alert'] as const;

/** A manager gets at most one news item per player in this window. */
export const PLAYER_NEWS_WINDOW_MS = 60 * 60 * 1000;

export interface NoticePlayer {
  id: string;
  name: string;
  team: string | null;
  position: string;
}

/** A designation in our terms, from the stored injury or roster status. */
export type Designation = 'questionable' | 'doubtful' | 'out' | 'ir' | 'pup' | 'suspended';

const INJURY: Record<string, Designation> = {
  questionable: 'questionable',
  doubtful: 'doubtful',
  out: 'out',
  ir: 'ir',
  'injured reserve': 'ir',
  pup: 'pup',
  suspended: 'suspended'
};

/** Would keep a starter out of this week's game. */
const SIDELINED = new Set<Designation>(['out', 'doubtful', 'ir', 'pup', 'suspended']);

const LABEL: Record<Designation, string> = {
  questionable: 'questionable',
  doubtful: 'doubtful',
  out: 'OUT',
  ir: 'on injured reserve',
  pup: 'on the PUP list',
  suspended: 'suspended'
};

const SHORT: Record<Designation, string> = {
  questionable: 'questionable',
  doubtful: 'doubtful',
  out: 'out',
  ir: 'on IR',
  pup: 'on PUP',
  suspended: 'suspended'
};

/** The designation a stored injury status stands for; null for none (or one we do not know). */
export function designationOf(value: unknown): Designation | null {
  return typeof value === 'string' ? (INJURY[value.trim().toLowerCase()] ?? null) : null;
}

export interface StatusChange {
  field: string;
  from: unknown;
  to: unknown;
}

/**
 * What a status event did to the player's designation: `from` and `to`, or null when it did not
 * move (a depth-chart or team change, or the same designation again). A move onto or off injured
 * reserve by roster status counts, when the injury status did not already say so.
 */
export function designationChange(
  changes: readonly StatusChange[]
): { from: Designation | null; to: Designation | null } | null {
  const injury = changes.find((c) => c.field === 'injuryStatus');
  const roster = changes.find((c) => c.field === 'status');
  const from = designationOf(injury?.from) ?? designationOf(roster?.from);
  const to = designationOf(injury?.to) ?? designationOf(roster?.to);
  if (injury === undefined && roster === undefined) return null;
  return from === to ? null : { from, to };
}

export interface PlayerStatusNoticeInput {
  teamId: string;
  player: NoticePlayer;
  changes: readonly StatusChange[];
  /** In the team's starting lineup this week. */
  starter: boolean;
  /** His game this week, or null on a bye: whether it has kicked off, and whether it is today. */
  game: { started: boolean; today: boolean } | null;
}

const who = (p: NoticePlayer) => `${p.name} (${p.position}, ${p.team ?? 'FA'})`;

/** The inbox item for a player's status change, or null when it is not news to the manager. */
export function playerStatusDraft(input: PlayerStatusNoticeInput): NotificationDraft | null {
  const moved = designationChange(input.changes);
  if (moved === null) return null;
  const { player, starter, game } = input;
  const target = { section: 'lineup' as const, tradeId: null, playerId: player.id };
  const base = { teamId: input.teamId, key: '', kind: 'player_status' as const, target };
  if (moved.to === null) {
    return {
      ...base,
      title: `${player.name} is off the injury report`,
      body: `${who(player)} is active${starter ? ' and in your lineup' : ''}.`
    };
  }
  const label = LABEL[moved.to];
  const when = game === null ? '' : game.today ? " for today's game" : " for this week's game";
  const upcoming = game !== null && !game.started;
  if (starter && upcoming && SIDELINED.has(moved.to)) {
    return {
      ...base,
      urgent: true,
      title: `Starter ${SHORT[moved.to]}: ${player.name}`,
      body: `Your starter ${who(player)} is ${label}${when}. Set your lineup.`
    };
  }
  const role = starter ? 'He is in your lineup.' : 'He is on your bench.';
  return {
    ...base,
    title: `${player.name} is ${SHORT[moved.to]}`,
    body: `${who(player)} is ${label}${upcoming ? when : ''}. ${role}`
  };
}

export interface PlayerNewsNoticeInput {
  teamId: string;
  player: NoticePlayer;
  title: string;
  source: string;
}

/** The inbox item for a news story about one of the manager's players. */
export function playerNewsDraft(input: PlayerNewsNoticeInput): NotificationDraft {
  const headline = input.title.trim();
  return {
    teamId: input.teamId,
    key: '',
    kind: 'player_news',
    title: `News: ${input.player.name}`,
    body: `${headline.length > 160 ? `${headline.slice(0, 159)}…` : headline} (${input.source})`,
    target: { section: 'lineup', tradeId: null, playerId: input.player.id }
  };
}
