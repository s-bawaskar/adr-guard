import type { NormalizedAction } from '../../core/types.js';
import type {
  BashToolInput,
  ClaudeCodePreToolUsePayload,
  EditToolInput,
  ReadToolInput,
  WebFetchToolInput,
  WriteToolInput,
} from './payload-types.js';

const SOURCE = 'claude-code';

/**
 * Maps a raw Claude Code PreToolUse payload to the tool-agnostic
 * NormalizedAction shape. This is the only function in the codebase that
 * knows both Claude Code's payload format AND core's NormalizedAction
 * format — core never sees `payload` directly.
 */
export function normalize(payload: ClaudeCodePreToolUsePayload): NormalizedAction {
  switch (payload.tool_name) {
    case 'Bash': {
      const input = payload.tool_input as BashToolInput;
      return { type: 'shell', command: input.command, raw: payload, source: SOURCE };
    }
    case 'Write': {
      const input = payload.tool_input as WriteToolInput;
      return {
        type: 'file_write',
        filePath: input.file_path,
        content: input.content,
        raw: payload,
        source: SOURCE,
      };
    }
    case 'Edit': {
      const input = payload.tool_input as EditToolInput;
      return {
        type: 'file_write',
        filePath: input.file_path,
        content: input.new_string,
        raw: payload,
        source: SOURCE,
      };
    }
    case 'Read': {
      const input = payload.tool_input as ReadToolInput;
      return { type: 'file_read', filePath: input.file_path, raw: payload, source: SOURCE };
    }
    case 'WebFetch': {
      const input = payload.tool_input as WebFetchToolInput;
      return { type: 'network', url: input.url, raw: payload, source: SOURCE };
    }
    default:
      return { type: 'other', raw: payload, source: SOURCE };
  }
}
