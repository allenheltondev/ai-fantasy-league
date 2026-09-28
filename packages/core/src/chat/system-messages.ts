/**
 * System chat messages (issue #70): league events rendered as chat lines. The templates are data:
 * each event type lists alternatives, and the first one whose placeholders all resolve from the
 * event detail is used. Events from other work streams can carry more or less detail than expected
 * and still get a sensible line; an event type with no template (or no alternative that resolves)
 * produces no message.
 *
 * Placeholders are `{path}` (a dot path into the detail) or `{format:path}`:
 * - `team`: a team id, rendered as the team's name
 * - `teams`: a list of team ids
 * - `player`: a player ref (`{ name }`) or a name
 * - `players`: a list of player refs or names
 * - `list`: a list of strings
 * - `claims`: waiver awards, `[{ teamId, player, cost?, bid? }]` (the FAAB paid, else the bid)
 * - `points`: a number with at most two decimals
 * - `changes`: agent seat changes, `[{ field, from, to }]` ("AI difficulty from All-Pro to Rookie")
 */

/** One way to say it. A guarded alternative is used only when `when` returns true. */
export type TemplateAlternative =
  string | { text: string; when: (detail: Record<string, unknown>) => boolean };

export interface SystemTemplate {
  /** Alternatives, most specific first. */
  text: readonly TemplateAlternative[];
  /** Also a "Chat Moment": a league moment agents may react to (always, or when it returns true). */
  moment?: boolean | ((detail: Record<string, unknown>) => boolean);
  /** Detail field holding the team the moment is about. */
  subjectTeam?: string;
}

const noReview = (d: Record<string, unknown>) => d.review === 'none';

