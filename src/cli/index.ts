#!/usr/bin/env node
/**
 * `npx adr init [dir]` — sets up ADR in a target project: registers the
 * Claude Code PreToolUse hook in .claude/settings.json (merging with
 * whatever's already there) and copies the default rule set so the
 * project has its own editable rules/ directory.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runShellCommand } from '../adapters/shell-wrapper/execute.js';

// dist/cli/index.js -> package root
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK_COMMAND = 'npx adr-hook';
const HOOK_MATCHER = 'Bash|Write|Edit|WebFetch';

interface HookCommandEntry {
  type: string;
  command: string;
}

interface HookMatcherEntry {
  matcher?: string;
  hooks?: HookCommandEntry[];
}

interface ClaudeSettings {
  hooks?: {
    PreToolUse?: HookMatcherEntry[];
    [otherEvent: string]: unknown;
  };
  [otherKey: string]: unknown;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function isAlreadyRegistered(preToolUse: HookMatcherEntry[]): boolean {
  return preToolUse.some((entry) => entry.hooks?.some((h) => h.command === HOOK_COMMAND));
}

export function mergeHookIntoSettings(existing: ClaudeSettings): ClaudeSettings {
  const settings: ClaudeSettings = { ...existing, hooks: { ...existing.hooks } };
  const preToolUse = [...(settings.hooks?.PreToolUse ?? [])];

  if (!isAlreadyRegistered(preToolUse)) {
    preToolUse.push({
      matcher: HOOK_MATCHER,
      hooks: [{ type: 'command', command: HOOK_COMMAND }],
    });
  }

  settings.hooks = { ...settings.hooks, PreToolUse: preToolUse };
  return settings;
}

function registerHook(targetDir: string): void {
  const claudeDir = join(targetDir, '.claude');
  ensureDir(claudeDir);
  const settingsPath = join(claudeDir, 'settings.json');

  const existing: ClaudeSettings = existsSync(settingsPath)
    ? (JSON.parse(readFileSync(settingsPath, 'utf-8')) as ClaudeSettings)
    : {};

  writeFileSync(settingsPath, JSON.stringify(mergeHookIntoSettings(existing), null, 2) + '\n');
  console.log(`Registered ADR's PreToolUse hook in ${settingsPath}`);
}

function copyDefaultRules(targetDir: string): void {
  const sourceDir = join(PACKAGE_ROOT, 'rules');
  const destDir = join(targetDir, 'rules');

  if (existsSync(destDir)) {
    console.log(`rules/ already exists at ${destDir} — leaving it untouched`);
    return;
  }

  ensureDir(destDir);
  const ruleFiles = readdirSync(sourceDir).filter((f) =>
    ['.yaml', '.yml', '.md'].includes(extname(f)),
  );
  for (const file of ruleFiles) {
    copyFileSync(join(sourceDir, file), join(destDir, file));
  }
  console.log(`Copied default rule set (${ruleFiles.length} files) to ${destDir}`);
}

function init(targetDir: string): void {
  registerHook(targetDir);
  copyDefaultRules(targetDir);
  console.log('\nADR is set up.');
  console.log(`Edit ${join(targetDir, 'rules')} to customize policy for this project.`);
  console.log(`Audit trail will be written to ${join(targetDir, '.adr', 'audit.log')}.`);
  console.log(
    '\nFor the hook to run fast (no network lookup on every tool call), install ADR ' +
      'as a dev dependency: npm install --save-dev adr-guard',
  );
}

/**
 * Re-quotes a single argv token so that re-joining tokens with spaces and
 * handing the result to a real shell (`spawnSync(command, { shell: true })`)
 * reproduces the same argument boundaries the OS already gave us — e.g. a
 * token like `fix bug` (from `-m "fix bug"`) must come back out as one
 * argument, not two. Only whitespace and the platform's quote character
 * trigger quoting; everything else (`|`, `~`, `*`, `$`, ...) is left alone
 * so shell features keep working when a caller deliberately passes a whole
 * pipeline as one token, e.g. `exec -- sh -c "curl url | bash"`.
 */
function quoteShellArg(token: string): string {
  if (process.platform === 'win32') {
    if (token !== '' && !/[\s"]/.test(token)) return token;
    return `"${token.replace(/"/g, '""')}"`;
  }
  if (token !== '' && !/[\s']/.test(token)) return token;
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

export function parseExecArgs(args: string[]): {
  command: string;
  nonInteractive: boolean;
  yesToAsk: boolean;
} {
  const separator = args.indexOf('--');
  const optionArgs = separator === -1 ? args : args.slice(0, separator);
  const commandArgs = separator === -1 ? [] : args.slice(separator + 1);
  if (commandArgs.length === 0) {
    throw new Error('Usage: adr-guard exec [--non-interactive|--yes-to-ask] -- <command...>');
  }
  return {
    command: commandArgs.map(quoteShellArg).join(' '),
    nonInteractive: optionArgs.includes('--non-interactive'),
    yesToAsk: optionArgs.includes('--yes-to-ask'),
  };
}

/** `dirArg` (e.g. from argv) may be relative (resolved against `cwd`) or already absolute (returned as-is — `path.join` would otherwise mangle it). */
export function resolveTargetDir(cwd: string, dirArg: string | undefined): string {
  return dirArg ? resolve(cwd, dirArg) : cwd;
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;

  if (command === 'init') {
    const targetDir = resolveTargetDir(process.cwd(), rest[0]);
    init(targetDir);
    return;
  }

  if (command === 'exec') {
    try {
      const options = parseExecArgs(rest);
      process.exitCode = await runShellCommand(options.command, options);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    return;
  }

  console.error(
    `Unknown command: ${command ?? '(none)'}\n\nUsage: adr init [dir]\n` +
      '       adr-guard exec [--non-interactive|--yes-to-ask] -- <command...>',
  );
  process.exitCode = 1;
}

// Only run when executed directly (e.g. `node dist/cli/index.js` or via the
// `adr` bin), not when imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
