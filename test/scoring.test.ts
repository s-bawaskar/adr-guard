import { describe, expect, it } from 'vitest';
import { ASK_THRESHOLD, DENY_THRESHOLD, score } from '../src/core/scoring.js';
import type { NormalizedAction, RuleMatch } from '../src/core/types.js';

const dummyAction: NormalizedAction = { type: 'shell', raw: {}, source: 'test' };

function match(overrides: Partial<RuleMatch>): RuleMatch {
  return { ruleId: 'x', matched: true, severity: 'low', reason: 'x', ...overrides };
}

describe('scoring', () => {
  it('scores 0 and allows when there are no matches', () => {
    const result = score(dummyAction, []);
    expect(result).toEqual({ score: 0, decision: 'allow' });
  });

  it('ignores non-matched rules entirely', () => {
    const result = score(dummyAction, [match({ matched: false, severity: 'critical' })]);
    expect(result).toEqual({ score: 0, decision: 'allow' });
  });

  it('a single low-severity match allows (below ASK_THRESHOLD)', () => {
    const result = score(dummyAction, [match({ severity: 'low' })]);
    expect(result.score).toBeLessThan(ASK_THRESHOLD);
    expect(result.decision).toBe('allow');
  });

  it('a single high-severity match asks but does not deny — "flagged but not blocked"', () => {
    const result = score(dummyAction, [match({ severity: 'high' })]);
    expect(result.decision).toBe('ask');
    expect(result.score).toBeLessThan(DENY_THRESHOLD);
  });

  it('a single critical match denies', () => {
    const result = score(dummyAction, [match({ severity: 'critical' })]);
    expect(result.decision).toBe('deny');
    expect(result.score).toBeGreaterThanOrEqual(DENY_THRESHOLD);
  });

  it('two high-severity matches together escalate to deny, though neither alone would', () => {
    const single = score(dummyAction, [match({ severity: 'high' })]);
    expect(single.decision).toBe('ask');

    const double = score(dummyAction, [match({ severity: 'high' }), match({ severity: 'high' })]);
    expect(double.score).toBe(single.score * 2);
    expect(double.decision).toBe('deny');
  });

  it('scores are cumulative across mixed severities', () => {
    const result = score(dummyAction, [
      match({ severity: 'low' }),
      match({ severity: 'medium' }),
      match({ severity: 'medium' }),
    ]);
    // low(1) + medium(3) + medium(3) = 7
    expect(result.score).toBe(7);
    expect(result.decision).toBe('ask');
  });
});
