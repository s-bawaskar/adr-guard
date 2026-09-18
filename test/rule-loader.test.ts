import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  compileRateRule,
  compileRule,
  loadCompiledRateRules,
  loadCompiledRules,
  loadRuleDefinitions,
  parseRuleDefinition,
  RuleValidationError,
} from '../src/core/rule-loader.js';
import type { NormalizedAction } from '../src/core/types.js';

function action(overrides: Partial<NormalizedAction>): NormalizedAction {
  return { type: 'shell', raw: {}, source: 'test', ...overrides };
}

describe('rule-loader: parseRuleDefinition validation', () => {
  it('accepts a well-formed regex rule', () => {
    const def = parseRuleDefinition(
      {
        id: 'test-rule',
        appliesTo: 'shell',
        field: 'command',
        match: { kind: 'regex', pattern: 'danger' },
        severity: 'high',
        message: 'found danger',
      },
      'test.yaml',
    );
    expect(def.id).toBe('test-rule');
  });

  it('rejects a rule missing id', () => {
    expect(() =>
      parseRuleDefinition(
        {
          appliesTo: 'shell',
          match: { kind: 'regex', pattern: 'x' },
          severity: 'low',
          message: 'm',
        },
        'bad.yaml',
      ),
    ).toThrow(/"id"/);
  });

  it('rejects an invalid appliesTo value', () => {
    expect(() =>
      parseRuleDefinition(
        {
          id: 'x',
          appliesTo: 'not-a-real-type',
          match: { kind: 'regex', pattern: 'x' },
          severity: 'low',
          message: 'm',
        },
        'bad.yaml',
      ),
    ).toThrow(/appliesTo/);
  });

  it('rejects an invalid severity value', () => {
    expect(() =>
      parseRuleDefinition(
        {
          id: 'x',
          appliesTo: 'shell',
          match: { kind: 'regex', pattern: 'x' },
          severity: 'catastrophic',
          message: 'm',
        },
        'bad.yaml',
      ),
    ).toThrow(/severity/);
  });

  it('rejects an unknown match.kind', () => {
    expect(() =>
      parseRuleDefinition(
        {
          id: 'x',
          appliesTo: 'shell',
          match: { kind: 'telepathy' },
          severity: 'low',
          message: 'm',
        },
        'bad.yaml',
      ),
    ).toThrow(/match\.kind/);
  });

  it('rejects path_prefix match missing prefixes array', () => {
    expect(() =>
      parseRuleDefinition(
        {
          id: 'x',
          appliesTo: 'file_write',
          match: { kind: 'path_prefix' },
          severity: 'low',
          message: 'm',
        },
        'bad.yaml',
      ),
    ).toThrow(/prefixes/);
  });
});

describe('rule-loader: rate_window validation', () => {
  function rateDef(overrides: Record<string, unknown> = {}) {
    const { match: matchOverride, ...rest } = overrides;
    return {
      id: 'burst-x',
      appliesTo: 'any',
      match: {
        kind: 'rate_window',
        windowSeconds: 60,
        threshold: 3,
        of: { decision: 'deny' },
        ...(matchOverride as Record<string, unknown> | undefined),
      },
      severity: 'high',
      message: 'burst',
      ...rest,
    };
  }

  it('accepts a well-formed rate_window rule with of.decision', () => {
    const def = parseRuleDefinition(rateDef(), 'x.yaml');
    expect(def.match).toEqual({
      kind: 'rate_window',
      windowSeconds: 60,
      threshold: 3,
      of: { decision: 'deny' },
    });
  });

  it('accepts a well-formed rate_window rule with of.ruleId', () => {
    const def = parseRuleDefinition(
      rateDef({ match: { of: { ruleId: 'dangerous-rm' } } }),
      'x.yaml',
    );
    expect(def.match).toEqual({
      kind: 'rate_window',
      windowSeconds: 60,
      threshold: 3,
      of: { ruleId: 'dangerous-rm' },
    });
  });

  it('rejects a non-positive windowSeconds', () => {
    expect(() =>
      parseRuleDefinition(rateDef({ match: { windowSeconds: 0 } }), 'bad.yaml'),
    ).toThrow(/windowSeconds/);
  });

  it('rejects a non-integer threshold', () => {
    expect(() =>
      parseRuleDefinition(rateDef({ match: { threshold: 1.5 } }), 'bad.yaml'),
    ).toThrow(/threshold/);
  });

  it('rejects a non-positive threshold', () => {
    expect(() =>
      parseRuleDefinition(rateDef({ match: { threshold: 0 } }), 'bad.yaml'),
    ).toThrow(/threshold/);
  });

  it('rejects of with both ruleId and decision', () => {
    expect(() =>
      parseRuleDefinition(
        rateDef({ match: { of: { ruleId: 'x', decision: 'deny' } } }),
        'bad.yaml',
      ),
    ).toThrow(/exactly one/);
  });

  it('rejects of with neither ruleId nor decision', () => {
    expect(() => parseRuleDefinition(rateDef({ match: { of: {} } }), 'bad.yaml')).toThrow(
      /exactly one/,
    );
  });

  it('rejects an invalid of.decision value', () => {
    expect(() =>
      parseRuleDefinition(rateDef({ match: { of: { decision: 'maybe' } } }), 'bad.yaml'),
    ).toThrow(/of\.decision/);
  });
});

