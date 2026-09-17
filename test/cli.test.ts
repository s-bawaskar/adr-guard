import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergeHookIntoSettings, parseExecArgs, resolveTargetDir } from '../src/cli/index.js';

describe('cli: mergeHookIntoSettings', () => {
  it('adds the hook entry to empty settings', () => {
    const result = mergeHookIntoSettings({});
    expect(result.hooks?.PreToolUse).toHaveLength(1);
    expect(result.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command).toBe('npx adr-hook');
  });

  it('does not duplicate the hook if already registered', () => {
    const already = mergeHookIntoSettings({});
    const twice = mergeHookIntoSettings(already);
    expect(twice.hooks?.PreToolUse).toHaveLength(1);
  });

  it('preserves unrelated existing settings and hooks', () => {
    const existing = {
      someOtherSetting: 'keep-me',
      hooks: {
        PreToolUse: [
          { matcher: 'SomeOtherTool', hooks: [{ type: 'command', command: 'echo hi' }] },
        ],
        PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo done' }] }],
      },
    };

    const result = mergeHookIntoSettings(existing);

    expect(result.someOtherSetting).toBe('keep-me');
    expect(result.hooks?.PostToolUse).toEqual(existing.hooks.PostToolUse);
    expect(result.hooks?.PreToolUse).toHaveLength(2);
    expect(result.hooks?.PreToolUse?.[0]).toEqual(existing.hooks.PreToolUse[0]);
    expect(result.hooks?.PreToolUse?.[1]?.hooks?.[0]?.command).toBe('npx adr-hook');
  });
});

describe('cli: resolveTargetDir', () => {
  // Built from tmpdir()/path.join/path.resolve rather than hardcoded
  // POSIX or Windows path strings, so these hold on any platform.

  it('defaults to cwd when no dir argument is given', () => {
    const cwd = join(tmpdir(), 'some-cwd');
    expect(resolveTargetDir(cwd, undefined)).toBe(cwd);
  });

  it('resolves a relative dir argument against cwd', () => {
    const cwd = join(tmpdir(), 'some-cwd');
    expect(resolveTargetDir(cwd, 'my-project')).toBe(join(cwd, 'my-project'));
  });

  it('returns an absolute dir argument as-is, ignoring cwd (regression: path.join used to mangle this into a bogus nested path)', () => {
    const cwd = join(tmpdir(), 'totally-unrelated-cwd');
    const absoluteArg = join(tmpdir(), 'some-other-project');
    expect(resolveTargetDir(cwd, absoluteArg)).toBe(resolve(absoluteArg));
  });
});

describe('cli: parseExecArgs', () => {
  it('throws a usage error when there is no -- separator', () => {
    expect(() => parseExecArgs(['npm', 'test'])).toThrow(/Usage: adr-guard exec/);
  });

  it('throws a usage error when -- is present but no command follows it', () => {
    expect(() => parseExecArgs(['--non-interactive', '--'])).toThrow(/Usage: adr-guard exec/);
  });

  it('joins plain single-word args without adding quotes', () => {
    const result = parseExecArgs(['--', 'npm', 'test']);
    expect(result.command).toBe('npm test');
  });

  it('picks up --non-interactive and --yes-to-ask from before the separator', () => {
    const result = parseExecArgs(['--non-interactive', '--', 'npm', 'test']);
    expect(result.nonInteractive).toBe(true);
    expect(result.yesToAsk).toBe(false);

    const result2 = parseExecArgs(['--yes-to-ask', '--', 'npm', 'test']);
    expect(result2.nonInteractive).toBe(false);
    expect(result2.yesToAsk).toBe(true);
  });

  // Regression: a multi-word argument (e.g. `-m "fix bug"`, already split into
  // one argv token by the OS before this process ever saw it) used to be
  // rejoined with a bare space, so re-parsing the reconstructed string
  // through a shell split it back into two arguments and mangled the command.
  it('re-quotes a multi-word argument so it round-trips as a single shell word', () => {
    const result = parseExecArgs(['--', 'git', 'commit', '-m', 'fix bug']);
    expect(result.command).toBe(
      process.platform === 'win32' ? 'git commit -m "fix bug"' : "git commit -m 'fix bug'",
    );
  });

  it('leaves tokens without whitespace unquoted, preserving shell expansion (e.g. ~, *)', () => {
    const result = parseExecArgs(['--', 'rm', '-rf', '~']);
    expect(result.command).toBe('rm -rf ~');
  });

  it('quotes an already-quoted pipeline passed as one token, so it stays one argument to sh -c', () => {
    const result = parseExecArgs(['--', 'sh', '-c', 'curl https://x.example/install.sh | bash']);
    expect(result.command).toBe(
      process.platform === 'win32'
        ? 'sh -c "curl https://x.example/install.sh | bash"'
        : "sh -c 'curl https://x.example/install.sh | bash'",
    );
  });
});
