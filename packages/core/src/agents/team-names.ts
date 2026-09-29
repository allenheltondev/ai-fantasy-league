import { CHAT_BLOCKLIST, moderateChatText, normalizeForBlocklist } from '../chat/moderation.js';
import { seededRandom } from '../schedule/random.js';

/**
 * Team names an AI manager picks for itself (#194). Pure rules shared by the server (`rename_team`
 * checks an agent's name with `teamNameIssue`), the agent router (which teams still have a generic
 * name, and when a rebrand may happen), and the naming task.
 */

/** Who last set a team's name. `default` is the seat's own "Team N" (or a name the agent may replace). */
export const NAME_SET_BY = ['owner', 'commissioner', 'agent', 'default'] as const;
export type NameSetBy = (typeof NAME_SET_BY)[number];

/** Length of a name an AI manager picks (people may use 1-40). */
export const AGENT_TEAM_NAME = { min: 3, max: 30 } as const;

/**
 * Whether an AI manager may rename its team: its seat lets it (`namesTeam`, on unless turned off)
 * and the name is not one the commissioner set and locked. The commissioner's choice always wins.
 */
export function agentMayRename(
  config: { namesTeam?: boolean | undefined } | null | undefined,
  nameSetBy: NameSetBy | undefined
): boolean {
  return config?.namesTeam !== false && nameSetBy !== 'commissioner';
}

/** Case- and space-insensitive form of a name, for comparisons. */
export function teamNameKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

export interface TeamNameOwner {
  /** The name of whoever manages the team (the AI manager, or the person). */
  managerName?: string | null;
}

/**
 * True for a name nobody really chose: empty, "Team 3", the "<manager>'s Team" default, or just the
 * manager's own name. An AI manager with a generic name names its team.
 */
