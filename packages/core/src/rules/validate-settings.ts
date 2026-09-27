import { z } from 'zod';
import { IDP_PER_STAT, validateScoringSettings } from '../scoring/settings.js';
import { hasErrors, ruleError, ruleWarning, type RuleIssue } from './issues.js';
import { IDP_SLOTS, ROSTER_SLOTS, SLOT_ELIGIBILITY, type RosterSlot } from './positions.js';
import {
  LAST_NFL_WEEK,
  LeagueSettingsSchema,
  activeRosterSize,
  playoffRounds,
  requiredByes,
  slotCount,
  starterCount,
  type LeagueSettings
} from './settings.js';

/** NFL teams; bounds how many single-position starters (QB, K, DEF) a league can field. */
export const NFL_TEAM_COUNT = 32;
/** Largest active roster (all slots except IR) a team may carry. */
export const MAX_ACTIVE_ROSTER = 25;
/** Largest number of IR slots. */
export const MAX_IR_SLOTS = 4;

function joinPath(path: readonly PropertyKey[]): string {
  return path.map(String).join('.');
}

function knownKeysAt(path: readonly PropertyKey[]): readonly string[] {
  if (joinPath(path) === 'roster.slots') return ROSTER_SLOTS;
  let schema: unknown = LeagueSettingsSchema;
  for (const seg of path) {
    if (!(schema instanceof z.ZodObject)) return [];
    schema = (schema.shape as Record<string, unknown>)[String(seg)];
  }
  return schema instanceof z.ZodObject ? Object.keys(schema.shape as Record<string, unknown>) : [];
}

function valueAt(input: unknown, path: readonly PropertyKey[]): unknown {
  let cur: unknown = input;
  for (const seg of path) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[seg];
  }
  return cur;
}

function fromZodIssue(issue: z.core.$ZodIssue, input: unknown): RuleIssue {
  const path = joinPath(issue.path);
  const where = path === '' ? 'the settings object' : `\`${path}\``;
  switch (issue.code) {
    case 'unrecognized_keys': {
      const known = knownKeysAt(issue.path);
      return ruleError(
        'UNKNOWN_SETTING',
        path,
        `Unknown setting(s) in ${where}: ${issue.keys.join(', ')}.`,
        `Remove ${issue.keys.join(', ')}.${known.length > 0 ? ` Valid keys here: ${known.join(', ')}.` : ''}`,
        { keys: issue.keys }
      );
    }
    case 'too_small':
      return ruleError(
        'SETTING_OUT_OF_RANGE',
        path,
        `${where}: ${issue.message}.`,
        `Set ${where} to ${issue.inclusive === false ? 'more than' : 'at least'} ${String(issue.minimum)}.`
      );
    case 'too_big':
      return ruleError(
        'SETTING_OUT_OF_RANGE',
        path,
        `${where}: ${issue.message}.`,
        `Set ${where} to ${issue.inclusive === false ? 'less than' : 'at most'} ${String(issue.maximum)}.`
      );
    case 'invalid_value':
      return ruleError(
        'INVALID_SETTING',
        path,
        `${where}: ${issue.message}.`,
        `Use one of: ${issue.values.map((v) => JSON.stringify(v)).join(', ')}.`
      );
    case 'invalid_type':
      return ruleError(
        valueAt(input, issue.path) === undefined ? 'MISSING_SETTING' : 'INVALID_SETTING',
        path,
        `${where}: ${issue.message}.`,
        `Provide ${where} as ${issue.expected === 'int' ? 'a whole number' : `a ${issue.expected}`}.`
      );
    default:
      return ruleError(
        'INVALID_SETTING',
        path,
        `${where}: ${issue.message}.`,
        `Correct ${where}: ${issue.message}.`
      );
  }
}

export type ParseSettingsResult =
  { ok: true; settings: LeagueSettings; warnings: RuleIssue[] } | { ok: false; issues: RuleIssue[] };

/** Schema-validates unknown input, then runs `validateLeagueSettings`. Errors make the result not ok. */
export function parseLeagueSettings(input: unknown): ParseSettingsResult {
  const parsed = LeagueSettingsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((i) => fromZodIssue(i, input)) };
  const issues = validateLeagueSettings(parsed.data);
  return hasErrors(issues) ? { ok: false, issues } : { ok: true, settings: parsed.data, warnings: issues };
}

/** Cross-field checks for settings that already match the schema. */
export function validateLeagueSettings(s: LeagueSettings): RuleIssue[] {
  return [
    ...validateSchedule(s),
    ...validatePlayoffs(s),
    ...validateTrades(s),
    ...validateRoster(s),
    ...validateWaivers(s),
    ...validateScoringSettings(s.scoring),
    ...validateIdpScoring(s)
  ];
}

