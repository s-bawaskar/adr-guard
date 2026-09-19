/**
 * `adr-guard log` — human-readable view of `.adr/audit.log`, with
 * optional `--tail`/`-f` follow mode and `--filter <decision>`.
 * Read-only: never touches src/core/ or either adapter, just reads the
 * JSON-lines file core/audit-log.ts already writes.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import * as nodeUtil from 'node:util';
import type { AuditLogEntry } from '../core/audit-log.js';
import type { Decision, NormalizedAction } from '../core/types.js';

export const DEFAULT_LIMIT = 20;
const DEFAULT_POLL_INTERVAL_MS = 400;

type StyleFormat = Parameters<typeof nodeUtil.styleText>[0];

// Namespace import + runtime check, not a named import: styleText was added
// in Node 20.12.0, and this project's engines floor is ">=20" — a named
// `import { styleText }` would throw at module-load time on an older 20.x
// patch that doesn't export it at all. A missing property on a namespace
// object is just undefined, so this degrades to plain text instead.
const styleTextFn: typeof nodeUtil.styleText | undefined =
  typeof nodeUtil.styleText === 'function' ? nodeUtil.styleText : undefined;

function color(format: StyleFormat, text: string): string {
  return styleTextFn ? styleTextFn(format, text) : text;
}

const DECISION_COLOR: Record<Decision, StyleFormat> = {
  allow: ['green', 'dim'],
  ask: 'yellow',
  deny: 'red',
};

function truncate(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A short, one-line human description of what the action actually did. */
export function describeAction(action: NormalizedAction): string {
  switch (action.type) {
    case 'shell':
      return truncate(action.command ?? '(no command)');
    case 'file_write':
      return `write ${action.filePath ?? '(no path)'}`;
    case 'file_read':
      return `read ${action.filePath ?? '(no path)'}`;
    case 'network':
      return `fetch ${action.url ?? '(no url)'}`;
    case 'other':
      return '(other action)';
  }
}

/** One formatted, color-coded line for a single audit log entry. */
export function formatEntry(entry: AuditLogEntry): string {
  const ruleIds = entry.matches.filter((m) => m.matched).map((m) => m.ruleId);
  const rulesText = ruleIds.length > 0 ? ruleIds.join(', ') : '(no rules matched)';
  const decisionText = color(DECISION_COLOR[entry.decision], entry.decision.toUpperCase());

  return `${entry.timestamp}  [${entry.source}]  ${decisionText}  ${rulesText}  ${describeAction(entry.action)}`;
}

function parseLines(content: string): AuditLogEntry[] {
  const entries: AuditLogEntry[] = [];
  for (const line of content.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      entries.push(JSON.parse(line) as AuditLogEntry);
    } catch {
      // Skip a malformed line (partial write, manual edit) rather than
      // failing the whole read — this is a display tool, not a source of
      // truth, so it should degrade gracefully like rate-state.ts does.
    }
  }
  return entries;
}

/** Reads and parses the whole file (fine at CLI scale — a manual, infrequent invocation, not the per-action hot path), returning the last `limit` entries. */
export function readRecentEntries(logPath: string, limit: number): AuditLogEntry[] {
  if (!existsSync(logPath)) {
    return [];
  }
  const entries = parseLines(readFileSync(logPath, 'utf-8'));
  return entries.slice(-limit);
}

export interface LogCommandOptions {
  logPath: string;
  tail: boolean;
  filter?: Decision;
  limit?: number;
  pollIntervalMs?: number;
  /** Overridable for tests; defaults to console.log. */
  write?: (line: string) => void;
  /** Stops tail-mode polling when aborted; production never provides one (Ctrl+C exits the process instead). */
  signal?: AbortSignal;
}

/**
 * Prints the most recent entries, then (if `tail`) polls for and prints new
 * ones as they're appended — like `tail -f`. Polling (not fs.watch) by
 * design: simpler and more predictable across this project's Windows+Linux
 * CI matrix than event-driven watching, at the cost of up to
 * `pollIntervalMs` of latency, which is fine for a human watching a
 * terminal. Each poll tick only reads the bytes appended since the last
 * tick (via openSync/readSync at a byte offset), not the whole file again.
 */
export async function runLogCommand(options: LogCommandOptions): Promise<void> {
  const { logPath, tail, filter } = options;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const write = options.write ?? ((line: string) => console.log(line));

  const printEntry = (entry: AuditLogEntry): void => {
    if (filter && entry.decision !== filter) {
      return;
    }
    write(formatEntry(entry));
  };

  if (!existsSync(logPath) && !tail) {
    write(`No audit log yet at ${logPath} — nothing has been evaluated in this project yet.`);
    return;
  }

  for (const entry of readRecentEntries(logPath, limit)) {
    printEntry(entry);
  }

  if (!tail) {
    return;
  }

  if (!existsSync(logPath)) {
    write(`Waiting for ${logPath} to be created...`);
  }

  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let lastSize = existsSync(logPath) ? statSync(logPath).size : 0;
  let carry = '';

  await new Promise<void>((resolvePromise) => {
    const timer = setInterval(() => {
      if (!existsSync(logPath)) {
        return;
      }
      const size = statSync(logPath).size;
      if (size < lastSize) {
        // Truncated/rotated/recreated smaller — start over from the new file's beginning.
        lastSize = 0;
        carry = '';
      }
      if (size === lastSize) {
        return;
      }

      const length = size - lastSize;
      const buffer = Buffer.alloc(length);
      const fd = openSync(logPath, 'r');
      try {
        readSync(fd, buffer, 0, length, lastSize);
      } finally {
        closeSync(fd);
      }
      lastSize = size;

      const chunk = carry + buffer.toString('utf-8');
      const lines = chunk.split('\n');
      carry = lines.pop() ?? ''; // last element may be a not-yet-newline-terminated partial line
      for (const line of lines) {
        if (line.trim().length === 0) {
          continue;
        }
        try {
          printEntry(JSON.parse(line) as AuditLogEntry);
        } catch {
          // Skip a malformed line — see parseLines' doc comment for why.
        }
      }
    }, pollIntervalMs);

    options.signal?.addEventListener('abort', () => {
      clearInterval(timer);
      resolvePromise();
    });
  });
}
