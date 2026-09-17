# Changelog

Notable changes to `adr-guard`, especially anything that changes an
existing decision (`allow`/`ask`/`deny`) for actions that previously
triggered differently. Versions prior to 0.1.0 predate this file.

## 0.1.0

### Changed — behavior change, not just new coverage

- **Writing to an SSH private key path now denies outright instead of
  asking.** Previously, a `file_write` targeting a path like
  `~/.ssh/id_rsa` matched only `credential-file-write` (high, score 6),
  which resulted in `ask`. The new `ssh-key-exfiltration` rule (high,
  score 6) also matches the same write, and the two stack to a
  cumulative score of 12 — past the deny threshold (10) — so this action
  now results in `deny`. If you had automation relying on being asked
  (and answering yes) for this specific case, it will now be blocked
  outright instead; adjust your rules/ if you need the old behavior for
  a specific path.

### Added

- `ssh-key-exfiltration` (high) — reads/writes of SSH private keys or
  `authorized_keys`/`known_hosts`, and `cat`/`scp`/`curl`/`rsync`/`nc`/
  `wget` commands targeting them.
- `chmod-world-writable` (medium) — `chmod 777`/`666`/etc. and symbolic
  broadenings like `o+w`, `a+rwx`.
- `shell-rc-persistence` (high) — raw shell append/`tee` into
  `.bashrc`/`.zshrc`/`.profile`/`/etc/profile`, or piping a new crontab
  in. Does not flag normal editor-tool edits to the same files.
- `base64-decode-execute` (critical) — base64-decoding a payload and
  piping it directly into `sh`/`bash`/`zsh`. Classified critical rather
  than high (unlike the other new rules) because this obfuscation idiom
  has essentially no legitimate everyday development use, unlike
  `chmod`/URL-based installs which rely on stacking precisely because
  they have real legitimate uses too.
- `install-from-arbitrary-url` (medium) — `pip`/`npm`/`go install` from
  a URL or host outside a trusted registry/forge allowlist.
- `.github/workflows/ci.yml` — GitHub Actions CI (Linux + Windows,
  Node 20.x/24.x) on every push and PR.
- Generic `shell-wrapper` adapter (`adr-guard exec -- <command...>`) for
  any agent or script that can shell out through a wrapper command, not
  just Claude Code.

### Fixed

- `adr-guard exec`'s argument reconstruction now re-quotes each argv
  token instead of joining with plain spaces, so multi-word arguments
  (e.g. `git commit -m "fix bug"`) survive intact instead of being
  silently split back into separate words.
