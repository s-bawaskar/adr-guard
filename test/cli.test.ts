import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergeHookIntoSettings, resolveTargetDir } from '../src/cli/index.js';

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
