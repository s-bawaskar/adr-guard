# ADR Architecture

## Goal

A tool-agnostic detection engine that intercepts coding-agent tool calls
(shell commands, file writes, network requests) before execution and
returns allow / ask / deny in real time, backed by a community-extensible
rule library.

## Core / Adapter Boundary (hard rule)

`src/core/` must never import, reference, or have any type-level knowledge
of a specific coding tool's payload format (Claude Code, Cursor, or
otherwise).

- `src/core/` consumes and produces only `NormalizedAction` (see
  `src/core/types.ts`) and generic `Decision` / `PolicyResult` types.
- Only `src/adapters/<tool>/` is allowed to know the shape of that tool's
  hook input/output.
- Adding support for a new tool means adding a new folder under
  `src/adapters/`, not modifying `src/core/`.

This is enforced by convention + code review for the MVP; an ESLint
`no-restricted-imports` rule scoped to `src/core/**` disallowing imports
from `src/adapters/**` is planned as a follow-up hardening step (not
required for MVP since the directory boundary + single adapter make
violations easy to spot by inspection).

## Confirmed Claude Code Hook Contract (PreToolUse)

Source: official Claude Code docs (`https://code.claude.com/docs/en/hooks`),
confirmed 2026-09-17.

### Input (JSON on stdin for a `command`-type hook)

Common fields on every hook event:

```json
{
  "session_id": "string",
  "prompt_id": "uuid",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/current/working/directory",
  "scratchpad_dir": "/path/to/scratchpad",
  "permission_mode": "default|plan|acceptEdits|auto|dontAsk|bypassPermissions",
  "hook_event_name": "PreToolUse"
}
```

`PreToolUse`-specific fields:

```json
{
  "tool_name": "Bash | Edit | Write | mcp__... | ...",
  "tool_input": { "...": "tool-specific" },
  "tool_use_id": "toolu_..."
}
```

Tool-specific `tool_input` shapes we care about for the MVP:

- **Bash**: `{ command: string, description?: string, timeout?: number, run_in_background?: boolean }`
- **Write**: `{ file_path: string, content: string }`
- **Edit**: `{ file_path: string, old_string: string, new_string: string }`

### Output (JSON on stdout, exit code 0)

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow | deny | ask",
    "permissionDecisionReason": "string",
    "additionalContext": "string (optional)",
    "systemMessage": "string (optional)"
  }
}
```

### Exit codes

| Code | Behavior |
|------|----------|
| `0`  | stdout JSON parsed for decision fields. No output = no decision, normal permission flow applies. |
| `2`  | Blocking error — tool call is blocked regardless of JSON; message comes from `permissionDecisionReason` or stderr. |
| other | Non-blocking error; tool proceeds, stdout treated as plain text. |

### Registration

Hooks are registered per-project in `.claude/settings.json` under
`hooks.PreToolUse`, with a `matcher` (filters by `tool_name`) and a
`command` pointing at the adapter's entry script.

## Data Flow

```
Claude Code (PreToolUse event)
  -> adapter/claude-code/hook-entry.ts   (reads stdin JSON)
  -> adapter/claude-code/normalize.ts    (Claude Code JSON -> NormalizedAction)
  -> core/policy-engine                  (NormalizedAction -> matched rules)
  -> core/scoring                        (matched rules -> score + decision)
  -> core/audit-log                      (write JSON-line record)
  -> adapter/claude-code/respond.ts      (Decision -> Claude Code JSON on stdout)
```

Nothing left of the first arrow, and nothing right of the last arrow, is
allowed inside `src/core/`.

## Repo Layout

```
adr/
  src/
    core/            tool-agnostic: normalizer types, policy engine, scoring, audit log
    adapters/
      claude-code/   the only tool-specific code in the repo (MVP)
    cli/             npx adr init, etc.
  rules/             *.yaml rule definitions (Phase 5+)
  test/
  docs/
```
