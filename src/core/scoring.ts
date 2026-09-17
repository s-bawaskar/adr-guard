import type { Decision, NormalizedAction, RuleMatch, Severity } from './types.js';

export interface ScoreResult {
  score: number;
  decision: Decision;
}

/**
 * Points contributed by a single triggered rule, by severity. Chosen so
 * that two `high` matches together (12) cross the deny threshold even
 * though neither alone would — cumulative risk, not just "the single
 * worst rule wins" (that was Phase 3's approach; this replaces it).
 */
const SEVERITY_WEIGHT: Record<Severity, number> = { low: 1, medium: 3, high: 6, critical: 10 };

export const ASK_THRESHOLD = 3;
export const DENY_THRESHOLD = 10;

/**
 * Scores an action from its matched rules and maps the total to a
 * decision band: allow (score < ASK_THRESHOLD), ask+flag (< DENY_THRESHOLD),
 * deny (>= DENY_THRESHOLD). `action` is accepted for parity with a future
 * context-sensitive scoring (e.g. weighting by action type or
 * environment); v1 scores purely from matched-rule severities.
 */
export function score(action: NormalizedAction, matches: RuleMatch[]): ScoreResult {
  const total = matches
    .filter((m) => m.matched)
    .reduce((sum, m) => sum + SEVERITY_WEIGHT[m.severity], 0);

  let decision: Decision = 'allow';
  if (total >= DENY_THRESHOLD) {
    decision = 'deny';
  } else if (total >= ASK_THRESHOLD) {
    decision = 'ask';
  }

  return { score: total, decision };
}
