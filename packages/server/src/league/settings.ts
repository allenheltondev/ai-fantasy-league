import {
  applySettingsPatch,
  leagueWeeks,
  parseLeagueSettings,
  yahooDefaultSettings,
  type LeaguePhaseForSettings,
  type LeaguePreset,
  type LeagueSettings,
  type LeagueSettingsPatch,
  type RuleIssue
} from '@fantasy/core';
import { z } from 'zod';
import { ApiError } from '../errors.js';
import type { Warning } from '../registry/operation.js';
import type { LeaguePhase } from '../repos/types.js';

/** A settings patch as it arrives over the API: any nested object, validated by core afterwards. */
export const SettingsPatchSchema = z
  .record(z.string(), z.unknown())
  .describe(
    'Changes to league settings, shaped like `settings` from get_league. Nested objects merge key by key ({"scoring": {"perStat": {"rec": 1}}} changes only reception points); arrays are replaced.'
  );

/** INVALID_SETTINGS listing every error, each with its own fix. */
export function settingsError(issues: readonly RuleIssue[]): ApiError {
  const errors = issues.filter((issue) => issue.severity === 'error');
  return new ApiError(
    'INVALID_SETTINGS',
    `The league settings are not valid (${errors.length} problem(s)).`,
    {
      fix: errors.map((issue) => issue.fix).join(' '),
      details: {
        issues: errors.map(({ code, path, message, fix }) => ({ code, path, message, fix }))
      }
    }
  );
}

export function settingsWarnings(issues: readonly RuleIssue[]): Warning[] {
  return issues
    .filter((issue) => issue.severity === 'warning')
    .map((issue) => ({ code: issue.code, message: `${issue.message} ${issue.fix}` }));
}

/**
 * Yahoo defaults for the preset and start week, with the overrides applied and validated
 * (`parseLeagueSettings`, then `leagueWeeks`).
 */
export function buildLeagueSettings(input: {
  teamCount: number;
  preset: LeaguePreset;
  startWeek: number;
  overrides: Record<string, unknown> | undefined;
}): { settings: LeagueSettings; warnings: Warning[] } {
  const base = yahooDefaultSettings(input.teamCount, { scoring: input.preset, startWeek: input.startWeek });
  const merged = applySettingsPatch(base, (input.overrides ?? {}) as LeagueSettingsPatch);
  const parsed = parseLeagueSettings(merged);
  if (!parsed.ok) throw settingsError(parsed.issues);
  const weeks = leagueWeeks(parsed.settings);
  if (!weeks.ok) throw settingsError(weeks.issues);
  return { settings: parsed.settings, warnings: settingsWarnings(parsed.warnings) };
}

/** How core's editability rules name each league phase. */
export function settingsPhase(phase: LeaguePhase): LeaguePhaseForSettings {
  switch (phase) {
    case 'setup':
      return 'pre_draft';
    case 'regular_season':
      return 'in_season';
    default:
      return phase;
  }
}
