/**
 * A validation finding. Messages and fixes are written so that a human reading the UI and a model
 * reading a tool result can both act on them without extra context.
 */
export interface RuleIssue {
  /** Stable, SCREAMING_SNAKE_CASE identifier, safe to branch on. */
  code: string;
  /** `error` blocks the action; `warning` is advisory (the action is still allowed). */
  severity: 'error' | 'warning';
  /** Dotted path to the offending field (settings) or a player/slot reference (lineups). */
  path: string;
  message: string;
  /** Concrete instruction for how to resolve the issue. */
  fix: string;
  details?: Record<string, unknown>;
}

export function ruleError(
  code: string,
  path: string,
  message: string,
  fix: string,
  details?: Record<string, unknown>
): RuleIssue {
  return details
    ? { code, severity: 'error', path, message, fix, details }
    : { code, severity: 'error', path, message, fix };
}

export function ruleWarning(
  code: string,
  path: string,
  message: string,
  fix: string,
  details?: Record<string, unknown>
): RuleIssue {
  return details
    ? { code, severity: 'warning', path, message, fix, details }
    : { code, severity: 'warning', path, message, fix };
}

export function hasErrors(issues: readonly RuleIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}