describe('rule-loader: compileRateRule cross-rule validation', () => {
  const statelessDef = parseRuleDefinition(
    {
      id: 'credential-file-write',
      appliesTo: 'file_write',
      field: 'filePath',
      match: { kind: 'regex', pattern: '\\.env$' },
      severity: 'high',
      message: 'credential file',
    },
    'credential-file-write.yaml',
  );

  function rateDefWithRuleId(ruleId: string) {
    return parseRuleDefinition(
      {
        id: 'burst-writes',
        appliesTo: 'any',
        match: { kind: 'rate_window', windowSeconds: 120, threshold: 5, of: { ruleId } },
        severity: 'critical',
        message: 'burst writes',
      },
      'burst-writes.yaml',
    );
  }

  it('resolves ofRuleId against the full loaded rule set and compiles successfully', () => {
    const rateDef = rateDefWithRuleId('credential-file-write');
    const compiled = compileRateRule(rateDef, [statelessDef, rateDef]);

    expect(compiled.id).toBe('burst-writes');
    expect(compiled.of).toEqual({ ruleId: 'credential-file-write' });
    expect(compiled.windowSeconds).toBe(120);
    expect(compiled.threshold).toBe(5);
  });

  it('throws a clear RuleValidationError when ofRuleId references a rule that does not exist', () => {
    const rateDef = rateDefWithRuleId('no-such-rule');
    expect(() => compileRateRule(rateDef, [statelessDef, rateDef])).toThrow(RuleValidationError);
    expect(() => compileRateRule(rateDef, [statelessDef, rateDef])).toThrow(/unknown ofRuleId/);
  });

  it('throws when ofRuleId references another rate_window rule (rate matches are never recorded to history)', () => {
    const otherRateDef = rateDefWithRuleId('credential-file-write');
    const referencingDef = parseRuleDefinition(
      {
        id: 'burst-of-bursts',
        appliesTo: 'any',
        match: {
          kind: 'rate_window',
          windowSeconds: 60,
          threshold: 2,
          of: { ruleId: 'burst-writes' },
        },
        severity: 'critical',
        message: 'meta-burst',
      },
      'burst-of-bursts.yaml',
    );

    expect(() =>
      compileRateRule(referencingDef, [statelessDef, otherRateDef, referencingDef]),
    ).toThrow(/can only reference stateless/);
  });

  it('loadCompiledRateRules resolves ofRuleId against loadCompiledRules-filtered-out rate rules from the same directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adr-rate-crossref-test-'));
    try {
      writeFileSync(
        join(dir, 'credential-file-write.yaml'),
        "id: credential-file-write\nappliesTo: file_write\nfield: filePath\nmatch:\n  kind: regex\n  pattern: '\\.env$'\nseverity: high\nmessage: 'credential file'\n",
      );
      writeFileSync(
        join(dir, 'burst-writes.yaml'),
        'id: burst-writes\nappliesTo: any\nmatch:\n  kind: rate_window\n  windowSeconds: 120\n  threshold: 5\n  of:\n    ruleId: credential-file-write\nseverity: critical\nmessage: burst writes\n',
      );

      const rateRules = loadCompiledRateRules(dir);
      expect(rateRules).toHaveLength(1);
      expect(rateRules[0].id).toBe('burst-writes');

      const statelessRules = loadCompiledRules(dir);
      expect(statelessRules.map((r) => r.id)).toEqual(['credential-file-write']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loadCompiledRateRules throws when a rate rule in the directory references a nonexistent rule id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adr-rate-crossref-bad-test-'));
    try {
      writeFileSync(
        join(dir, 'burst-writes.yaml'),
        'id: burst-writes\nappliesTo: any\nmatch:\n  kind: rate_window\n  windowSeconds: 120\n  threshold: 5\n  of:\n    ruleId: nonexistent-rule\nseverity: critical\nmessage: burst writes\n',
      );

      expect(() => loadCompiledRateRules(dir)).toThrow(/unknown ofRuleId/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('rule-loader: compileRule match kinds', () => {
  it('regex: matches the configured field with the configured flags', () => {
    const rule = compileRule(
      parseRuleDefinition(
        {
          id: 'shouty-rm',
          appliesTo: 'shell',
          field: 'command',
          match: { kind: 'regex', pattern: 'RM -RF', flags: 'i' },
          severity: 'critical',
          message: 'shouty delete',
        },
        'x.yaml',
      ),
    );

    expect(rule.applies(action({ type: 'shell' }))).toBe(true);
    expect(rule.test(action({ command: 'rm -rf /' }))).toBe(true);
    expect(rule.test(action({ command: 'npm test' }))).toBe(false);
  });

  it('regex: checks multiple fields with OR semantics', () => {
    const rule = compileRule(
      parseRuleDefinition(
        {
          id: 'eval-anywhere',
          appliesTo: 'any',
          field: ['command', 'content'],
          match: { kind: 'regex', pattern: 'eval\\(' },
          severity: 'medium',
          message: 'eval usage',
        },
        'x.yaml',
      ),
    );

    expect(rule.test(action({ type: 'shell', command: 'node -e "eval(x)"' }))).toBe(true);
    expect(rule.test(action({ type: 'file_write', content: 'eval(userInput)' }))).toBe(true);
    expect(rule.test(action({ type: 'shell', command: 'echo hi' }))).toBe(false);
  });

  it('path_prefix: matches when filePath starts with any configured prefix', () => {
    const rule = compileRule(
      parseRuleDefinition(
        {
          id: 'system-write',
          appliesTo: 'file_write',
          field: 'filePath',
          match: { kind: 'path_prefix', prefixes: ['/etc/', '/usr/'] },
          severity: 'high',
          message: 'system path',
        },
        'x.yaml',
      ),
    );

    expect(rule.test(action({ type: 'file_write', filePath: '/etc/passwd' }))).toBe(true);
    expect(rule.test(action({ type: 'file_write', filePath: '/home/user/notes.txt' }))).toBe(false);
  });

  it('domain_allowlist: matches (flags) hosts NOT on the list', () => {
    const rule = compileRule(
      parseRuleDefinition(
        {
          id: 'net-allowlist',
          appliesTo: 'network',
          field: 'url',
          match: { kind: 'domain_allowlist', domains: ['github.com'] },
          severity: 'medium',
          message: 'unknown host',
        },
        'x.yaml',
      ),
    );

    expect(rule.test(action({ type: 'network', url: 'https://github.com/foo' }))).toBe(false);
    expect(rule.test(action({ type: 'network', url: 'https://sketchy.example.net' }))).toBe(true);
  });

  it('domain_denylist: matches hosts that ARE on the list', () => {
    const rule = compileRule(
      parseRuleDefinition(
        {
          id: 'net-denylist',
          appliesTo: 'network',
          field: 'url',
          match: { kind: 'domain_denylist', domains: ['evil.example.com'] },
          severity: 'critical',
          message: 'known-bad host',
        },
        'x.yaml',
      ),
    );

    expect(rule.test(action({ type: 'network', url: 'https://evil.example.com/x' }))).toBe(true);
    expect(rule.test(action({ type: 'network', url: 'https://github.com' }))).toBe(false);
  });
});

describe('rule-loader: loadRuleDefinitions / loadCompiledRules from disk', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adr-rules-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns [] for a directory that does not exist', () => {
    expect(loadRuleDefinitions(join(dir, 'nope'))).toEqual([]);
  });

  it('loads only .yaml/.yml files, ignoring other extensions, and compiles them', () => {
    writeFileSync(
      join(dir, 'a.yaml'),
      "id: a\nappliesTo: shell\nfield: command\nmatch:\n  kind: regex\n  pattern: 'foo'\nseverity: low\nmessage: 'found foo'\n",
    );
    writeFileSync(
      join(dir, 'b.yml'),
      "id: b\nappliesTo: shell\nfield: command\nmatch:\n  kind: regex\n  pattern: 'bar'\nseverity: low\nmessage: 'found bar'\n",
    );
    writeFileSync(join(dir, 'README.md'), '# not a rule');

    const defs = loadRuleDefinitions(dir);
    expect(defs.map((d) => d.id).sort()).toEqual(['a', 'b']);

    const compiled = loadCompiledRules(dir);
    expect(compiled).toHaveLength(2);
    expect(compiled.some((r) => r.test(action({ command: 'foo' })))).toBe(true);
  });
});