function validateSchedule(s: LeagueSettings): RuleIssue[] {
  const issues: RuleIssue[] = [];
  if (s.teamCount % 2 !== 0) {
    issues.push(
      ruleError(
        'ODD_TEAM_COUNT',
        'teamCount',
        `${s.teamCount} teams is an odd number, so one team would have no opponent every week.`,
        `Set teamCount to ${s.teamCount - 1} or ${s.teamCount + 1}; head-to-head leagues need an even number of teams.`
      )
    );
  }
  const { startWeek, regularSeasonEndWeek } = s.schedule;
  if (startWeek > regularSeasonEndWeek) {
    issues.push(
      ruleError(
        'SEASON_HAS_NO_WEEKS',
        'schedule.startWeek',
        `The league starts in week ${startWeek}, after the regular season ends in week ${regularSeasonEndWeek}.`,
        `Set schedule.startWeek to ${regularSeasonEndWeek} or earlier.`
      )
    );
  } else {
    const weeks = regularSeasonEndWeek - startWeek + 1;
    if (weeks < s.teamCount - 1) {
      issues.push(
        ruleWarning(
          'SHORT_REGULAR_SEASON',
          'schedule.startWeek',
          `${weeks} regular-season week(s) is fewer than the ${s.teamCount - 1} needed for every team to play every other team once.`,
          `That is allowed, but start earlier or use fewer teams if you want a full round robin.`
        )
      );
    }
  }
  if (s.playoffs.startWeek !== regularSeasonEndWeek + 1) {
    issues.push(
      ruleError(
        'PLAYOFFS_NOT_AFTER_REGULAR_SEASON',
        'playoffs.startWeek',
        `Playoffs start in week ${s.playoffs.startWeek}, but the regular season ends in week ${regularSeasonEndWeek}.`,
        `Set playoffs.startWeek to ${regularSeasonEndWeek + 1}, or schedule.regularSeasonEndWeek to ${s.playoffs.startWeek - 1}.`
      )
    );
  }
  if (startWeek >= s.trades.deadlineWeek) {
    issues.push(
      ruleError(
        'START_AFTER_TRADE_DEADLINE',
        'schedule.startWeek',
        `A league must start before the trade deadline (week ${s.trades.deadlineWeek}); this one starts in week ${startWeek}.`,
        s.trades.deadlineWeek > 1
          ? `Set schedule.startWeek to ${s.trades.deadlineWeek - 1} or earlier, or set trades.deadlineWeek to ${startWeek + 1} or later.`
          : `Set trades.deadlineWeek to ${startWeek + 1} or later.`
      )
    );
  }
  return issues;
}

function validatePlayoffs(s: LeagueSettings): RuleIssue[] {
  const issues: RuleIssue[] = [];
  const p = s.playoffs;
  if (p.teams > s.teamCount) {
    const suggested = s.teamCount <= 6 ? 4 : 6;
    issues.push(
      ruleError(
        'PLAYOFF_TEAMS_EXCEED_TEAMS',
        'playoffs.teams',
        `${p.teams} playoff teams is more than the ${s.teamCount} teams in the league.`,
        `Set playoffs.teams to ${s.teamCount} or fewer (${suggested} is the default for ${s.teamCount} teams).`
      )
    );
  }
  const byes = requiredByes(p.teams);
  if (p.byes !== byes) {
    issues.push(
      ruleError(
        'PLAYOFF_BYES_INVALID',
        'playoffs.byes',
        `A ${p.teams}-team bracket needs exactly ${byes} first-round bye(s), not ${p.byes}.`,
        `Set playoffs.byes to ${byes}.`
      )
    );
  }
  const rounds = playoffRounds(p);
  const weeks = p.endWeek - p.startWeek + 1;
  if (weeks !== rounds) {
    const end = p.startWeek + rounds - 1;
    issues.push(
      ruleError(
        'PLAYOFF_WEEKS_MISMATCH',
        'playoffs.endWeek',
        `A ${p.teams}-team bracket takes ${rounds} week(s), but weeks ${p.startWeek}-${p.endWeek} span ${weeks}.`,
        end <= LAST_NFL_WEEK
          ? `Set playoffs.endWeek to ${end}.`
          : `Set playoffs.startWeek to ${LAST_NFL_WEEK - rounds + 1} and playoffs.endWeek to ${LAST_NFL_WEEK}.`
      )
    );
  }
  return issues;
}

