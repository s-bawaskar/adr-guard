#!/usr/bin/env node
/**
 * PreToolUse hook entry point for Claude Code.
 *
 * Reads the hook payload from stdin, logs it, normalizes it, runs it
 * through the core policy engine, and translates the resulting decision
 * back into Claude Code's expected JSON response shape. This file (plus
 * normalize.ts) is the only place in the repo that speaks Claude Code's
 * raw hook JSON — everything past normalize() only sees NormalizedAction.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decide, evaluate } from '../../core/policy-engine.js';
import type { Decision, RuleMatch } from '../../core/types.js';
import { normalize } from './normalize.js';
import type { ClaudeCodePreToolUsePayload } from './payload-types.js';

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

function resolveLogDir(payload: unknown): string {
  if (
    payload !== undefined &&
    payload !== null &&
    typeof payload === 'object' &&
    'cwd' in payload &&
    typeof (payload as { cwd: unknown }).cwd === 'string'
  ) {
    return join((payload as { cwd: string }).cwd, '.adr');
  }
  return join(process.cwd(), '.adr');
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

  const logDir = resolveLogDir(payload);
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }

  const logLine = JSON.stringify({
    receivedAt: new Date().toISOString(),
    rawParsed: payload ?? null,
    rawText: payload === undefined ? raw : undefined,
  });
  appendFileSync(join(logDir, 'raw-payloads.log'), logLine + '\n');

  if (!isPreToolUsePayload(payload)) {
    respond('allow', 'ADR: unparsable or unrecognized payload shape, defaulting to allow');
    return;
  }

  const action = normalize(payload);
  const matches = evaluate(action);
  const { decision } = decide(matches);

  respond(decision, reasonFrom(matches));
}

main();
