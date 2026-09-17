# Launch post drafts

Three variants for different venues. Swap `<repo-url>` for the real
GitHub URL once it exists.

## Show HN

**Title:** Show HN: ADR – a policy layer that inspects Claude Code's
tool calls before they execute

**Body:**

Agentic coding tools run real shell commands, write real files, and
make real network requests on your behalf — often faster than you can
read them. ADR hooks into Claude Code's `PreToolUse` event and checks
each tool call against a rule library before it runs, returning allow /
ask / deny in real time. Think YARA/Semgrep, but for what the agent is
about to _do_, not the code it's about to write.

A few things I tried to get right:

- **Rules are YAML, not code.** Four match kinds (regex, path prefix,
  domain allow/denylist), loaded at runtime — adding a rule is a PR to
  one file, no rebuild.
- **Weighted scoring, not "worst rule wins."** Two independently
  medium-severity matches on the same action can escalate to a block
  even though neither alone would — e.g. a file write that's both a
  credential-shaped path and a system directory.
- **Tool-agnostic core.** The policy engine, scoring, and audit log have
  zero knowledge of Claude Code's payload format — that's isolated to
  one adapter folder, so a second adapter (Cursor, an OS-level hook) is
  additive, not a rewrite.
- **Tuned against a corpus, not vibes.** 26 "must-allow" and 9
  "must-flag" hand-built cases run in CI; two real false positives
  (`.env.example`, `id_rsa.pub`) got caught and fixed before ship.

`npx adr init` registers the hook and drops an editable rule set into
your project. `npm run demo` runs a live escalating demo with no setup.

Repo: <repo-url>

Early — feedback on the rule set, the scoring thresholds, or "what
should the second adapter be" all welcome.

## Technical community post (r/programming, r/netsec, similar)

**Title:** I built a policy layer that intercepts Claude Code's tool
calls before they run — rules are YAML, scoring is cumulative not
worst-case

Coding agents execute real commands on your machine. I wanted something
between "the agent decided to run `rm -rf /`" and "`rm -rf /` actually
ran" — so I built ADR, which hooks into Claude Code's `PreToolUse` event
and runs every shell command, file write, and network request through a
policy library first.

The interesting design decisions, if you're into this kind of thing:

1. **Normalize before you police.** Every tool call gets converted into
   a tool-agnostic shape (`{ type, command, filePath, url, ... }`)
   before any rule sees it. The rule engine, scoring, and audit log have
   never heard of Claude Code specifically — one small adapter file
   translates in both directions. Adding Cursor support later means a
   new adapter, not touching the policy engine.
2. **Scores add up.** Instead of "the single worst matched rule decides
   the outcome," each matched rule contributes weighted points and the
   _sum_ crosses allow/ask/deny thresholds. Two `high`-severity matches
   on one action (e.g. writing a credential file into a system
   directory) can deny even though neither alone would.
3. **A corpus, not a demo.** Before calling any rule "done," it runs
   against a hand-built corpus of ~35 real commands split into "must
   never trigger" and "must always trigger." This is what actually
   caught two real false positives (public SSH keys, `.env.example`
   template files) before they'd have annoyed someone.

Rules live in plain YAML files, loaded at runtime — `rules/README.md`
has the schema if you want to add one.

Repo: <repo-url>

## Claude Code community / Discord (short form)

Built a tool that hooks into Claude Code's `PreToolUse` event and
blocks/flags dangerous tool calls (rm -rf on broad paths, curl-pipe-
to-shell, credential file writes, etc.) before they execute, with a
full audit log and YAML-defined rules you can edit per-project.
`npx adr init` sets it up. Repo: <repo-url> — would love rule
suggestions or a sanity check on the scoring thresholds.
