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
always return nothing). This is no longer a hypothetical: `src/adapters/
shell-wrapper/` is a second, independent adapter (see below) that reuses
`src/core/` completely unmodified, proving the boundary holds. An ESLint
`no-restricted-imports` rule scoped to `src/core/**` remains a reasonable
follow-up hardening step, but isn't required — the two adapters already
demonstrate the boundary by construction.

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

## shell-wrapper adapter (`src/adapters/shell-wrapper/`)

A generic adapter for any agent or script that can shell out through a
wrapper command, not just Claude Code — a CI pipeline, a different coding
agent, a cron job, a human at a terminal who wants a guard rail. Unlike
the Claude Code adapter, it has no host tool feeding it a structured
payload on stdin; the input is just a command string, so `normalize()`
takes that string directly rather than a parsed object.

| File           | Responsibility                                                                                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `normalize.ts` | `normalize(command: string): NormalizedAction` — always `type: 'shell'`, `command` and `raw` both set to the input string, `source: 'shell-wrapper'`. No other action types exist for this adapter.       |
| `execute.ts`   | `runShellCommand(command, options): Promise<number>` — the adapter's entry point (called from the CLI's `exec` subcommand). Runs `normalize()` → `evaluate()` → `decide()` → `appendAuditLogEntry()` (all imported from `src/core/`, unmodified), then acts on the decision. |

Decision handling in `runShellCommand`:

- **allow** — runs the command via `child_process.spawnSync(command, { shell: true, stdio: 'inherit' })`, so stdin/stdout/stderr passthrough and the child's exit code are preserved, and returns that exit code.
- **deny** — does not execute; writes `ADR denied command: <reason>` to stderr and returns `1`.
- **ask** — in an interactive TTY (both `stdin.isTTY` and `stdout.isTTY`), prompts `Execute? [y/N]` via `node:readline/promises` and executes only on `y`. In a non-interactive context (no TTY, or the CLI's `--non-interactive` flag), `ask` is treated as `deny` by default. Two overrides bypass the prompt entirely and always execute: the CLI's `--yes-to-ask` flag, or the `ADR_ASK_MODE=allow` environment variable — both meant for CI/scripted use where no human can answer a prompt.

Every branch calls the same `appendAuditLogEntry(baseDir, action, result)`
from `src/core/audit-log.ts` that the Claude Code adapter calls, writing
to the same `<baseDir>/.adr/audit.log`. The `source: 'shell-wrapper'`
field on the logged `NormalizedAction` is what distinguishes these
entries from Claude Code's in the unified audit trail — nothing else
about the log format differs.

Rule resolution follows the same project-local-overrides-bundled pattern
as `hook-entry.ts` (see **Rule resolution** below).

## CLI (`src/cli/`)

`index.ts` implements two subcommands, both dispatched from the same
hand-rolled `process.argv` parser (no CLI framework):

1. **`adr init [dir]`**
   - Merges an ADR `PreToolUse` hook entry into `<dir>/.claude/settings.json`
     (idempotent — re-running doesn't duplicate the entry; preserves any
     other hooks/settings already there).
   - Copies the bundled `rules/*.yaml` into `<dir>/rules/`, if that
     directory doesn't already exist there.
2. **`adr-guard exec [--non-interactive|--yes-to-ask] -- <command...>`**
   — the shell-wrapper adapter's entry point. `parseExecArgs` splits argv
   on a literal `--`; everything after it is the command to guard,
   everything before it is CLI flags. This is a subcommand of the
   existing CLI rather than a new bin: it reuses the existing argv
   parser and the "only run `main()` when invoked directly" pattern that
   makes `cli.test.ts` possible, and avoids maintaining a second binary.
   The `adr-guard` bin name (an alias for the same `dist/cli/index.js` as
   the terser `adr`) exists so this reads naturally: `adr-guard exec --
   npm test`.

   Because the OS shell has already split argv into tokens by the time
   this process sees them, `parseExecArgs` re-quotes each token before
   rejoining them into the single command string the shell-wrapper
   adapter expects — otherwise a token containing whitespace (e.g. `-m
   "fix bug"`, one argv token from the caller's shell) would come back
   out as two words once handed to `spawnSync(command, { shell: true
   })`. Only whitespace and the platform's quote character trigger
   quoting, so shell features (pipes, redirects) still work when a
   caller passes a whole pipeline as one already-quoted token, e.g.
   `adr-guard exec -- sh -c "curl url | bash"`.

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

Claude Code adapter:

```
Claude Code (PreToolUse event)
  -> adapters/claude-code/hook-entry.ts   reads stdin JSON
  -> adapters/claude-code/normalize.ts    Claude Code JSON -> NormalizedAction
  -> core/policy-engine.evaluate()        NormalizedAction -> RuleMatch[]
  -> core/policy-engine.decide()          RuleMatch[] -> PolicyResult (via core/scoring.score())
  -> core/audit-log.appendAuditLogEntry() writes one JSON line
  -> adapters/claude-code/hook-entry.ts   PolicyResult -> Claude Code response JSON
```

shell-wrapper adapter:

```
any agent/script ("adr-guard exec -- <command...>")
  -> cli/index.ts                         parses argv into a command string
  -> adapters/shell-wrapper/execute.ts    runShellCommand(command, options)
  -> adapters/shell-wrapper/normalize.ts  command string -> NormalizedAction
  -> core/policy-engine.evaluate()        NormalizedAction -> RuleMatch[]
  -> core/policy-engine.decide()          RuleMatch[] -> PolicyResult (via core/scoring.score())
  -> core/audit-log.appendAuditLogEntry() writes one JSON line to the SAME .adr/audit.log
  -> adapters/shell-wrapper/execute.ts    PolicyResult -> spawnSync (allow) / stderr+exit 1 (deny) / prompt (ask)
```

Both adapters converge on the same three middle steps and the same audit
log. Nothing left of the second arrow, and nothing right of the
second-to-last arrow, is allowed inside `src/core/`.

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
    claude-code/          Claude Code PreToolUse hook
      payload-types.ts
      normalize.ts
      hook-entry.ts
    shell-wrapper/        generic CLI adapter for any agent/script
      normalize.ts
      execute.ts
  cli/
    index.ts               npx adr init  /  adr-guard exec -- <command...>
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
