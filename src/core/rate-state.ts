import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Decision } from './types.js';

/**
 * Time-bucketed, append-only history for rate/frequency rules —
 * `.adr/rate-state/<bucketStartEpochSeconds>.jsonl`. Each process only
 * ever appends to the CURRENT bucket and deletes whole PAST bucket
 * files once they're entirely outside every configured rate window;
 * nothing ever reads-all/filters/rewrites a file another process might
 * still be appending to.
 *
 * This design replaces an earlier "single growing file, pruned via
 * read-all -> rewrite -> renameSync" approach that was empirically
 * verified (8 concurrent OS processes, 3 trials) to fail on Windows:
 * ~1/3 of renames failed outright with EPERM (destination held open by
 * another process), and independent of that, 0.4-1% of entries were
 * silently and permanently lost even when the rename succeeded, via a
 * platform-independent lost-update race (a concurrent append landing
 * between another process's read-snapshot and its rename). Bucketing
 * avoids both: appends never contend with a rewrite, and a stale
 * bucket is, by construction, one nothing is still appending to.
 */
export interface RateStateEntry {
  timestamp: string;
  decision: Decision;
  matchedRuleIds: string[];
}

const BUCKET_SECONDS = 60;
const RATE_STATE_DIRNAME = 'rate-state';

function rateStateDir(baseDir: string): string {
  return join(baseDir, '.adr', RATE_STATE_DIRNAME);
}

function bucketStart(epochSeconds: number): number {
  return Math.floor(epochSeconds / BUCKET_SECONDS) * BUCKET_SECONDS;
}

function bucketPath(baseDir: string, bucketStartEpochSeconds: number): string {
  return join(rateStateDir(baseDir), `${bucketStartEpochSeconds}.jsonl`);
}

/** Bucket start times of every `<epoch>.jsonl` file present, ignoring anything else in the directory. */
function listBucketStarts(dir: string): number[] {
  if (!existsSync(dir)) {
    return [];
  }
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => Number(f.slice(0, -'.jsonl'.length)))
      .filter((n) => Number.isInteger(n));
  } catch {
    // Directory listing itself failed (e.g. transient FS error) — treat as no history rather than fail the caller.
    return [];
  }
}

/**
 * Appends one event to the current time bucket, then best-effort
 * deletes bucket files that are entirely older than `maxWindowSeconds`
 * (i.e. no rate rule could still need them). Deletion failures (a race
 * with another process's own cleanup, a transient lock) are swallowed
 * — a lingering stale bucket costs a little disk space and gets
 * filtered out by timestamp on read anyway; it never affects
 * correctness.
 */
export function recordRateEvent(baseDir: string, entry: RateStateEntry, maxWindowSeconds: number): void {
  const dir = rateStateDir(baseDir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const path = bucketPath(baseDir, bucketStart(nowSeconds));
  appendFileSync(path, JSON.stringify(entry) + '\n');

  const staleCutoff = nowSeconds - maxWindowSeconds;
  for (const start of listBucketStarts(dir)) {
    if (start + BUCKET_SECONDS < staleCutoff) {
      try {
        unlinkSync(bucketPath(baseDir, start));
      } catch {
        // Best-effort cleanup only — see doc comment above.
      }
    }
  }
}

/**
 * Reads every entry timestamped within the last `windowSeconds`.
 * Degrades gracefully rather than throwing: an unreadable directory or
 * bucket file yields no entries from it, and an unparseable individual
 * line is skipped rather than failing the whole read. Rate rules are a
 * heuristic signal, not a hard security boundary (unlike
 * adr.config.yaml) — losing history to a corrupted cache file should
 * never block every tool call in the project.
 */
export function readRecentRateEvents(baseDir: string, windowSeconds: number): RateStateEntry[] {
  const dir = rateStateDir(baseDir);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cutoffMs = (nowSeconds - windowSeconds) * 1000;
  // A bucket can hold entries up to BUCKET_SECONDS newer than its own start time,
  // so include the bucket whose range could still overlap the window's start.
  const candidateCutoff = bucketStart(nowSeconds - windowSeconds - BUCKET_SECONDS);

  const entries: RateStateEntry[] = [];
  for (const start of listBucketStarts(dir)) {
    if (start < candidateCutoff) {
      continue;
    }
    let content: string;
    try {
      content = readFileSync(bucketPath(baseDir, start), 'utf-8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      if (line.trim().length === 0) {
        continue;
      }
      try {
        const entry = JSON.parse(line) as RateStateEntry;
        if (new Date(entry.timestamp).getTime() >= cutoffMs) {
          entries.push(entry);
        }
      } catch {
        // Skip a malformed line (partial write, corruption) rather than failing the whole read.
      }
    }
  }
  return entries;
}
