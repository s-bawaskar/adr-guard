import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditLogPath } from '../src/core/audit-log.js';
import { runShellCommand, type ShellExecutionOptions } from '../src/adapters/shell-wrapper/execute.js';

// Isolated rule set so these tests don't depend on (or get broken by) the
// project's real default rules/*.yaml — one rule that always lands in the
// 'ask' band (score 3) and one that always lands in 'deny' (score 10).
const ASK_TRIGGER = 'ASK_TRIGGER';
const DENY_TRIGGER = 'DENY_TRIGGER';

function writeTestRules(rulesDir: string): void {
  writeFileSync(
    join(rulesDir, 'ask-rule.yaml'),
    `id: test-ask-rule\nappliesTo: shell\nfield: command\nmatch:\n  kind: regex\n  pattern: "${ASK_TRIGGER}"\nseverity: medium\nmessage: test ask trigger\n`,
  );
  writeFileSync(
    join(rulesDir, 'deny-rule.yaml'),
    `id: test-deny-rule\nappliesTo: shell\nfield: command\nmatch:\n  kind: regex\n  pattern: "${DENY_TRIGGER}"\nseverity: critical\nmessage: test deny trigger\n`,
  );
}

describe('runShellCommand (shell-wrapper adapter)', () => {
  let baseDir: string;
  let rulesDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'adr-shell-wrapper-test-'));
    rulesDir = join(baseDir, 'rules');
    mkdirSync(rulesDir, { recursive: true });
    writeTestRules(rulesDir);
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  function options(overrides: Partial<ShellExecutionOptions> = {}): ShellExecutionOptions {
    return { baseDir, rulesDir, ...overrides };
  }

  it('allow: executes the command and returns its exit code', async () => {
    const execute = vi.fn().mockReturnValue(0);
    const exitCode = await runShellCommand('echo hello', options({ execute }));

    expect(exitCode).toBe(0);
    expect(execute).toHaveBeenCalledWith('echo hello');
  });

  it('allow: writes an audit log entry with decision allow and source shell-wrapper', async () => {
    const execute = vi.fn().mockReturnValue(0);
    await runShellCommand('echo hello', options({ execute }));

    const entry = JSON.parse(readFileSync(auditLogPath(baseDir), 'utf-8').trim());
    expect(entry.decision).toBe('allow');
    expect(entry.source).toBe('shell-wrapper');
    expect(entry.action.command).toBe('echo hello');
  });

  it('deny: does not execute, writes the reason to stderr, and returns 1', async () => {
    const execute = vi.fn();
    const writeError = vi.fn();
    const exitCode = await runShellCommand(`rm -rf ${DENY_TRIGGER}`, options({ execute, writeError }));

    expect(exitCode).toBe(1);
    expect(execute).not.toHaveBeenCalled();
    expect(writeError).toHaveBeenCalledTimes(1);
    expect(writeError.mock.calls[0][0]).toMatch(/^ADR denied command:/);
    expect(writeError.mock.calls[0][0]).toMatch(/test-deny-rule/);
  });

  it('deny: still writes an audit log entry (same file the allow/ask paths use)', async () => {
    await runShellCommand(`rm -rf ${DENY_TRIGGER}`, options({ execute: vi.fn(), writeError: vi.fn() }));

    expect(existsSync(auditLogPath(baseDir))).toBe(true);
    const entry = JSON.parse(readFileSync(auditLogPath(baseDir), 'utf-8').trim());
    expect(entry.decision).toBe('deny');
    expect(entry.source).toBe('shell-wrapper');
  });

  it('ask + interactive TTY + user confirms: executes the command', async () => {
    const execute = vi.fn().mockReturnValue(0);
    const prompt = vi.fn().mockResolvedValue(true);

    const exitCode = await runShellCommand(
      `echo ${ASK_TRIGGER}`,
      options({ execute, prompt, stdinIsTTY: true, stdoutIsTTY: true }),
    );

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(exitCode).toBe(0);
  });

  it('ask + interactive TTY + user declines: does not execute, returns 1', async () => {
    const execute = vi.fn();
    const prompt = vi.fn().mockResolvedValue(false);
    const writeError = vi.fn();

    const exitCode = await runShellCommand(
      `echo ${ASK_TRIGGER}`,
      options({ execute, prompt, writeError, stdinIsTTY: true, stdoutIsTTY: true }),
    );

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(exitCode).toBe(1);
    expect(writeError).toHaveBeenCalledTimes(1);
  });

  it('ask + non-interactive flag: treats ask as deny without prompting', async () => {
    const execute = vi.fn();
    const prompt = vi.fn();
    const writeError = vi.fn();

    const exitCode = await runShellCommand(
      `echo ${ASK_TRIGGER}`,
      options({ execute, prompt, writeError, nonInteractive: true, stdinIsTTY: true, stdoutIsTTY: true }),
    );

    expect(prompt).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(exitCode).toBe(1);
    expect(writeError.mock.calls[0][0]).toMatch(/ask treated as deny in non-interactive mode/);
  });

  it('ask + no TTY (e.g. piped/CI context): treats ask as deny without prompting', async () => {
    const execute = vi.fn();
    const prompt = vi.fn();
    const writeError = vi.fn();

    const exitCode = await runShellCommand(
      `echo ${ASK_TRIGGER}`,
      options({ execute, prompt, writeError, stdinIsTTY: false, stdoutIsTTY: false }),
    );

    expect(prompt).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(exitCode).toBe(1);
    expect(writeError.mock.calls[0][0]).toMatch(/ask treated as deny in non-interactive mode/);
  });

  it('ask + --yes-to-ask override: executes without prompting, even with no TTY', async () => {
    const execute = vi.fn().mockReturnValue(0);
    const prompt = vi.fn();

    const exitCode = await runShellCommand(
      `echo ${ASK_TRIGGER}`,
      options({ execute, prompt, yesToAsk: true, stdinIsTTY: false, stdoutIsTTY: false }),
    );

    expect(prompt).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(exitCode).toBe(0);
  });

  it('ask + ADR_ASK_MODE=allow env override: executes without prompting', async () => {
    const execute = vi.fn().mockReturnValue(0);
    const prompt = vi.fn();

    const exitCode = await runShellCommand(
      `echo ${ASK_TRIGGER}`,
      options({
        execute,
        prompt,
        env: { ADR_ASK_MODE: 'allow' },
        stdinIsTTY: false,
        stdoutIsTTY: false,
      }),
    );

    expect(prompt).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(exitCode).toBe(0);
  });

  it('a project adr.config.yaml raising askThreshold changes an ask-band command to allow', async () => {
    // ASK_TRIGGER scores 3 (medium), which is the default askThreshold — bumping
    // it to 4 should drop the same command below the ask band entirely.
    writeFileSync(join(baseDir, 'adr.config.yaml'), 'askThreshold: 4\ndenyThreshold: 10\n');
    const execute = vi.fn().mockReturnValue(0);

    const exitCode = await runShellCommand(`echo ${ASK_TRIGGER}`, options({ execute }));

    expect(execute).toHaveBeenCalledTimes(1);
    expect(exitCode).toBe(0);
  });
});
