# Writing ADR rules

Rules are data, not code. Every `.yaml`/`.yml` file in this directory is
loaded and compiled at startup (`src/core/rule-loader.ts`) and evaluated
against a **tool-agnostic** `NormalizedAction` — never against a
specific coding tool's raw payload. A rule you write here works
automatically for every current and future adapter (Claude Code today;
Cursor, an OS-level hook, etc. later).

## Schema

```yaml
id: dangerous-rm # required, unique, kebab-case
appliesTo: shell # required: shell | file_write | file_read | network | other | any
field: command # optional: which action field(s) to test — string or list
match: # required
  kind: regex # regex | path_prefix | domain_allowlist | domain_denylist | rate_window
  pattern: 'rm\s+-rf\s+/' # kind-specific fields, see below
severity: critical # required: low | medium | high | critical
message: 'Recursive force-delete on a broad path' # required, shown to the agent/user
```

### `appliesTo`

One of the `NormalizedAction` types: `shell`, `file_write`, `file_read`,
`network`, `other`, or `any` (matches every action type — useful when a
pattern applies across types, like `eval-exec-usage.yaml`, which checks
both shell commands and file writes).

### `field`

Which `NormalizedAction` field(s) the match runs against:
`command`, `content`, `filePath`, or `url`. Can be a single value or a
list (list = match if **any** listed field satisfies the rule). If
omitted, `path_prefix` defaults to `filePath` and the domain kinds
default to `url` — `regex` has no default and needs an explicit field.

### `severity`

Each triggered rule contributes points by severity (`low: 1`,
`medium: 3`, `high: 6`, `critical: 10`), and the decision comes from the
**cumulative score** across every rule that matched — not just the
single worst one. A lone `low` match allows; two `high` matches together
(12 points) escalate to `deny` even though neither alone would. See
`src/core/scoring.ts`.

The score-to-decision cutoffs (`askThreshold`, `denyThreshold`) default
to 3 and 10, and are project-configurable via `adr.config.yaml` — see
the "Configuring thresholds" section in the top-level
[README.md](../README.md#configuring-thresholds).

## Match kinds

### `regex`

```yaml
match:
  kind: regex
  pattern: '\bcurl\b.*\|\s*bash\b'
  flags: 'i' # optional, defaults to 'i' (case-insensitive)
```

`pattern` is passed straight to `new RegExp(pattern, flags)`. Matches if
the regex tests true against any configured `field`'s value.

### `path_prefix`

```yaml
match:
  kind: path_prefix
  prefixes:
    - /etc/
    - 'C:/Windows/'
```

Matches if `filePath` (or the configured `field`) starts with any listed
prefix. Use this for "outside the workspace" / "system directory" style
checks rather than a regex.

### `domain_allowlist`

```yaml
match:
  kind: domain_allowlist
  domains:
    - github.com
    - registry.npmjs.org
```

**Matches (i.e. flags/triggers) when the URL's hostname is NOT in the
list.** Use this when you want to name the hosts you trust and flag
everything else — the common case for outbound network calls.

### `domain_denylist`

```yaml
match:
  kind: domain_denylist
  domains:
    - known-malware-host.example
```

Matches when the hostname **is** in the list. Use this for a short list
of specifically known-bad hosts rather than an allowlist.

### `rate_window`

```yaml
match:
  kind: rate_window
  windowSeconds: 60
  threshold: 3
  of:
    decision: deny # OR: ruleId: some-other-rule-id (exactly one, not both)
```

Unlike the four kinds above, `rate_window` doesn't test the current
action in isolation — it matches when something happened `threshold` or
more times within the last `windowSeconds`, across **separate**
invocations of ADR (every hook call / `adr-guard exec` call is its own
process; this is the one match kind with memory of what came before).
That history is kept in `.adr/rate-state/`, pruned automatically to
whatever window the loaded rate rules actually need — see
`src/core/rate-state.ts`.

`of` takes exactly one of:

- **`decision: allow | ask | deny`** — counts prior actions whose
  *final* decision was that value. Counts history only, never the
  current action (its own decision isn't known yet at the point rate
  rules are evaluated — that's what this rule is helping decide).
- **`ruleId: <some other rule's id>`** — counts prior actions where that
  rule matched, **plus** the current action if that same rule already
  matched on it (that part *is* known already, so it counts immediately
  rather than waiting for a future invocation).

**Cross-rule validation:** `ofRuleId` must resolve to a real rule
elsewhere in the same `rules/` directory, checked once every file in the
directory has been loaded (not per-file, unlike every other kind) —
`npm test` (`rules-integration.test.ts`) catches a typo'd or renamed
`ofRuleId` the same way it catches any other malformed rule. It must
also be a **stateless** rule (`regex`/`path_prefix`/`domain_allowlist`/
`domain_denylist`) — a rate rule can't reference another rate rule,
since rate-rule matches are deliberately never recorded to history (to
avoid a rate rule feeding its own future triggers).

**Worked example** — the shipped `burst-sensitive-writes.yaml`:

```yaml
id: burst-sensitive-writes
appliesTo: any
match:
  kind: rate_window
  windowSeconds: 120
  threshold: 5
  of:
    ruleId: credential-file-write
severity: critical
message: 'credential-file-write matched 5 or more times within 2 minutes — possible credential harvesting attempt'
```

`credential-file-write` (a plain `regex` rule) might only be `high`
severity on its own — enough to `ask`, not `deny`. But 5 hits on it
within 2 minutes is a different, much more suspicious pattern than one
isolated write, so this rule escalates that *pattern* to `critical`
independent of what any single write scored. See also the shipped
`burst-of-denies.yaml` for the `of.decision` form (3+ denied actions in
60 seconds).

## Adding a rule

1. Create a new `.yaml` file in this directory — one rule per file,
   filename matching the `id` by convention (e.g. `dangerous-rm.yaml`).
2. Run `npm test` — `test/rules-integration.test.ts` loads every file in
   this directory for real, so a malformed rule fails the test suite
   immediately with a clear validation error naming the file and field.
3. Add a positive and negative example to that integration test (a
   command/path/URL that should trigger it, and one that shouldn't) so
   regressions get caught automatically.

## What NOT to do

- Don't reference a coding tool's raw field names (`tool_name`,
  `tool_input`, etc.) — rules only ever see `NormalizedAction` fields
  (`command`, `content`, `filePath`, `url`).
- Don't assume a specific OS path separator — a Windows path here looks
  like `C:/Windows/` (forward slashes; Claude Code's payloads use
  forward slashes on Windows too).
