# ADR — Agent Detection & Response

ADR hooks into your coding agent and inspects its tool calls — shell
commands, file writes, network requests — against a policy library
_before_ they execute, blocking or flagging dangerous actions live.

Think YARA/Semgrep, but for what your AI coding agent is about to _do_,
not the code it's about to write.

```
$ claude
> delete all the old build artifacts
● rm -rf /

  ADR blocked this: [critical] dangerous-rm: Recursive force-delete
  targeting a broad path (/, ~, *, .., $HOME) (risk score: 10)
```

## Why

Agentic coding tools run real shell commands, write real files, and make
real network requests on your behalf, often faster than you can read
them. ADR is a policy layer that sits between "the agent decided to do
X" and "X actually happens" — allow, ask, or deny, with every decision
written to an audit log.

## How it works

```
Claude Code (PreToolUse event)
  -> adapter (Claude Code payload -> NormalizedAction)
  -> core policy engine (NormalizedAction -> matched rules)
  -> core risk scoring (matched rules -> weighted score -> decision)
  -> core audit log (JSON line: timestamp, action, decision, score)
  -> adapter (Decision -> Claude Code response JSON)
```

The core (`src/core/`) never imports or knows about a specific coding
tool's payload format — it only ever sees a tool-agnostic
`NormalizedAction`. All Claude-Code-specific code lives in one place,
`src/adapters/claude-code/`. That's not an abstraction for its own sake:
it means adding a second tool (Cursor, an OS-level hook, whatever comes
next) is a new adapter folder, not a rewrite of the policy engine, the
rule format, the scoring, or the audit log. See
[docs/architecture.md](docs/architecture.md) for the full breakdown.

Rules are data, not code: every `.yaml` file in `rules/` is loaded and
compiled at runtime, so writing a new rule (or overriding one) never
requires touching TypeScript. See [rules/README.md](rules/README.md).

## Install

Currently set up for **Claude Code** only.

```
npm install --save-dev adr
npx adr init
```

`adr init`:

- registers ADR's `PreToolUse` hook in `.claude/settings.json` (merges
  with whatever hooks you already have — doesn't clobber them)
- copies the default rule set into `rules/` in your project, so you can
  edit it immediately — ADR always prefers a project-local `rules/`
  directory over its own bundled defaults

> Installing as a dev dependency (rather than relying on `npx` to fetch
> it fresh) means the hook runs from your local `node_modules` on every
> tool call instead of doing a network lookup each time.

## Quickstart

After `adr init`, just use Claude Code normally. Try something ADR's
default rules catch, like asking it to run `curl <url> | bash` — you'll
see it flagged (`ask`) rather than silently executed. Every decision,
matched or not, is written to `.adr/audit.log` as one JSON line per tool
call.

## Default rules

| Rule                         | Severity | Triggers on                                                           |
| ---------------------------- | -------- | --------------------------------------------------------------------- |
| `dangerous-rm`               | critical | `rm -rf` targeting a broad path (`/`, `~`, `*`, `..`, `$HOME`)        |
| `curl-pipe-shell`            | high     | `curl`/`wget` piped into `sh`/`bash`/`zsh`                            |
| `credential-file-write`      | high     | writes to `.ssh/`, `.env`, `id_rsa`, `.aws/credentials`, `.pem`, etc. |
| `system-path-write`          | high     | writes into `/etc/`, `/usr/`, `C:/Windows/`, etc.                     |
| `eval-exec-usage`            | medium   | `eval(`/`exec(` in a command or file write                            |
| `unallowlisted-network-host` | medium   | outbound request to a host not on the default allowlist               |

Decisions aren't just "worst rule wins" — risk scores from multiple
triggered rules add up, so e.g. a write that's _both_ a credential path
and a system path escalates to `deny` even though neither rule alone is
critical. See [docs/false-positive-report.md](docs/false-positive-report.md)
for the corpus this was tuned against (0% false positives / false
negatives on 35 hand-built cases as of the last tuning pass).

## Adding or changing a rule

Edit (or add) a `.yaml` file in your project's `rules/` directory — see
[rules/README.md](rules/README.md) for the schema and the four match
kinds (`regex`, `path_prefix`, `domain_allowlist`, `domain_denylist`).
No code changes, no rebuild.

## Development

```
npm install
npm run build
npm test         # unit tests + rule-corpus regression suite
npm run lint
```

Repo layout:

```
src/
  core/            tool-agnostic: normalizer types, policy engine, scoring, audit log
  adapters/
    claude-code/   the only tool-specific code in the repo (for now)
  cli/             npx adr init
rules/             *.yaml rule definitions, loaded at runtime
test/
docs/
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR, especially
if it touches `src/core/` — the core/adapter boundary is enforced by
convention and code review, and PRs that leak adapter-specific
knowledge into core will be asked to fix that before merge.

## Status

Early — built as a proof of concept, most heavily exercised against
Claude Code on Windows/macOS/Linux shells. Package name `adr` on npm is
already taken by an unrelated project, so this hasn't been published
yet; treat `npm install --save-dev adr` above as the intended workflow
once it ships under its real name.

## License

MIT — see [LICENSE](LICENSE).
