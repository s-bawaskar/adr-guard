import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, loadAdrConfig, parseAdrConfig } from '../src/core/config.js';
import { ASK_THRESHOLD, DENY_THRESHOLD } from '../src/core/scoring.js';

describe('config: parseAdrConfig validation', () => {
  it('accepts a well-formed config', () => {
    const config = parseAdrConfig({ askThreshold: 5, denyThreshold: 15 }, 'test.yaml');
    expect(config).toEqual({ askThreshold: 5, denyThreshold: 15 });
  });

  it('ignores unknown fields (forward-compat)', () => {
    const config = parseAdrConfig(
      { askThreshold: 5, denyThreshold: 15, someFutureField: true },
      'test.yaml',
    );
    expect(config).toEqual({ askThreshold: 5, denyThreshold: 15 });
  });

  it('rejects a non-object body', () => {
    expect(() => parseAdrConfig('not an object', 'bad.yaml')).toThrow(/must be a YAML mapping/);
  });

  it('rejects a non-numeric askThreshold', () => {
    expect(() =>
      parseAdrConfig({ askThreshold: 'high', denyThreshold: 15 }, 'bad.yaml'),
    ).toThrow(/"askThreshold"/);
  });

  it('rejects a non-numeric denyThreshold', () => {
    expect(() =>
      parseAdrConfig({ askThreshold: 5, denyThreshold: 'lots' }, 'bad.yaml'),
    ).toThrow(/"denyThreshold"/);
  });

  it('rejects a missing askThreshold', () => {
    expect(() => parseAdrConfig({ denyThreshold: 15 }, 'bad.yaml')).toThrow(/"askThreshold"/);
  });

  it('rejects denyThreshold <= askThreshold', () => {
    expect(() =>
      parseAdrConfig({ askThreshold: 10, denyThreshold: 10 }, 'bad.yaml'),
    ).toThrow(/must be greater than/);
    expect(() =>
      parseAdrConfig({ askThreshold: 10, denyThreshold: 5 }, 'bad.yaml'),
    ).toThrow(/must be greater than/);
  });

  it('error message names the source file', () => {
    expect(() => parseAdrConfig('bad', '/path/to/adr.config.yaml')).toThrow(
      /\/path\/to\/adr\.config\.yaml/,
    );
  });
});

describe('config: loadAdrConfig from disk', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adr-config-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to the exact hardcoded defaults when no config file exists', () => {
    expect(loadAdrConfig(dir)).toEqual({
      askThreshold: ASK_THRESHOLD,
      denyThreshold: DENY_THRESHOLD,
    });
    expect(loadAdrConfig(dir)).toEqual(DEFAULT_CONFIG);
  });

  it('loads and applies a valid adr.config.yaml', () => {
    writeFileSync(join(dir, 'adr.config.yaml'), 'askThreshold: 5\ndenyThreshold: 20\n');
    expect(loadAdrConfig(dir)).toEqual({ askThreshold: 5, denyThreshold: 20 });
  });

  it('throws a clear error for an invalid adr.config.yaml instead of silently falling back', () => {
    writeFileSync(join(dir, 'adr.config.yaml'), 'askThreshold: 20\ndenyThreshold: 5\n');
    expect(() => loadAdrConfig(dir)).toThrow(/must be greater than/);
  });
});
