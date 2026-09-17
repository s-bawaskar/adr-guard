#!/usr/bin/env node
/**
 * PreToolUse hook entry point for Claude Code.
 *
 * Phase 1: proof of interception only. No policy logic — reads the hook
 * payload from stdin, logs it, and unconditionally allows the tool call.
 * This file is the ONLY place in the repo that speaks Claude Code's raw
 * hook JSON at this phase; normalization into core's tool-agnostic shape
 * lands in Phase 2 (normalize.ts).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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

  const response = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'ADR Phase 1 stub: logging only, no policy evaluation yet',
    },
  };

  process.stdout.write(JSON.stringify(response));
  process.exit(0);
}

main();
