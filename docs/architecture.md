# ADR Architecture

## Goal

A tool-agnostic detection engine that intercepts coding-agent tool calls
(shell commands, file writes, network requests) before execution and
returns allow / ask / deny in real time, backed by a community-extensible,
YAML-defined rule library and a weighted risk score rather than a flat
severity lookup.

## Core / Adapter Boundary (hard rule)

`src/core/` must never import, reference, or have any type-level knowledge
of a specific coding tool's payload format (Claude Code, Cursor, or
otherwise).

- `src/core/` consumes and produces only `NormalizedAction` (see
  `src/core/types.ts`) and generic `PolicyResult` / `Decision` types.
- Only `src/adapters/<tool>/` is allowed to know the shape of that tool's
  hook input/output.
- Adding support for a new tool means adding a new folder under
  `src/adapters/` and writing that tool's `normalize()` + entry point —
  not modifying `src/core/`.

Verified by inspection at every phase (`grep -r adapters src/core` should
always return nothing); an ESLint `no-restricted-imports` rule scoped to
`src/core/**` is a reasonable follow-up hardening step if a second
adapter ever gets added, but isn't required while there's exactly one.

## Core modules (`src/core/`)

| File               | Exports                                                                 | Responsibility                                                                                                                                                                                                                                                                                                                    |
| ------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`         | `NormalizedAction`, `RuleMatch`, `PolicyResult`, `Decision`, `Severity` | The only vocabulary core speaks.                                                                                                                                                                                                                                                                                                  |
| `rule-loader.ts`   | `loadRuleDefinitions`, `compileRule`, `loadCompiledRules`               | Reads/validates `.yaml` rule files from a directory, compiles each into an `applies()`/`test()` predicate pair (`CompiledRule`). Supports 4 match kinds: `regex`, `path_prefix`, `domain_allowlist`, `domain_denylist`.                                                                                                           |
| `policy-engine.ts` | `evaluate`, `decide`                                                    | `evaluate(action, rules)` runs every applicable rule, returning one `RuleMatch` per applicable rule (matched or not). `decide(action, matches)` delegates to `scoring.ts` for the actual decision, but also reports the single highest triggered severity for display/audit.                                                      |
| `scoring.ts`       | `score`, `ASK_THRESHOLD`, `DENY_THRESHOLD`                              | Weighted cumulative scoring: each triggered rule contributes points by severity (low=1, medium=3, high=6, critical=10); decision bands on the _sum_ are allow (\<3), ask (\<10), deny (≥10). Two independent `high` matches (12) can outrank a single `critical` match's floor (10) — this is deliberately not "worst rule wins". |
| `audit-log.ts`     | `appendAuditLogEntry`, `auditLogPath`                                   | Writes one JSON line per decision to `<baseDir>/.adr/audit.log` — timestamp, source, full `NormalizedAction` (including the adapter's raw payload, nested), decision, score, severity, matches. Takes only core types, so it's reusable unchanged by any future adapter.                                                          |

## Claude Code adapter (`src/adapters/claude-code/`)

| File               | Responsibility                                                                                                                                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `payload-types.ts` | Typed shapes for Claude Code's raw `PreToolUse` payload and per-tool `tool_input` (Bash, Write, Edit, Read, WebFetch). The only file besides `normalize.ts` allowed to reference these field names.                                            |
| `normalize.ts`     | `normalize(payload): NormalizedAction` — Bash→`shell`, Write/Edit→`file_write` (Edit uses `new_string` as content), Read→`file_read`, WebFetch→`network`, anything else→`other`.                                                               |
| `hook-entry.ts`    | The actual `PreToolUse` hook script: reads stdin, calls `normalize()` → `evaluate()` → `decide()`, writes the audit log entry, and formats the response JSON Claude Code expects. See **Rule resolution** below for where it loads rules from. |

## CLI (`src/cli/`)

`index.ts` implements `adr init [dir]`:

1. Merges an ADR `PreToolUse` hook entry into `<dir>/.claude/settings.json`
   (idempotent — re-running doesn't duplicate the entry; preserves any
   other hooks/settings already there).
2. Copies the bundled `rules/*.yaml` into `<dir>/rules/`, if that
   directory doesn't already exist there.

## Rule resolution (project-local overrides bundled defaults)

`hook-entry.ts` resolves rules from `<project-cwd>/rules` first (the copy
`adr init` drops there), falling back to the package's own bundled
`rules/` only if the project hasn't customized them:

```
resolveRulesDir(baseDir):
  if exists(baseDir/rules): return baseDir/rules
  else: return <package-root>/rules
```

This means editing a project's copy of a rule genuinely changes behavior
on the next tool call — verified live in Phase 8 by editing a copied
rule and confirming the hook picked up the change while the package's
own bundled copy stayed untouched.

## Confirmed Claude Code hook contract (PreToolUse)

Source: official Claude Code docs (`https://code.claude.com/docs/en/hooks`),
confirmed 2026-09-17.

### Input (JSON on stdin for a `command`-type hook)

Common fields on every hook event:

```json
{
  "session_id": "string",
  "prompt_id": "uuid",
  "cwd": "/current/working/directory",
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

Tool-specific `tool_input` shapes ADR currently normalizes:

- **Bash**: `{ command: string, description?: string, timeout?: number, run_in_background?: boolean }`
- **Write**: `{ file_path: string, content: string }`
- **Edit**: `{ file_path: string, old_string: string, new_string: string }`
- **Read**: `{ file_path: string }`
- **WebFetch**: `{ url: string, prompt?: string }`

### Output (JSON on stdout, exit code 0)

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow | deny | ask",
    "permissionDecisionReason": "string"
  }
}
```

Confirmed directly against the docs (not just inferred): a valid
`permissionDecision: "deny"` JSON response with **exit code 0** is the
correct, intended blocking mechanism. Exit code 2 is a separate,
unconditional override that JSON can't undo — ADR never uses it, since
every decision here goes through the standard JSON path.

### Registration

Hooks are registered per-project in `.claude/settings.json` under
`hooks.PreToolUse`, with a `matcher` (filters by `tool_name`) and a
`command` pointing at the adapter's entry script (`adr init` sets this
to `npx adr-hook`).

## Data flow

```
Claude Code (PreToolUse event)
  -> adapters/claude-code/hook-entry.ts   reads stdin JSON
  -> adapters/claude-code/normalize.ts    Claude Code JSON -> NormalizedAction
  -> core/policy-engine.evaluate()        NormalizedAction -> RuleMatch[]
  -> core/policy-engine.decide()          RuleMatch[] -> PolicyResult (via core/scoring.score())
  -> core/audit-log.appendAuditLogEntry() writes one JSON line
  -> adapters/claude-code/hook-entry.ts   PolicyResult -> Claude Code response JSON
```

Nothing left of the first arrow, and nothing right of the last arrow, is
allowed inside `src/core/`.

## Repo layout

```
src/
  core/
    types.ts             NormalizedAction, RuleMatch, PolicyResult, Decision, Severity
    rule-loader.ts        load + validate + compile rules/*.yaml
    policy-engine.ts       evaluate() + decide()
    scoring.ts              weighted cumulative score() + thresholds
    audit-log.ts            appendAuditLogEntry()
  adapters/
    claude-code/          the only tool-specific code in the repo (for now)
      payload-types.ts
      normalize.ts
      hook-entry.ts
  cli/
    index.ts               npx adr init
rules/                     *.yaml rule definitions, loaded at runtime
scripts/
  demo.mjs                 npm run demo — live escalating demo
test/
  fixtures/
    legit-corpus.yaml       must-allow corpus (Phase 7)
    malicious-corpus.yaml   must-flag corpus (Phase 7)
docs/
  architecture.md           this file
  false-positive-report.md  corpus results + tuning history
  demo-script.md            narrated talk track for npm run demo
```
