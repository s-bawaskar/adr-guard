# Contributing to ADR

## Adding or fixing a rule (the easy path)

Most contributions will be here. See [rules/README.md](rules/README.md)
for the schema. In short:

1. Add or edit a `.yaml` file in `rules/`.
2. Add a positive case (something that should trigger it) and a
   negative case (something similar that shouldn't) to
   `test/fixtures/malicious-corpus.yaml` and `test/fixtures/legit-corpus.yaml`
   respectively.
3. `npm test` — `test/rules-integration.test.ts` and `test/corpus.test.ts`
   load the real `rules/` directory, so a malformed rule or a regression
   fails immediately with a clear message naming the file and field.

If you're fixing a false positive, please add the specific case that was
wrongly flagged to `legit-corpus.yaml` rather than just tuning the regex
— otherwise the same false positive can silently come back later. See
[docs/false-positive-report.md](docs/false-positive-report.md) for the
pattern this project follows.

## Code changes

- `npm install`, `npm run build`, `npm test`, `npm run lint` should all
  pass before opening a PR.
- Run `npm run format` (Prettier) if the linter or CI flags formatting.

### The core/adapter boundary

This is the one architectural rule the project actually enforces:
**`src/core/` must never import from, or have type-level knowledge of,
`src/adapters/**`.** Core only ever consumes and produces
`NormalizedAction` / `PolicyResult` (see `src/core/types.ts`). Adapter
code (currently only `src/adapters/claude-code/`) is the only place
allowed to know a specific coding tool's raw payload shape.

This isn't cosmetic — it's what makes adding a second adapter (Cursor,
an OS-level hook, whatever) a new folder under `src/adapters/` instead
of a rewrite of the policy engine, scoring, or audit log. A PR that
leaks adapter-specific field names or assumptions into `src/core/` will
be asked to fix that before merge, even if the feature itself is fine.

### Adding a new adapter

1. New folder: `src/adapters/<tool-name>/`.
2. Write that tool's version of `normalize()`: raw payload ->
   `NormalizedAction`. This is the only function that needs to know both
   formats.
3. Write that tool's version of `hook-entry.ts` (or equivalent entry
   point): read the tool's input, call `normalize()`, then
   `evaluate()` / `decide()` from `src/core/policy-engine.ts` exactly as
   the Claude Code adapter does, then translate the `Decision` back into
   whatever response shape that tool expects.
4. Don't touch `src/core/` unless you're fixing an actual bug there —
   if you find yourself needing to, that's a signal the tool-agnostic
   abstraction is missing something, worth raising as its own
   discussion before the PR.

## Reporting a bug

Open an issue with: the command/action that triggered (or should have
triggered but didn't) a rule, the rule you expected, and what actually
happened. If it's a false positive/negative, a corpus entry (see above)
is the most useful thing you can attach.
