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
  kind: regex # regex | path_prefix | domain_allowlist | domain_denylist
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

Drives the overall decision when multiple rules fire on the same
action — the single highest-severity triggered rule wins:

| severity   | decision |
| ---------- | -------- |
| `low`      | allow    |
| `medium`   | ask      |
| `high`     | ask      |
| `critical` | deny     |

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