function validateTrades(s: LeagueSettings): RuleIssue[] {
  const issues: RuleIssue[] = [];
  if (s.trades.deadlineWeek > s.schedule.regularSeasonEndWeek) {
    issues.push(
      ruleError(
        'TRADE_DEADLINE_IN_PLAYOFFS',
        'trades.deadlineWeek',
        `The trade deadline (week ${s.trades.deadlineWeek}) must come before the playoffs (week ${s.playoffs.startWeek}).`,
        `Set trades.deadlineWeek to ${s.schedule.regularSeasonEndWeek} or earlier (Yahoo default is 11).`
      )
    );
  }
  if (s.trades.vetoVotes !== null && s.trades.vetoVotes > s.teamCount - 2) {
    issues.push(
      ruleWarning(
        'VETO_VOTES_UNREACHABLE',
        'trades.vetoVotes',
        `${s.trades.vetoVotes} veto votes is more than the ${Math.max(1, s.teamCount - 2)} teams not involved in a trade; it will be capped.`,
        `Set trades.vetoVotes to ${Math.max(1, s.teamCount - 2)} or fewer, or null for the Yahoo default.`
      )
    );
  }
  return issues;
}

function validateRoster(s: LeagueSettings): RuleIssue[] {
  const issues: RuleIssue[] = [];
  if (starterCount(s) === 0) {
    issues.push(
      ruleError(
        'NO_STARTING_SLOTS',
        'roster.slots',
        'The roster has no starting slots, so no team can score.',
        'Add starting slots, for example { QB: 1, WR: 3, RB: 2, TE: 1, "W/R/T": 1, K: 1, DEF: 1 }.'
      )
    );
  }
  const active = activeRosterSize(s);
  if (active > MAX_ACTIVE_ROSTER) {
    issues.push(
      ruleError(
        'ROSTER_TOO_LARGE',
        'roster.slots',
        `The active roster has ${active} spots; the maximum is ${MAX_ACTIVE_ROSTER}.`,
        `Remove ${active - MAX_ACTIVE_ROSTER} bench (BN) or starting slot(s).`
      )
    );
  }
  const ir = slotCount(s, 'IR');
  if (ir > MAX_IR_SLOTS) {
    issues.push(
      ruleError(
        'TOO_MANY_IR_SLOTS',
        'roster.slots.IR',
        `${ir} IR slots is more than the maximum of ${MAX_IR_SLOTS}.`,
        `Set roster.slots.IR to ${MAX_IR_SLOTS} or fewer.`
      )
    );
  }
  for (const slot of ['QB', 'K', 'DEF'] as const satisfies readonly RosterSlot[]) {
    const needed = slotCount(s, slot) * s.teamCount;
    if (needed > NFL_TEAM_COUNT) {
      issues.push(
        ruleError(
          'PLAYER_POOL_TOO_SMALL',
          `roster.slots.${slot}`,
          `${s.teamCount} teams × ${slotCount(s, slot)} ${slot} slot(s) needs ${needed} starters, but only ${NFL_TEAM_COUNT} NFL teams exist.`,
          `Set roster.slots.${slot} to ${Math.floor(NFL_TEAM_COUNT / s.teamCount)} or fewer.`
        )
      );
    }
  }
  const hasQbSlot = ROSTER_SLOTS.some(
    (slot) =>
      slot !== 'BN' && slot !== 'IR' && slotCount(s, slot) > 0 && SLOT_ELIGIBILITY[slot].includes('QB')
  );
  if (starterCount(s) > 0 && !hasQbSlot) {
    issues.push(
      ruleWarning(
        'NO_QB_SLOT',
        'roster.slots',
        'No starting slot accepts a quarterback.',
        'That is allowed, but most leagues add roster.slots.QB = 1 or a Q/W/R/T superflex slot.'
      )
    );
  }
  return issues;
}

function validateWaivers(s: LeagueSettings): RuleIssue[] {
  if (s.waivers.type === 'faab' && s.waivers.faabBudget === 0 && !s.waivers.allowZeroBids) {
    return [
      ruleError(
        'FAAB_NO_LEGAL_BID',
        'waivers.faabBudget',
        'With a $0 FAAB budget and $0 bids disallowed, no team can ever make a waiver claim.',
        'Set waivers.faabBudget above 0 (default 100) or set waivers.allowZeroBids to true.'
      )
    ];
  }
  return [];
}

function validateIdpScoring(s: LeagueSettings): RuleIssue[] {
  const usesIdp = IDP_SLOTS.some((slot) => slotCount(s, slot) > 0);
  const scoresIdp = Object.keys(IDP_PER_STAT).some((k) => (s.scoring.perStat[k] ?? 0) !== 0);
  if (usesIdp && !scoresIdp) {
    return [
      ruleWarning(
        'IDP_SLOTS_WITHOUT_IDP_SCORING',
        'scoring.perStat',
        'The roster has IDP slots, but no IDP stat (idp_tkl_solo, idp_sack, ...) is worth points.',
        'Add IDP weights (withIdpScoring applies the Yahoo IDP defaults).'
      )
    ];
  }
  return [];
}

