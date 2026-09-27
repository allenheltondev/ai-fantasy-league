import type { RuleIssue } from './issues.js';

/**
 * Outcome of a rule-checked operation. On failure `issues` holds at least one error, each with a
 * `fix` a person or an agent can act on.
 */
export type RuleResult<T> = { ok: true; value: T } | { ok: false; issues: RuleIssue[] };

export function ruleOk<T>(value: T): RuleResult<T> {
  return { ok: true, value };
}

export function ruleFail<T>(issues: RuleIssue[]): RuleResult<T> {
  return { ok: false, issues };
}
