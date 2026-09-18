import { describe, expect, it } from 'vitest';
import { evaluateRateRules } from '../src/core/policy-engine.js';
import type { CompiledRateRule } from '../src/core/rule-loader.js';
import type { RateStateEntry } from '../src/core/rate-state.js';
import type { NormalizedAction, RuleMatch } from '../src/core/types.js';

const dummyAction: NormalizedAction = { type: 'shell', raw: {}, source: 'test' };

function rateRule(overrides: Partial<CompiledRateRule> = {}): CompiledRateRule {
  return {
    id: 'burst-x',
    severity: 'high',
    reason: 'burst',
    applies: () => true,
    windowSeconds: 60,
    threshold: 3,
    of: { decision: 'deny' },
    ...overrides,
  };
}

function historyEntry(overrides: Partial<RateStateEntry> = {}): RateStateEntry {
  return {
    timestamp: new Date().toISOString(),
    decision: 'deny',
    matchedRuleIds: [],
    ...overrides,
  };
}

describe('policy-engine: evaluateRateRules — of.decision (history-only, never the current action)', () => {
  it('does not match when history is empty', () => {
    const [result] = evaluateRateRules(dummyAction, [], [rateRule({ threshold: 1 })], []);
    expect(result.matched).toBe(false);
  });

  it('matches once historical deny count reaches the threshold', () => {
    const history = [historyEntry(), historyEntry(), historyEntry()];
    const [result] = evaluateRateRules(
      dummyAction,
      [],
      [rateRule({ threshold: 3, of: { decision: 'deny' } })],
      history,
    );
    expect(result.matched).toBe(true);
  });

  it('does not match below the threshold', () => {
    const history = [historyEntry(), historyEntry()];
    const [result] = evaluateRateRules(
      dummyAction,
      [],
      [rateRule({ threshold: 3, of: { decision: 'deny' } })],
      history,
    );
    expect(result.matched).toBe(false);
  });

  it('only counts entries matching the configured decision', () => {
    const history = [
      historyEntry({ decision: 'deny' }),
      historyEntry({ decision: 'allow' }),
      historyEntry({ decision: 'ask' }),
    ];
    const [result] = evaluateRateRules(
      dummyAction,
      [],
      [rateRule({ threshold: 2, of: { decision: 'deny' } })],
      history,
    );
    expect(result.matched).toBe(false); // only 1 deny in history
  });

  it('ignores entries outside the configured window', () => {
    const outsideWindow = historyEntry({
      timestamp: new Date(Date.now() - 120_000).toISOString(),
    });
    const [result] = evaluateRateRules(
      dummyAction,
      [],
      [rateRule({ windowSeconds: 60, threshold: 1, of: { decision: 'deny' } })],
      [outsideWindow],
    );
    expect(result.matched).toBe(false);
  });
});

describe("policy-engine: evaluateRateRules — of.ruleId (counts history AND this action's own stateless matches)", () => {
  it('counts historical matchedRuleIds occurrences', () => {
    const history = [
      historyEntry({ matchedRuleIds: ['credential-file-write'] }),
      historyEntry({ matchedRuleIds: ['credential-file-write'] }),
    ];
    const [result] = evaluateRateRules(
      dummyAction,
      [],
      [rateRule({ threshold: 2, of: { ruleId: 'credential-file-write' } })],
      history,
    );
    expect(result.matched).toBe(true);
  });

  it("includes this action's own current stateless match toward the count (unlike of.decision)", () => {
    const history = [historyEntry({ matchedRuleIds: ['credential-file-write'] })];
    const currentMatches: RuleMatch[] = [
      { ruleId: 'credential-file-write', matched: true, severity: 'high', reason: 'x' },
    ];
    const [result] = evaluateRateRules(
      dummyAction,
      currentMatches,
      [rateRule({ threshold: 2, of: { ruleId: 'credential-file-write' } })],
      history,
    );
    expect(result.matched).toBe(true); // 1 historical + 1 current = 2
  });

  it("does not count a stateless match that did not actually match (matched: false)", () => {
    const currentMatches: RuleMatch[] = [
      { ruleId: 'credential-file-write', matched: false, severity: 'high', reason: 'x' },
    ];
    const [result] = evaluateRateRules(
      dummyAction,
      currentMatches,
      [rateRule({ threshold: 1, of: { ruleId: 'credential-file-write' } })],
      [],
    );
    expect(result.matched).toBe(false);
  });
});

describe('policy-engine: evaluateRateRules — applies() gating and shape', () => {
  it('skips a rate rule whose applies() returns false for this action', () => {
    const results = evaluateRateRules(
      dummyAction,
      [],
      [rateRule({ applies: () => false, threshold: 0 })],
      [],
    );
    expect(results).toHaveLength(0);
  });

  it('returns one RuleMatch per applicable rate rule, carrying id/severity/reason through', () => {
    const [result] = evaluateRateRules(
      dummyAction,
      [],
      [rateRule({ id: 'burst-of-denies', severity: 'critical', reason: 'too many denies', threshold: 1 })],
      [historyEntry()],
    );
    expect(result).toEqual({
      ruleId: 'burst-of-denies',
      matched: true,
      severity: 'critical',
      reason: 'too many denies',
    });
  });
});