/* ------------------------------------------------------------------------------------------------ */
/* Editability                                                                                       */
/* ------------------------------------------------------------------------------------------------ */

/** `pre_draft`: locked once the draft starts. `any_time`: the commissioner may change it mid-season. */
export type SettingEditability = 'pre_draft' | 'any_time';

/**
 * Which settings the commissioner can still change after the draft starts. Keys are dotted paths;
 * the longest matching prefix governs a change (so `scoring` covers `scoring.perStat.rec`).
 */
export const SETTINGS_EDITABILITY: Readonly<Record<string, SettingEditability>> = {
  teamCount: 'pre_draft',
  schedule: 'pre_draft',
  'roster.slots': 'pre_draft',
  'roster.irEligibleStatuses': 'any_time',
  scoring: 'pre_draft',
  'waivers.type': 'pre_draft',
  'waivers.faabBudget': 'pre_draft',
  'waivers.priorityOrder': 'pre_draft',
  'waivers.postDraftPlayers': 'pre_draft',
  'waivers.allowZeroBids': 'any_time',
  'waivers.waiverPeriodDays': 'any_time',
  'waivers.faabTiebreak': 'any_time',
  'waivers.maxAcquisitionsPerWeek': 'any_time',
  trades: 'any_time',
  playoffs: 'pre_draft'
};

export function settingEditability(path: string): SettingEditability {
  let best = '';
  for (const key of Object.keys(SETTINGS_EDITABILITY)) {
    if ((path === key || path.startsWith(`${key}.`)) && key.length > best.length) best = key;
  }
  // Unknown paths are treated as locked: safer to refuse than to allow a mid-season rule change.
  return SETTINGS_EDITABILITY[best] ?? 'pre_draft';
}

/** Dotted leaf paths whose values differ between two settings objects. */
export function diffSettingPaths(before: unknown, after: unknown, prefix = ''): string[] {
  const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  if (isObj(before) && isObj(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((k) => diffSettingPaths(before[k], after[k], prefix ? `${prefix}.${k}` : k));
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [prefix];
}

export type LeaguePhaseForSettings = 'pre_draft' | 'drafting' | 'in_season' | 'playoffs' | 'complete';

export interface SettingsChangeContext {
  phase: LeaguePhaseForSettings;
  /** Current NFL week, used for deadline changes mid-season. */
  currentWeek?: number;
}

/**
 * Checks a commissioner's edit: every changed path must be editable in the current phase, the
 * trade deadline cannot be moved once passed or into the past, and the result must be valid.
 */
export function checkSettingsChange(
  current: LeagueSettings,
  next: LeagueSettings,
  context: SettingsChangeContext
): RuleIssue[] {
  const issues: RuleIssue[] = [];
  const changed = diffSettingPaths(current, next);
  if (context.phase !== 'pre_draft') {
    for (const path of changed) {
      if (settingEditability(path) === 'pre_draft') {
        issues.push(
          ruleError(
            'SETTING_LOCKED',
            path,
            `\`${path}\` is locked because the draft has started.`,
            `Leave \`${path}\` unchanged. Only these can change after the draft: ${Object.entries(
              SETTINGS_EDITABILITY
            )
              .filter(([, v]) => v === 'any_time')
              .map(([k]) => k)
              .join(', ')}.`
          )
        );
      }
    }
    const week = context.currentWeek;
    if (week !== undefined && current.trades.deadlineWeek !== next.trades.deadlineWeek) {
      if (current.trades.deadlineWeek <= week) {
        issues.push(
          ruleError(
            'TRADE_DEADLINE_PASSED',
            'trades.deadlineWeek',
            `The trade deadline (week ${current.trades.deadlineWeek}) has already passed; it cannot be moved.`,
            `Leave trades.deadlineWeek at ${current.trades.deadlineWeek}.`
          )
        );
      } else if (next.trades.deadlineWeek <= week) {
        issues.push(
          ruleError(
            'TRADE_DEADLINE_IN_PAST',
            'trades.deadlineWeek',
            `A deadline of week ${next.trades.deadlineWeek} is not after the current week (${week}).`,
            `Set trades.deadlineWeek to ${week + 1} or later.`
          )
        );
      }
    }
  }
  return [...issues, ...validateLeagueSettings(next)];
}
