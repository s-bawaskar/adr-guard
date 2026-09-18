import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readRecentRateEvents, recordRateEvent } from '../src/core/rate-state.js';
import type { RateStateEntry } from '../src/core/rate-state.js';

function entry(overrides: Partial<RateStateEntry> = {}): RateStateEntry {
  return {
    timestamp: new Date().toISOString(),
    decision: 'deny',
    matchedRuleIds: ['some-rule'],
    ...overrides,
  };
}

describe('rate-state: record + read round-trip', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'adr-rate-state-test-'));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('returns [] when no state exists yet', () => {
    expect(readRecentRateEvents(baseDir, 60)).toEqual([]);
  });

  it('records an event and reads it back within the window', () => {
    recordRateEvent(baseDir, entry({ decision: 'deny', matchedRuleIds: ['dangerous-rm'] }), 60);

    const events = readRecentRateEvents(baseDir, 60);
    expect(events).toHaveLength(1);
    expect(events[0].decision).toBe('deny');
    expect(events[0].matchedRuleIds).toEqual(['dangerous-rm']);
  });

  it('excludes events older than the requested window', () => {
    const old = entry({ timestamp: new Date(Date.now() - 3600_000).toISOString() });
    recordRateEvent(baseDir, old, 3700);

    expect(readRecentRateEvents(baseDir, 60)).toEqual([]);
    // still there for a wide-enough window
    expect(readRecentRateEvents(baseDir, 3700)).toHaveLength(1);
  });

  it('accumulates multiple events across separate calls (simulating separate process invocations)', () => {
    recordRateEvent(baseDir, entry({ matchedRuleIds: ['a'] }), 60);
    recordRateEvent(baseDir, entry({ matchedRuleIds: ['b'] }), 60);
    recordRateEvent(baseDir, entry({ matchedRuleIds: ['c'] }), 60);

    const events = readRecentRateEvents(baseDir, 60);
    expect(events).toHaveLength(3);
  });

  it('deletes bucket files older than maxWindowSeconds on record (bounded growth)', () => {
    const dir = join(baseDir, '.adr', 'rate-state');
    mkdirSync(dir, { recursive: true });
    // A bucket file far in the past — well outside any reasonable window.
    writeFileSync(join(dir, '0.jsonl'), JSON.stringify(entry({ timestamp: new Date(0).toISOString() })) + '\n');

    recordRateEvent(baseDir, entry(), 60);

    expect(existsSync(join(dir, '0.jsonl'))).toBe(false);
  });
});

describe('rate-state: degrades gracefully on corrupted/unreadable state (not a hard failure, unlike config)', () => {
  let baseDir: string;
  let stateDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'adr-rate-state-corrupt-test-'));
    stateDir = join(baseDir, '.adr', 'rate-state');
    mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('skips an unparseable line rather than failing the whole read', () => {
    const nowBucket = Math.floor(Date.now() / 1000 / 60) * 60;
    writeFileSync(
      join(stateDir, `${nowBucket}.jsonl`),
      'not valid json\n' + JSON.stringify(entry({ matchedRuleIds: ['good-line'] })) + '\n{"partial":\n',
    );

    const events = readRecentRateEvents(baseDir, 60);
    expect(events).toHaveLength(1);
    expect(events[0].matchedRuleIds).toEqual(['good-line']);
  });

  it('treats a bucket filename that is not a valid epoch as absent rather than throwing', () => {
    writeFileSync(join(stateDir, 'not-a-number.jsonl'), JSON.stringify(entry()) + '\n');

    expect(() => readRecentRateEvents(baseDir, 60)).not.toThrow();
    expect(readRecentRateEvents(baseDir, 60)).toEqual([]);
  });

  it('recordRateEvent does not throw even if an old bucket fails to delete (e.g. already removed)', () => {
    // Simulate a race: reference a bucket path that doesn't actually exist on disk.
    expect(() => recordRateEvent(baseDir, entry(), 60)).not.toThrow();
  });
});
