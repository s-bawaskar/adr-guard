import { describe, expect, it } from 'vitest';
import { normalize } from '../src/adapters/claude-code/normalize.js';
import type { ClaudeCodePreToolUsePayload } from '../src/adapters/claude-code/payload-types.js';

function payload(overrides: Partial<ClaudeCodePreToolUsePayload>): ClaudeCodePreToolUsePayload {
  return {
    session_id: 'abc123',
    prompt_id: '550e8400-e29b-41d4-a716-446655440000',
    cwd: '/home/user/my-project',
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: {},
    tool_use_id: 'toolu_01ABC',
    ...overrides,
  };
}

describe('normalize (Claude Code adapter)', () => {
  it('maps Bash to a shell action with the command', () => {
    const input = payload({
      tool_name: 'Bash',
      tool_input: { command: 'npm test', description: 'Run test suite' },
    });

    const result = normalize(input);

    expect(result.type).toBe('shell');
    expect(result.command).toBe('npm test');
    expect(result.source).toBe('claude-code');
    expect(result.raw).toBe(input);
  });

  it('maps Write to a file_write action with path and content', () => {
    const input = payload({
      tool_name: 'Write',
      tool_input: { file_path: '/path/to/file.ts', content: 'export const x = 1;' },
    });

    const result = normalize(input);

    expect(result.type).toBe('file_write');
    expect(result.filePath).toBe('/path/to/file.ts');
    expect(result.content).toBe('export const x = 1;');
  });

  it('maps Edit to a file_write action using new_string as content', () => {
    const input = payload({
      tool_name: 'Edit',
      tool_input: {
        file_path: '/path/to/file.ts',
        old_string: 'const x = 1;',
        new_string: 'const x = 2;',
      },
    });

    const result = normalize(input);

    expect(result.type).toBe('file_write');
    expect(result.filePath).toBe('/path/to/file.ts');
    expect(result.content).toBe('const x = 2;');
  });

  it('maps Read to a file_read action with path', () => {
    const input = payload({
      tool_name: 'Read',
      tool_input: { file_path: '/path/to/file.ts' },
    });

    const result = normalize(input);

    expect(result.type).toBe('file_read');
    expect(result.filePath).toBe('/path/to/file.ts');
  });

  it('maps WebFetch to a network action with url', () => {
    const input = payload({
      tool_name: 'WebFetch',
      tool_input: { url: 'https://example.com', prompt: 'summarize' },
    });

    const result = normalize(input);

    expect(result.type).toBe('network');
    expect(result.url).toBe('https://example.com');
  });

  it('falls back to "other" for unrecognized tools without throwing', () => {
    const input = payload({
      tool_name: 'mcp__memory__create_entities',
      tool_input: { entities: [] },
    });

    const result = normalize(input);

    expect(result.type).toBe('other');
    expect(result.source).toBe('claude-code');
    expect(result.raw).toBe(input);
  });
});
