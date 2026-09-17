import { describe, expect, it } from 'vitest';
import { mergeHookIntoSettings } from '../src/cli/index.js';

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