export function isGenericTeamName(name: string, team: TeamNameOwner = {}): boolean {
  const key = teamNameKey(name);
  if (key === '' || key === 'team') return true;
  if (/^team\s*(#|no\.?)?\s*\d+$/.test(key)) return true;
  if (/^.+['’]s? team$/.test(key)) return true;
  const manager = team.managerName == null ? '' : teamNameKey(team.managerName);
  return manager !== '' && (key === manager || key === `team ${manager}`);
}

/**
 * Words a team name may not contain (normalized like chat moderation). Team names show up on every
 * page of the league, so the line is stricter than chat's: slurs and the strongest profanity.
 */
export const TEAM_NAME_BLOCKLIST: readonly string[] = [
  ...CHAT_BLOCKLIST,
  'fuck',
  'fucking',
  'fucker',
  'motherfucker',
  'shit',
  'cunt',
  'bitch',
  'bitches',
  'whore',
  'slut',
  'cock',
  'dick',
  'pussy',
  'nazi',
  'nigger',
  'nigga',
  'faggot',
  'fag',
  'retard',
  'retarded',
  'tranny',
  'spic',
  'chink',
  'kike',
  'wetback',
  'gook',
  'raghead',
  'towelhead',
  'dyke'
];

export type TeamNameIssueCode = 'length' | 'generic' | 'blocked' | 'taken' | 'impersonation';

export interface TeamNameIssue {
  code: TeamNameIssueCode;
  message: string;
  /** Written for a model: how to pick a name that passes. */
  fix: string;
}

export interface TeamNameContext {
  /** The naming team's own manager. */
  self: TeamNameOwner;
  /** Every other team: its name and the name of whoever manages it. */
  others: readonly { name: string; managerName?: string | null }[];
}

/** Whole-word (space-bounded) containment on normalized text. */
function containsName(normalizedName: string, person: string): boolean {
  const who = normalizeForBlocklist(person).trim();
  return who.length >= 3 && normalizedName.includes(` ${who} `);
}

/**
 * Why an AI manager cannot use `raw` as its team name, or null when it can: 3-30 characters, not
 * generic, nothing on the blocklist, unique in the league (ignoring case and spaces), and no other
 * manager's name in it (no impersonation).
 */
export function teamNameIssue(raw: string, context: TeamNameContext): TeamNameIssue | null {
  const moderated = moderateChatText(raw, TEAM_NAME_BLOCKLIST);
  const name = moderated.ok ? moderated.text : raw.trim();
  if (name.length < AGENT_TEAM_NAME.min || name.length > AGENT_TEAM_NAME.max || /[\n\t]/.test(name)) {
    return {
      code: 'length',
      message: `"${name}" is not ${AGENT_TEAM_NAME.min}-${AGENT_TEAM_NAME.max} characters on one line.`,
      fix: `Pick a team name of ${AGENT_TEAM_NAME.min}-${AGENT_TEAM_NAME.max} characters on one line.`
    };
  }
  if (!moderated.ok && moderated.reason === 'blocked') {
    return {
      code: 'blocked',
      message: 'That team name breaks the league rules.',
      fix: 'Pick a name without slurs, strong profanity, or wishing harm on anyone. Wordplay and puns are the way to go.'
    };
  }
  if (isGenericTeamName(name, context.self)) {
    return {
      code: 'generic',
      message: `"${name}" is a placeholder, not a team name.`,
      fix: 'Pick a real name with some personality, not "Team N", "<name>\'s Team", or your own name.'
    };
  }
  const key = teamNameKey(name);
  const taken = context.others.find((o) => teamNameKey(o.name) === key);
  if (taken !== undefined) {
    return {
      code: 'taken',
      message: `Another team is already named "${taken.name}".`,
      fix: 'Pick a different name; names must be unique in the league, ignoring case and spaces.'
    };
  }
  const normalized = normalizeForBlocklist(name);
  const copied = context.others.find((o) => o.managerName != null && containsName(normalized, o.managerName));
  if (copied !== undefined) {
    return {
      code: 'impersonation',
      message: `"${name}" uses another manager's name (${copied.managerName}).`,
      fix: "Leave other managers' names out of your team name, so nobody mistakes it for theirs."
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// In-character rebrands
// ---------------------------------------------------------------------------

/** Hard limits on a rebrand: at most one per team in this many weeks, after this long a losing streak. */
export const REBRAND_RULES = { cooldownWeeks: 4, losingStreak: 3 } as const;

/** What moves an AI manager to rebrand. */
export type RebrandOccasion = 'losing_streak' | 'clinched' | 'trade_deadline';

export type RebrandWindow = 'ok' | 'phase' | 'cooldown';

/**
 * Whether a team may rebrand at all this week: only in the regular season (never in the playoffs
 * or once the league is complete), and at most once in `REBRAND_RULES.cooldownWeeks` weeks.
 */
export function rebrandWindow(input: {
  phase: string;
  week: number | null;
  /** The week of the team's last rebrand or naming by its agent; null when it never renamed. */
  lastRenameWeek: number | null;
}): RebrandWindow {
  if (input.phase !== 'regular_season' || input.week === null) return 'phase';
  if (input.lastRenameWeek !== null && input.week - input.lastRenameWeek < REBRAND_RULES.cooldownWeeks)
    return 'cooldown';
  return 'ok';
}

/** The personality's roll (seeded, so a replayed event rolls the same). */
export function rebrandRoll(propensity: number, seed: string): boolean {
  return propensity > 0 && seededRandom(`rebrand:${seed}`)() < propensity;
}

/** Losses in a row from a standings streak ("L3" is 3; a win or tie streak is 0). */
export function losingStreak(streak: string | null): number {
  const match = /^L(\d+)$/.exec(streak ?? '');
  return match === null ? 0 : Number(match[1]);
}

export interface StandingLine {
  teamId: string;
  wins: number;
  losses: number;
  ties: number;
}

/**
 * True when no finish of the remaining `gamesLeft` weeks can push the team out of the top
 * `playoffTeams`: fewer than `playoffTeams` other teams can still reach its win total. Ties
 * count half a win, and a team that could tie it counts as a threat (conservative: tiebreakers are
 * not guessed).
 */
export function clinchedPlayoffSpot(
  rows: readonly StandingLine[],
  teamId: string,
  gamesLeft: number,
  playoffTeams: number
): boolean {
  const me = rows.find((r) => r.teamId === teamId);
  // Where every team makes the playoffs, nobody clinched anything.
  if (me === undefined || playoffTeams <= 0 || rows.length <= playoffTeams) return false;
  const score = (r: StandingLine) => r.wins + r.ties / 2;
  const threats = rows.filter((r) => r.teamId !== teamId && score(r) + Math.max(0, gamesLeft) >= score(me));
  return threats.length < playoffTeams;
}

/**
 * The rebrand moment this week, if any: a losing streak of `REBRAND_RULES.losingStreak` or more
 * ("fresh start"), a clinched playoff spot ("a champion's name"), or the trade deadline week.
 */
export function rebrandOccasion(input: {
  week: number;
  streak: string | null;
  clinched: boolean;
  tradeDeadlineWeek: number;
}): RebrandOccasion | null {
  if (losingStreak(input.streak) >= REBRAND_RULES.losingStreak) return 'losing_streak';
  if (input.clinched) return 'clinched';
  if (input.week === input.tradeDeadlineWeek) return 'trade_deadline';
  return null;
}

/** How each occasion is put to the agent. */
export const REBRAND_PROMPTS: Readonly<Record<RebrandOccasion, string>> = {
  losing_streak:
    'Your team has lost several games in a row. You want a fresh start: a new name to shake off the slump.',
  clinched: 'Your team just clinched a playoff spot. It deserves a champion’s name for the run ahead.',
  trade_deadline:
    'The trade deadline is here: the roster is set for the stretch run, and you want a name to match.'
};
