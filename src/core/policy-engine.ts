import type { Decision, NormalizedAction, PolicyResult, RuleMatch, Severity } from './types.js';

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

const SEVERITY_TO_DECISION: Record<Severity, Decision> = {
  low: 'allow',
  medium: 'ask',
  high: 'ask',
  critical: 'deny',
};

/** Reduces matched rules to a single decision, driven by the highest-severity match. */
export function decide(matches: RuleMatch[]): PolicyResult {
  const triggered = matches.filter((m) => m.matched);
  if (triggered.length === 0) {
    return { decision: 'allow', matches };
  }

  const worst = triggered.reduce((acc, m) =>
    SEVERITY_RANK[m.severity] > SEVERITY_RANK[acc.severity] ? m : acc,
  );

  return { decision: SEVERITY_TO_DECISION[worst.severity], severity: worst.severity, matches };
}
