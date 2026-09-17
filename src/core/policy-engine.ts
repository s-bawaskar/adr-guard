import { score } from './scoring.js';
import type { NormalizedAction, PolicyResult, RuleMatch, Severity } from './types.js';

/** A rule compiled from data (see rule-loader.ts) into runtime predicates. */
export interface CompiledRule {
  id: string;
  severity: Severity;
  reason: string;
  applies: (action: NormalizedAction) => boolean;
  test: (action: NormalizedAction) => boolean;
}

/** Evaluates every applicable rule against the action. Non-applicable rules are skipped entirely (not returned as non-matches). */
export function evaluate(action: NormalizedAction, rules: CompiledRule[]): RuleMatch[] {
  return rules
    .filter((rule) => rule.applies(action))
    .map((rule) => ({
      ruleId: rule.id,
      matched: rule.test(action),
      severity: rule.severity,
      reason: rule.reason,
    }));
}

const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/**
 * Reduces matched rules to a single decision via weighted scoring (see
 * scoring.ts): the decision is driven by the *cumulative* score across
 * all triggered rules, not just the single worst one — so e.g. two
 * `high` matches together can escalate to deny even though neither
 * alone would. `severity` is still reported as the highest individual
 * match, for display/audit purposes, and can legitimately disagree
 * with `decision` (high severity + ask-level score, but deny once a
 * second high match pushes the total over threshold).
 */
export function decide(action: NormalizedAction, matches: RuleMatch[]): PolicyResult {
  const triggered = matches.filter((m) => m.matched);
  const { score: total, decision } = score(action, matches);

  if (triggered.length === 0) {
    return { decision, score: total, matches };
  }

  const worst = triggered.reduce((acc, m) =>
    SEVERITY_RANK[m.severity] > SEVERITY_RANK[acc.severity] ? m : acc,
  );

  return { decision, score: total, severity: worst.severity, matches };
}
