/**
 * Claude Code's raw PreToolUse payload shapes, confirmed against
 * https://code.claude.com/docs/en/hooks (see docs/architecture.md).
 * Nothing outside src/adapters/claude-code/ may import from this file.
 */
export interface ClaudeCodePreToolUsePayload {
  session_id?: string;
  prompt_id?: string;
  cwd?: string;
  permission_mode?: string;
  hook_event_name?: string;
  tool_name: string;
  tool_input: unknown;
  tool_use_id?: string;
}

export interface BashToolInput {
  command: string;
  description?: string;
  timeout?: number;
  run_in_background?: boolean;
}

export interface WriteToolInput {
  file_path: string;
  content: string;
}

export interface EditToolInput {
  file_path: string;
  old_string: string;
  new_string: string;
}

export interface ReadToolInput {
  file_path: string;
}

export interface WebFetchToolInput {
  url: string;
  prompt?: string;
}
