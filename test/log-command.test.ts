import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMIT,
  describeAction,
  formatEntry,
  readRecentEntries,
  runLogCommand,
} from '../src/cli/log-command.js';
import type { AuditLogEntry } from '../src/core/audit-log.js';
import type { NormalizedAction } from '../src/core/types.js';

function entry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    timestamp: '2026-09-18T09:00:00.000Z',
    source: 'shell-wrapper',
    action: { type: 'shell', raw: {}, source: 'shell-wrapper', command: 'echo hi' },
    decision: 'allow',
    score: 0,
    matches: [],
    ...overrides,
  };
}

function action(overrides: Partial<NormalizedAction>): NormalizedAction {
  return { type: 'shell', raw: {}, source: 'test', ...overrides };
}

describe('log-command: describeAction', () => {
  it('shell: returns the command', () => {
    expect(describeAction(action({ type: 'shell', command: 'npm test' }))).toBe('npm test');
  });

  it('shell: truncates a very long command', () => {
    const long = 'x'.repeat(200);
    const result = describeAction(action({ type: 'shell', command: long }));
    expect(result.length).toBeLessThan(200);
    expect(result.endsWith('…')).toBe(true);
  });

  it('file_write: prefixes with "write"', () => {
    expect(describeAction(action({ type: 'file_write', filePath: '/tmp/x.env' }))).toBe(
      'write /tmp/x.env',
    );
  });

  it('file_read: prefixes with "read"', () => {
    expect(describeAction(action({ type: 'file_read', filePath: '/tmp/x.env' }))).toBe(
      'read /tmp/x.env',
    );
  });

  it('network: prefixes with "fetch"', () => {
    expect(describeAction(action({ type: 'network', url: 'https://example.com' }))).toBe(
      'fetch https://example.com',
    );
  });

  it('other: falls back to a generic label', () => {
    expect(describeAction(action({ type: 'other' }))).toBe('(other action)');
  });
});

describe('log-command: formatEntry', () => {
  it('includes timestamp, source, decision, matched rule ids, and action description', () => {
    const line = formatEntry(
      entry({
        decision: 'deny',
        matches: [
          { ruleId: 'dangerous-rm', matched: true, severity: 'critical', reason: 'x' },
          { ruleId: 'not-matched', matched: false, severity: 'low', reason: 'y' },
        ],
        action: { type: 'shell', raw: {}, source: 'shell-wrapper', command: 'rm -rf /' },
      }),
    );

    expect(line).toContain('2026-09-18T09:00:00.000Z');
    expect(line).toContain('[shell-wrapper]');
    expect(line).toContain('DENY');
    expect(line).toContain('dangerous-rm');
    expect(line).not.toContain('not-matched');
    expect(line).toContain('rm -rf /');
  });

  it('shows a placeholder when no rules matched', () => {
    const line = formatEntry(entry({ matches: [] }));
    expect(line).toContain('(no rules matched)');
  });

  it('is plain text (no ANSI escapes) outside a real TTY, matching how tests run', () => {
    const line = formatEntry(entry({ decision: 'ask' }));
    // eslint-disable-next-line no-control-regex
    expect(line).not.toMatch(/\[/);
  });
});

describe('log-command: readRecentEntries', () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adr-log-test-'));
    logPath = join(dir, 'audit.log');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns [] when the file does not exist', () => {
    expect(readRecentEntries(logPath, DEFAULT_LIMIT)).toEqual([]);
  });

  it('parses every entry when under the limit', () => {
    writeFileSync(logPath, [entry({ score: 1 }), entry({ score: 2 })].map((e) => JSON.stringify(e)).join('\n') + '\n');
    const entries = readRecentEntries(logPath, 10);
    expect(entries.map((e) => e.score)).toEqual([1, 2]);
  });

  it('returns only the last N entries when over the limit', () => {
    const lines = [1, 2, 3, 4, 5].map((score) => JSON.stringify(entry({ score })));
    writeFileSync(logPath, lines.join('\n') + '\n');
    const entries = readRecentEntries(logPath, 2);
    expect(entries.map((e) => e.score)).toEqual([4, 5]);
  });

  it('skips a malformed line rather than failing the whole read', () => {
    writeFileSync(
      logPath,
      'not valid json\n' + JSON.stringify(entry({ score: 42 })) + '\n{"partial":\n',
    );
    const entries = readRecentEntries(logPath, 10);
    expect(entries).toHaveLength(1);
    expect(entries[0].score).toBe(42);
  });
});