export const SYSTEM_MESSAGE_TEMPLATES: Readonly<Record<string, SystemTemplate>> = {
  // A notable pick (core `notablePick`) says why it stands out and is a moment agents may react to.
  'Draft Pick Made': {
    text: [
      {
        text: 'Steal! {team:teamId} drafted {player:player} at pick {overall}, well past his ADP of {adp}.',
        when: (d) => d.notable === 'steal'
      },
      {
        text: 'Reach? {team:teamId} drafted {player:player} at pick {overall}, well ahead of his ADP of {adp}.',
        when: (d) => d.notable === 'reach'
      },
      {
        text: '{team:teamId} opens its draft with {player:player} at pick {overall}: "{reason}"',
        when: (d) => d.notable === 'first_round'
      },
      '{team:teamId} drafted {player:player} (round {round}, pick {pick}).',
      '{team:teamId} drafted {player:player}.'
    ],
    moment: (d) => typeof d.notable === 'string',
    subjectTeam: 'teamId'
  },
  'Draft Completed': {
    text: [
      'The draft is complete. Good luck this season! {recapText}',
      'The draft is complete. Good luck this season!'
    ],
    moment: true
  },
  'Draft Paused': {
    text: ['The commissioner paused the draft at pick {pick}.', 'The commissioner paused the draft.']
  },
  'Draft Resumed': {
    text: ['The draft is back on: pick {pick} is on the clock.', 'The draft is back on.']
  },
  // A run with no awards says nothing (and is no moment): waivers run every day.
  'Waivers Processed': {
    text: ['Waivers processed for week {week}: {claims:awarded}.', 'Waivers processed: {claims:awarded}.'],
    moment: true
  },
  'Trade Accepted': {
    text: [
      {
        text: '{team:toTeamId} accepted a trade with {team:fromTeamId}: {players:fromPlayers} for {players:toPlayers}.',
        when: noReview
      },
      { text: '{team:toTeamId} accepted a trade with {team:fromTeamId}.', when: noReview },
      '{team:toTeamId} accepted a trade with {team:fromTeamId}: {players:fromPlayers} for {players:toPlayers}. It is under review.',
      '{team:toTeamId} accepted a trade with {team:fromTeamId}. It is under review.'
    ]
  },
  'Trade Processed': {
    text: [
      'Trade complete: {team:fromTeamId} sends {players:fromPlayers} to {team:toTeamId} for {players:toPlayers}.',
      'Trade complete between {team:fromTeamId} and {team:toTeamId}.'
    ],
    moment: true,
    subjectTeam: 'fromTeamId'
  },
  'Trade Vetoed': {
    text: [
      {
        text: 'The trade between {team:fromTeamId} and {team:toTeamId} was cancelled: {reason}',
        when: (d) => d.voided === true
      },
      {
        text: 'The commissioner vetoed the trade between {team:fromTeamId} and {team:toTeamId}.',
        when: (d) => d.review === 'commissioner'
      },
      'The league vetoed the trade between {team:fromTeamId} and {team:toTeamId}.',
      'A trade was vetoed.'
    ],
    moment: true,
    subjectTeam: 'fromTeamId'
  },
  'Trade Deadline Passed': {
    text: ['The trade deadline has passed. Rosters change only through waivers from here on.'],
    moment: true
  },
  'Week Provisionally Final': {
    text: [
      'Week {week} is in the books (provisional). Top score: {team:topTeamId} with {points:topScore}. Biggest blowout: {team:blowout.winnerTeamId} beat {team:blowout.loserTeamId} by {points:blowout.margin}.',
      'Week {week} is in the books (provisional). Top score: {team:topTeamId} with {points:topScore}.',
      'Week {week} is in the books (provisional).'
    ],
    moment: true,
    subjectTeam: 'topTeamId'
  },
  'Week Official Final': {
    text: ['Week {week} is official. Recap: {recap}', 'Week {week} is official; stat corrections are in.']
  },
  'Stat Correction Applied': {
    text: [
      {
        text: 'Stat correction flips week {week}: {team:winnerTeamId} now beats {team:loserTeamId}, {points:winnerScore} to {points:loserScore}.',
        when: (d) => d.resultFlipped === true && d.winnerScore !== d.loserScore
      },
      'Stat correction for {player:player} in week {week}: {team:teamId} goes from {points:oldScore} to {points:newScore}.',
      'Stat correction in week {week}: {team:teamId} goes from {points:oldScore} to {points:newScore}.',
      'A stat correction changed week {week} scores.'
    ]
  },
  'Season Completed': {
    text: [
      '{team:championTeamId} won the {season} championship, beating {team:runnerUpTeamId} in the final!',
      '{team:championTeamId} won the {season} championship!'
    ],
    moment: true,
    subjectTeam: 'championTeamId'
  },
  'Achievement Earned': {
    text: ['{team:teamId} earned {name}: {reason}.', '{team:teamId} earned {name}.']
  },
  'Model Power Rankings': {
    text: [
      'Model power rankings after week {week}: {list:lines}.',
      'Model power rankings after week {week}: {leaderModelName} leads.'
    ]
  },
  'Member Joined': {
    text: ['{name} joined the league and took over {team:teamId}.', '{team:teamId} has a new manager.']
  },
  'Member Left': {
    text: [
      {
        text: '{team:teamId} was removed from the league by the commissioner.',
        when: (d) => d.reason === 'removed'
      },
      '{team:teamId} left the league.'
    ]
  },
  // Agent seat changes after the draft are announced, so a commissioner who also plays can't
  // quietly weaken the AI teams they face.
  'Agent Seat Changed': {
    text: [
      "The commissioner changed {team:teamId}'s {changes:changes}.",
      "The commissioner changed {team:teamId}'s AI manager."
    ]
  },
  // The first time in a week the league's AI spend passes its ceiling (#93): agents play on with
  // their deterministic fallbacks until the next week.
  'Agent Budget Exceeded': {
    text: [
      'The AI managers have used this week’s model budget (${points:spentUsd} of ${points:ceilingUsd}). Until next week they play on autopilot: optimizer lineups, autopicks, no waiver claims, and they turn down trade offers.',
      'The AI managers have used this week’s model budget. Until next week they play on autopilot.'
    ]
  },
  'Settings Changed': {
    text: [
      'The commissioner changed league settings: {list:changedPaths}.',
      'The commissioner changed league settings.'
    ]
  }
};

/** A player an announcement is about, as the chat shows it on a card. */
export interface SystemPlayerRef {
  id: string;
  name: string;
  team: string | null;
  position: string;
}

export interface RenderedSystemMessage {
  text: string;
  moment: boolean;
  subjectTeamId: string | null;
  /** The players the event names (`{ id, name, team, position }` refs anywhere in its detail). */
  players: SystemPlayerRef[];
}

export interface RenderOptions {
  /** A team's display name, or null when the id is unknown. */
  teamName(teamId: string): string | null;
  templates?: Readonly<Record<string, SystemTemplate>>;
}

type Detail = Record<string, unknown>;

function at(detail: Detail, path: string): unknown {
  let value: unknown = detail;
  for (const key of path.split('.')) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    value = (value as Detail)[key];
  }
  return value;
}

const text = (v: unknown): string | null =>
  typeof v === 'string' && v.trim().length > 0
    ? v.trim()
    : typeof v === 'number' && Number.isFinite(v)
      ? String(v)
      : null;

function playerName(v: unknown): string | null {
  if (typeof v === 'string') return text(v);
  if (v !== null && typeof v === 'object') return text((v as Detail).name);
  return null;
}

