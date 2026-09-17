import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Decision, NormalizedAction, PolicyResult, RuleMatch, Severity } from './types.js';

export interface AuditLogEntry {
  timestamp: string;
  source: string;
  action: NormalizedAction;
  decision: Decision;
  severity?: Severity;
  matches: RuleMatch[];
}

/** Project-local audit log path, e.g. `<baseDir>/.adr/audit.log`. Callers resolve `baseDir` (an adapter knows its own cwd conventions); core just writes to it. */
export function auditLogPath(baseDir: string): string {
  return join(baseDir, '.adr', 'audit.log');
}

/** Appends one JSON-line record to the audit log. Tool-agnostic: takes only NormalizedAction/PolicyResult, never a raw adapter payload. */
export function appendAuditLogEntry(
  baseDir: string,
  action: NormalizedAction,
  result: PolicyResult,
): void {
  const entry: AuditLogEntry = {
    timestamp: new Date().toISOString(),
    source: action.source,
    action,
    decision: result.decision,
    severity: result.severity,
    matches: result.matches,
  };

  const filePath = auditLogPath(baseDir);
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  appendFileSync(filePath, JSON.stringify(entry) + '\n');
}
