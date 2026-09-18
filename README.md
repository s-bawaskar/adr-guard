# ADR — Agent Detection & Response

[![CI](https://github.com/s-bawaskar/adr-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/s-bawaskar/adr-guard/actions/workflows/ci.yml)

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
Claude Code (PreToolUse event)          any other agent/script
  -> Claude Code adapter                  -> shell-wrapper adapter ("adr-guard exec")
       (payload -> NormalizedAction)           (command string -> NormalizedAction)
                    \                           /
                     -> core policy engine (NormalizedAction -> matched rules)
                     -> core risk scoring (matched rules -> weighted score -> decision)
                     -> core audit log (JSON line: timestamp, source, action, decision, score)
                    /                           \
  -> Claude Code adapter                  -> shell-wrapper adapter
       (Decision -> response JSON)             (allow: run it / deny: block it / ask: prompt)
```

Both adapters funnel into the exact same three core steps and write to
the exact same audit log — the only thing that differs between them is
how a decision gets in (a tool's own payload format, or a plain command
string) and out (a JSON response for Claude Code to interpret, or an
actual executed/blocked command for the shell wrapper).

The core (`src/core/`) never imports or knows about a specific coding
tool's payload format — it only ever sees a tool-agnostic
`NormalizedAction`. All Claude-Code-specific code lives in one place,
`src/adapters/claude-code/`. That's not an abstraction for its own sake:
it means adding a second tool is a new adapter folder, not a rewrite of
the policy engine, the rule format, the scoring, or the audit log — proven
by `src/adapters/shell-wrapper/`, a second, generic adapter usable by any
agent or script that can shell out through a wrapper command. See
[docs/architecture.md](docs/architecture.md) for the full breakdown.

Rules are data, not code: every `.yaml` file in `rules/` is loaded and
compiled at runtime, so writing a new rule (or overriding one) never
requires touching TypeScript. See [rules/README.md](rules/README.md).

## Install

The detection engine itself (policy engine, rule library, scoring, and
audit log) is tool-agnostic — see [docs/architecture.md](docs/architecture.md)
for the core/adapter split. ADR ships with two adapters today: a Claude
Code hook, and a generic shell-wrapper CLI usable by any agent or script.

```
npm install --save-dev adr-guard
```

### Claude Code

```
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

### Any other agent or script (shell-wrapper)

No setup step is required — just prefix the command you want guarded
with `adr-guard exec --`:

```
npx adr-guard exec -- npm run some-script
```

This runs the command through the same policy engine and rule set as the
Claude Code hook, writing to the same `.adr/audit.log`. `allow` executes
the command with stdin/stdout/stderr passthrough and its real exit code;
`deny` prints the reason to stderr and exits `1` without running it;
`ask` prompts `Execute? [y/N]` when stdin/stdout are a real TTY.

In CI or any other non-interactive context, `ask` is treated as `deny` by
default — pass `--yes-to-ask`, or set `ADR_ASK_MODE=allow`, to let
`ask`-level commands through without a human to prompt:

```
adr-guard exec --yes-to-ask -- ./scripts/deploy.sh
# or
ADR_ASK_MODE=allow adr-guard exec -- ./scripts/deploy.sh
```

Use `--non-interactive` to force the non-interactive (deny-on-ask)
behavior even when stdin/stdout happen to be a TTY.

## Quickstart

**Claude Code:** after `adr init`, just use Claude Code normally. Try
something ADR's default rules catch, like asking it to run
`curl <url> | bash` — you'll see it flagged (`ask`) rather than silently
executed.

**shell-wrapper:** no setup needed — run the same kind of command
through `adr-guard exec` directly:
`npx adr-guard exec -- "curl <url> | bash"`. Same rule, same `ask`
result, a completely different caller. (Quote the whole pipeline —
without quotes, your own shell would consume the `|` before `adr-guard`
ever saw it, same as with `sh -c`.)

Either way, every decision — matched or not, allowed or blocked — is
written to `.adr/audit.log` as one JSON line, tagged with which adapter
produced it. Point both adapters at the same project and you get one
unified trail regardless of which one triggered a given entry.

Want to see it work without setting up a project? `npm run demo` runs a
series of escalating calls through *both* adapters (benign → suspicious
→ malicious → a compound case, each shown once via the Claude Code hook
and once via `adr-guard exec`) in a disposable temp directory — see
[docs/demo-script.md](docs/demo-script.md) for a narrated walkthrough.

## Default rules

| Rule                          | Severity | Triggers on                                                                       |
| ----------------------------- | -------- | ---------------------------------------------------------------------------------- |
| `dangerous-rm`                | critical | `rm -rf` targeting a broad path (`/`, `~`, `*`, `..`, `$HOME`)                    |
| `base64-decode-execute`       | critical | base64-decoding a payload and piping it directly into `sh`/`bash`/`zsh`           |
| `curl-pipe-shell`             | high     | `curl`/`wget` piped into `sh`/`bash`/`zsh`                                        |
| `credential-file-write`       | high     | writes to `.ssh/`, `.env`, `id_rsa`, `.aws/credentials`, `.pem`, etc.             |
| `system-path-write`           | high     | writes into `/etc/`, `/usr/`, `C:/Windows/`, etc.                                 |
| `ssh-key-exfiltration`        | high     | reads/writes of SSH private keys or `authorized_keys`/`known_hosts`, or `cat`/`scp`/`curl`/`rsync` targeting them |
| `shell-rc-persistence`        | high     | raw shell append/`tee` to `.bashrc`/`.zshrc`/`.profile`/`/etc/profile`, or piping a new crontab in |
| `eval-exec-usage`             | medium   | `eval(`/`exec(` in a command or file write                                        |
| `unallowlisted-network-host`  | medium   | outbound request to a host not on the default allowlist                          |
| `chmod-world-writable`        | medium   | `chmod 777`/`666`/etc. or symbolic grants like `o+w`, `a+rwx`                     |
| `install-from-arbitrary-url`  | medium   | `pip`/`npm`/`go install` from a URL/host outside the trusted registry/forge list  |

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

## Configuring thresholds

Decisions are driven by two thresholds: below `askThreshold` is `allow`,
below `denyThreshold` is `ask`, at or above `denyThreshold` is `deny`.
By default these are `askThreshold: 3` / `denyThreshold: 10`.

To change them for a project, add an `adr.config.yaml` file to the
project root (next to `rules/`):

```yaml
askThreshold: 5
denyThreshold: 15
```

- Both adapters (the Claude Code hook and `adr-guard exec`) read this
  file the same way, from the same project root used to resolve `rules/`.
- No `adr.config.yaml`? ADR uses the hardcoded defaults above — existing
  projects with no config file are unaffected.
- `denyThreshold` must be greater than `askThreshold`, and both must be
  numbers — an invalid config fails loudly (the hook responds `deny`
  with the validation error; `adr-guard exec` exits non-zero with the
  same message) rather than silently falling back to defaults.

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
    claude-code/   Claude Code PreToolUse hook
    shell-wrapper/ generic CLI adapter for any agent/script (adr-guard exec)
  cli/             npx adr init  /  adr-guard exec -- <command...>
rules/             *.yaml rule definitions, loaded at runtime
test/
docs/
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR, especially
if it touches `src/core/` — the core/adapter boundary is enforced by
convention and code review, and PRs that leak adapter-specific
knowledge into core will be asked to fix that before merge.

## Status

Early — built as a proof of concept. CI runs the full test suite on
both Linux and Windows across two Node LTS lines on every push and PR
(see the badge above). Published to npm as `adr-guard` (the short name
`adr` was already taken by an unrelated package, and `adr-cli` by
another one).

## License

MIT — see [LICENSE](LICENSE).