function list(values: unknown, one: (v: unknown) => string | null): string | null {
  if (!Array.isArray(values) || values.length === 0) return null;
  const parts = values.map(one);
  if (parts.some((p) => p === null)) return null;
  return parts.join(', ');
}

function format(kind: string | undefined, value: unknown, options: RenderOptions): string | null {
  switch (kind) {
    case undefined:
      return text(value);
    case 'team': {
      const id = text(value);
      return id === null ? null : options.teamName(id);
    }
    case 'teams':
      return list(value, (v) => format('team', v, options));
    case 'player':
      return playerName(value);
    case 'players':
      return list(value, playerName);
    case 'list':
      return list(value, text);
    case 'points':
      return typeof value === 'number' && Number.isFinite(value)
        ? String(Math.round(value * 100) / 100)
        : null;
    case 'changes':
      return list(value, (change) => {
        if (change === null || typeof change !== 'object') return null;
        const c = change as Detail;
        const field = text(c.field);
        const from = text(c.from);
        const to = text(c.to);
        if (field === null || from === null || to === null) return null;
        return `${SEAT_FIELD_LABELS[field] ?? field} from ${from} to ${to}`;
      });
    case 'claims':
      return list(value, (claim) => {
        if (claim === null || typeof claim !== 'object') return null;
        const c = claim as Detail;
        const team = format('team', c.teamId, options);
        const player = playerName(c.player);
        if (team === null || player === null) return null;
        const paid = typeof c.cost === 'number' ? c.cost : c.bid;
        return typeof paid === 'number' ? `${team} added ${player} ($${paid})` : `${team} added ${player}`;
      });
    default:
      return null;
  }
}

/** How an agent seat field reads in a chat line. */
export const SEAT_FIELD_LABELS: Readonly<Record<string, string>> = {
  difficulty: 'AI difficulty',
  archetype: 'AI strategy',
  model: 'AI decision model',
  personality: 'AI personality'
};

const PLACEHOLDER = /\{(?:([a-z]+):)?([A-Za-z0-9_.]+)\}/g;

/** Fills one alternative, or returns null when any placeholder does not resolve. */
export function fillTemplate(template: string, detail: Detail, options: RenderOptions): string | null {
  let missing = false;
  const out = template.replace(PLACEHOLDER, (_match, kind: string | undefined, path: string) => {
    const value = format(kind, at(detail, path), options);
    if (value === null) missing = true;
    return value ?? '';
  });
  return missing ? null : out;
}

/** The system message for an event, or null when the event type has none. */
export function renderSystemMessage(
  detailType: string,
  detail: Detail,
  options: RenderOptions
): RenderedSystemMessage | null {
  const template = (options.templates ?? SYSTEM_MESSAGE_TEMPLATES)[detailType];
  if (template === undefined) return null;
  for (const alternative of template.text) {
    if (typeof alternative !== 'string' && !alternative.when(detail)) continue;
    const filled = fillTemplate(
      typeof alternative === 'string' ? alternative : alternative.text,
      detail,
      options
    );
    if (filled !== null) {
      const subject = template.subjectTeam === undefined ? null : text(at(detail, template.subjectTeam));
      return {
        text: filled,
        moment: typeof template.moment === 'function' ? template.moment(detail) : template.moment === true,
        subjectTeamId: subject,
        players: eventPlayers(detail)
      };
    }
  }
  return null;
}

const MAX_CARD_PLAYERS = 12;

function asPlayerRef(v: unknown): SystemPlayerRef | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const p = v as Detail;
  if (typeof p.id !== 'string' || typeof p.name !== 'string' || typeof p.position !== 'string') return null;
  return { id: p.id, name: p.name, team: typeof p.team === 'string' ? p.team : null, position: p.position };
}

/**
 * Every player ref in an event detail (searched two levels deep, so `player`, `awarded[].player`,
 * and `fromPlayers[]` are found), deduplicated by id, in detail order, at most 12.
 */
export function eventPlayers(detail: Detail): SystemPlayerRef[] {
  const found = new Map<string, SystemPlayerRef>();
  const visit = (value: unknown, depth: number): void => {
    const ref = asPlayerRef(value);
    if (ref !== null) {
      if (!found.has(ref.id)) found.set(ref.id, ref);
      return;
    }
    if (depth === 0 || value === null || typeof value !== 'object') return;
    for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child, depth - 1);
  };
  for (const value of Object.values(detail)) visit(value, 2);
  return [...found.values()].slice(0, MAX_CARD_PLAYERS);
}