describe('log-command: runLogCommand — non-tail mode', () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adr-log-run-test-'));
    logPath = join(dir, 'audit.log');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('prints a friendly message and returns (no error) when the file does not exist yet', async () => {
    const lines: string[] = [];
    await runLogCommand({ logPath, tail: false, write: (l) => lines.push(l) });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('No audit log yet');
    expect(lines[0]).toContain(logPath);
  });

  it('prints formatted entries in order', async () => {
    writeFileSync(
      logPath,
      [entry({ score: 1 }), entry({ score: 2 })].map((e) => JSON.stringify(e)).join('\n') + '\n',
    );
    const lines: string[] = [];
    await runLogCommand({ logPath, tail: false, write: (l) => lines.push(l) });

    expect(lines).toHaveLength(2);
  });

  it('applies --filter, only printing entries matching the given decision', async () => {
    const records = [
      entry({ decision: 'allow' }),
      entry({ decision: 'deny' }),
      entry({ decision: 'ask' }),
      entry({ decision: 'deny' }),
    ];
    writeFileSync(logPath, records.map((e) => JSON.stringify(e)).join('\n') + '\n');

    const lines: string[] = [];
    await runLogCommand({ logPath, tail: false, filter: 'deny', write: (l) => lines.push(l) });

    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.includes('DENY'))).toBe(true);
  });

  it('respects a custom limit, showing only the most recent entries', async () => {
    const records = [1, 2, 3, 4, 5].map((score) => entry({ score }));
    writeFileSync(logPath, records.map((e) => JSON.stringify(e)).join('\n') + '\n');

    const lines: string[] = [];
    await runLogCommand({ logPath, tail: false, limit: 2, write: (l) => lines.push(l) });

    expect(lines).toHaveLength(2);
  });
});

describe('log-command: runLogCommand — tail mode', () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adr-log-tail-test-'));
    logPath = join(dir, 'audit.log');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('prints existing entries, then new ones appended after tailing starts, then stops on abort', async () => {
    writeFileSync(logPath, JSON.stringify(entry({ score: 1 })) + '\n');

    const controller = new AbortController();
    const lines: string[] = [];

    const run = runLogCommand({
      logPath,
      tail: true,
      pollIntervalMs: 20,
      write: (l) => lines.push(l),
      signal: controller.signal,
    });

    // Give the initial batch + first poll tick a moment, then append a new entry.
    await new Promise((r) => setTimeout(r, 50));
    appendFileSync(logPath, JSON.stringify(entry({ score: 2 })) + '\n');
    await new Promise((r) => setTimeout(r, 100));

    controller.abort();
    await run;

    expect(lines).toHaveLength(2);
  });

  it('waits for the file to be created, then starts following it', async () => {
    const controller = new AbortController();
    const lines: string[] = [];

    const run = runLogCommand({
      logPath,
      tail: true,
      pollIntervalMs: 20,
      write: (l) => lines.push(l),
      signal: controller.signal,
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(lines.some((l) => l.includes('Waiting for'))).toBe(true);

    writeFileSync(logPath, JSON.stringify(entry({ score: 1 })) + '\n');
    await new Promise((r) => setTimeout(r, 100));

    controller.abort();
    await run;

    expect(lines.some((l) => l.includes('shell-wrapper'))).toBe(true);
  });

  it('applies --filter while tailing new entries too', async () => {
    writeFileSync(logPath, JSON.stringify(entry({ decision: 'allow' })) + '\n');

    const controller = new AbortController();
    const lines: string[] = [];

    const run = runLogCommand({
      logPath,
      tail: true,
      filter: 'deny',
      pollIntervalMs: 20,
      write: (l) => lines.push(l),
      signal: controller.signal,
    });

    await new Promise((r) => setTimeout(r, 50));
    appendFileSync(logPath, JSON.stringify(entry({ decision: 'deny' })) + '\n');
    appendFileSync(logPath, JSON.stringify(entry({ decision: 'ask' })) + '\n');
    await new Promise((r) => setTimeout(r, 100));

    controller.abort();
    await run;

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('DENY');
  });
});
