import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendAuditLogEntry, auditLogPath } from '../src/core/audit-log.js';
import type { NormalizedAction, PolicyResult } from '../src/core/types.js';

describe('audit-log (core)', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'adr-audit-test-'));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  const dangerousAction: NormalizedAction = {
    type: 'shell',
    command: 'rm -rf /',
    raw: { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } },
    source: 'claude-code',
  };

  const denyResult: PolicyResult = {
    decision: 'deny',
    severity: 'critical',
    matches: [
      {
        ruleId: 'dangerous-rm',
        matched: true,
        severity: 'critical',
        reason: 'Recursive force-delete targeting a broad path',
      },
    ],
  };

  it('creates the .adr directory and writes one JSON-line entry', () => {
    appendAuditLogEntry(baseDir, dangerousAction, denyResult);

    const filePath = auditLogPath(baseDir);
    expect(filePath).toBe(join(baseDir, '.adr', 'audit.log'));
    expect(existsSync(filePath)).toBe(true);

    const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0]);
    expect(typeof entry.timestamp).toBe('string');
    expect(entry.source).toBe('claude-code');
    expect(entry.decision).toBe('deny');
    expect(entry.severity).toBe('critical');
    expect(entry.matches).toEqual(denyResult.matches);
    expect(entry.action).toEqual(dangerousAction);
  });

  it('appends further calls as additional JSON lines rather than overwriting', () => {
    appendAuditLogEntry(baseDir, dangerousAction, denyResult);
    appendAuditLogEntry(baseDir, dangerousAction, denyResult);

    const lines = readFileSync(auditLogPath(baseDir), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('records allow decisions with no severity and an empty matches list', () => {
    const benignAction: NormalizedAction = {
      type: 'shell',
      command: 'npm test',
      raw: {},
      source: 'claude-code',
    };
    const allowResult: PolicyResult = { decision: 'allow', matches: [] };

    appendAuditLogEntry(baseDir, benignAction, allowResult);

    const entry = JSON.parse(readFileSync(auditLogPath(baseDir), 'utf-8').trim());
    expect(entry.decision).toBe('allow');
    expect(entry.severity).toBeUndefined();
    expect(entry.matches).toEqual([]);
  });

  it('is tool-agnostic: works for a hypothetical future adapter with no Claude Code knowledge', () => {
    const futureAdapterAction: NormalizedAction = {
      type: 'network',
      url: 'https://example.com',
      raw: { anything: 'a different tool entirely might put here' },
      source: 'some-future-adapter',
    };
    const askResult: PolicyResult = {
      decision: 'ask',
      severity: 'medium',
      matches: [
        {
          ruleId: 'unallowlisted-network-host',
          matched: true,
          severity: 'medium',
          reason: 'Outbound request to a host not on the default allowlist',
        },
      ],
    };

    appendAuditLogEntry(baseDir, futureAdapterAction, askResult);

    const entry = JSON.parse(readFileSync(auditLogPath(baseDir), 'utf-8').trim());
    expect(entry.source).toBe('some-future-adapter');
    expect(entry.decision).toBe('ask');
  });
});
