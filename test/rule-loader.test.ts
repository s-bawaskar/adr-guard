import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  compileRule,
  loadCompiledRules,
  loadRuleDefinitions,
  parseRuleDefinition,
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
