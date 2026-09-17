import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { appendAuditLogEntry } from '../../core/audit-log.js';
import { decide, evaluate } from '../../core/policy-engine.js';
import { loadCompiledRules } from '../../core/rule-loader.js';
import type { Decision, RuleMatch } from '../../core/types.js';
import { normalize } from './normalize.js';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DEFAULT_RULES_DIR = join(PACKAGE_ROOT, 'rules');

export interface ShellExecutionOptions {
  baseDir?: string;
  rulesDir?: string;
  nonInteractive?: boolean;
  yesToAsk?: boolean;
  env?: NodeJS.ProcessEnv;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  execute?: (command: string) => number;
  prompt?: () => Promise<boolean>;
  writeError?: (message: string) => void;
}

function reasonFrom(matches: RuleMatch[], riskScore: number): string {
  const triggered = matches.filter((match) => match.matched);
  if (triggered.length === 0) {
    return 'No policy rules matched (risk score: 0)';
  }
  const details = triggered
    .map((match) => `[${match.severity}] ${match.ruleId}: ${match.reason}`)
    .join('; ');
  return `${details} (risk score: ${riskScore})`;
}

function defaultExecute(command: string): number {
  const result = spawnSync(command, { shell: true, stdio: 'inherit' });
  if (result.error) {
    process.stderr.write(`ADR: failed to execute command: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

async function defaultPrompt(): Promise<boolean> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question('ADR asks for confirmation. Execute? [y/N] ');
    return answer.trim().toLowerCase() === 'y';
  } finally {
    readline.close();
  }
}

function deny(writeError: (message: string) => void, reason: string): number {
  writeError(`ADR denied command: ${reason}`);
  return 1;
}

export async function runShellCommand(
  command: string,
  options: ShellExecutionOptions = {},
): Promise<number> {
  const baseDir = options.baseDir ?? process.cwd();
  const rulesDir = options.rulesDir ?? (existsSync(join(baseDir, 'rules')) ? join(baseDir, 'rules') : DEFAULT_RULES_DIR);
  const action = normalize(command);
  const matches = evaluate(action, loadCompiledRules(rulesDir));
  const result = decide(action, matches);
  const reason = reasonFrom(matches, result.score);

  appendAuditLogEntry(baseDir, action, result);

  const writeError = options.writeError ?? ((message: string) => process.stderr.write(`${message}\n`));
  const execute = options.execute ?? defaultExecute;

  if (result.decision === 'allow') {
    return execute(command);
  }

  if (result.decision === 'deny') {
    return deny(writeError, reason);
  }

  const envAllows = (options.env ?? process.env).ADR_ASK_MODE === 'allow';
  const canPrompt =
    !options.nonInteractive &&
    !options.yesToAsk &&
    (options.stdinIsTTY ?? Boolean(process.stdin.isTTY)) &&
    (options.stdoutIsTTY ?? Boolean(process.stdout.isTTY));

  if (options.yesToAsk || envAllows || (canPrompt && await (options.prompt ?? defaultPrompt)())) {
    return execute(command);
  }

  return deny(writeError, `${reason}; ask treated as deny in non-interactive mode`);
}

export function decisionReason(decision: Decision, matches: RuleMatch[], score: number): string {
  return `${decision}: ${reasonFrom(matches, score)}`;
}