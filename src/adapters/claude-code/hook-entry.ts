#!/usr/bin/env node
/**
 * PreToolUse hook entry point for Claude Code.
 *
 * Reads the hook payload from stdin, normalizes it, runs it through the
 * core policy engine, writes a structured audit log entry, and
 * translates the resulting decision back into Claude Code's expected
 * JSON response shape. This file (plus normalize.ts) is the only place
 * in the repo that speaks Claude Code's raw hook JSON — everything past
 * normalize() only sees NormalizedAction / PolicyResult.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendAuditLogEntry } from '../../core/audit-log.js';
import { decide, evaluate } from '../../core/policy-engine.js';
import { loadCompiledRules } from '../../core/rule-loader.js';
import type { Decision, RuleMatch } from '../../core/types.js';
import { normalize } from './normalize.js';
import type { ClaudeCodePreToolUsePayload } from './payload-types.js';

// dist/adapters/claude-code/hook-entry.js -> package root -> rules/
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RULES = loadCompiledRules(join(PACKAGE_ROOT, 'rules'));

function readStdin(): string {
  try {
    return readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function resolveBaseDir(payload: unknown): string {
  if (
    payload !== null &&
    typeof payload === 'object' &&
    'cwd' in payload &&
    typeof (payload as { cwd: unknown }).cwd === 'string'
  ) {
    return (payload as { cwd: string }).cwd;
  }
  return process.cwd();
}

function isPreToolUsePayload(payload: unknown): payload is ClaudeCodePreToolUsePayload {
  return (
    payload !== null &&
    typeof payload === 'object' &&
    'tool_name' in payload &&
    typeof (payload as { tool_name: unknown }).tool_name === 'string' &&
    'tool_input' in payload
  );
}

function reasonFrom(matches: RuleMatch[]): string {
  const triggered = matches.filter((m) => m.matched);
  if (triggered.length === 0) {
    return 'No policy rules matched';
  }
  return triggered.map((m) => `[${m.severity}] ${m.ruleId}: ${m.reason}`).join('; ');
}

function respond(decision: Decision, reason: string): void {
  const response = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
  process.stdout.write(JSON.stringify(response));
  process.exit(0);
}

function main(): void {
  const raw = readStdin();
  const payload = safeParseJson(raw);

  if (!isPreToolUsePayload(payload)) {
    respond('allow', 'ADR: unparsable or unrecognized payload shape, defaulting to allow');
    return;
  }

  const action = normalize(payload);
  const matches = evaluate(action, RULES);
  const result = decide(matches);

  appendAuditLogEntry(resolveBaseDir(payload), action, result);

  respond(result.decision, reasonFrom(matches));
}

main();
