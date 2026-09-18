import { score } from './scoring.js';
import type { ScoreThresholds } from './scoring.js';
import type { CompiledRateRule } from './rule-loader.js';
import type { RateStateEntry } from './rate-state.js';
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

/**
 * Evaluates rate_window rules against `history` (read by the caller via
 * rate-state.ts, covering at least every rule's own windowSeconds) plus
 * this action's own `statelessMatches` — the current action's stateless
 * matches are already known synchronously, so an `of.ruleId` condition
 * can count them without waiting on a future recording; an `of.decision`
 * condition can't (this action's own final decision isn't known until
 * decide() runs *after* this), so it only ever counts prior history.
 *
 * Pure and side-effect-free, like evaluate()/decide() — it doesn't read
 * or write rate-state.ts itself, so policy-engine.ts stays free of I/O.
 */
export function evaluateRateRules(
  action: NormalizedAction,
  statelessMatches: RuleMatch[],
  rateRules: CompiledRateRule[],
  history: RateStateEntry[],
): RuleMatch[] {
  const now = Date.now();

  return rateRules
    .filter((rule) => rule.applies(action))
    .map((rule) => {
      const cutoffMs = now - rule.windowSeconds * 1000;
      let count = history.filter(
        (entry) => new Date(entry.timestamp).getTime() >= cutoffMs && matchesOf(entry, rule.of),
      ).length;

      if ('ruleId' in rule.of) {
        const { ruleId } = rule.of;
        if (statelessMatches.some((m) => m.matched && m.ruleId === ruleId)) {
          count += 1;
        }
      }

      return {
        ruleId: rule.id,
        matched: count >= rule.threshold,
        severity: rule.severity,
        reason: rule.reason,
      };
    });
}

function matchesOf(entry: RateStateEntry, of: CompiledRateRule['of']): boolean {
  return 'ruleId' in of ? entry.matchedRuleIds.includes(of.ruleId) : entry.decision === of.decision;
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
 * `thresholds` is forwarded to `score()` as-is — see its doc comment for
 * the default-when-omitted behavior.
 */
export function decide(
  action: NormalizedAction,
  matches: RuleMatch[],
  thresholds?: ScoreThresholds,
): PolicyResult {
  const triggered = matches.filter((m) => m.matched);
  const { score: total, decision } = score(action, matches, thresholds);

  if (triggered.length === 0) {
    return { decision, score: total, matches };
  }

  const worst = triggered.reduce((acc, m) =>
    SEVERITY_RANK[m.severity] > SEVERITY_RANK[acc.severity] ? m : acc,
  );

  return { decision, score: total, severity: worst.severity, matches };
}
