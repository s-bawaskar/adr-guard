import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { ASK_THRESHOLD, DENY_THRESHOLD } from './scoring.js';
import type { ScoreThresholds } from './scoring.js';

export type AdrConfig = ScoreThresholds;

const CONFIG_FILENAME = 'adr.config.yaml';

/** The config ADR runs with when a project has no adr.config.yaml — must stay in lockstep with scoring.ts's hardcoded defaults. */
export const DEFAULT_CONFIG: AdrConfig = {
  askThreshold: ASK_THRESHOLD,
  denyThreshold: DENY_THRESHOLD,
};

export class ConfigValidationError extends Error {
  constructor(sourceFile: string, reason: string) {
    super(`Invalid config in ${sourceFile}: ${reason}`);
    this.name = 'ConfigValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assert(condition: boolean, sourceFile: string, reason: string): asserts condition {
  if (!condition) {
    throw new ConfigValidationError(sourceFile, reason);
  }
}

/** Validates a parsed adr.config.yaml body. Unknown fields are ignored (forward-compat), matching rule-file convention. */
export function parseAdrConfig(raw: unknown, sourceFile: string): AdrConfig {
  assert(isRecord(raw), sourceFile, 'config must be a YAML mapping');

  assert(
    typeof raw.askThreshold === 'number' && !Number.isNaN(raw.askThreshold),
    sourceFile,
    `"askThreshold" must be a number (got ${JSON.stringify(raw.askThreshold)})`,
  );
  assert(
    typeof raw.denyThreshold === 'number' && !Number.isNaN(raw.denyThreshold),
    sourceFile,
    `"denyThreshold" must be a number (got ${JSON.stringify(raw.denyThreshold)})`,
  );
  assert(
    raw.denyThreshold > raw.askThreshold,
    sourceFile,
    `"denyThreshold" (${raw.denyThreshold}) must be greater than "askThreshold" (${raw.askThreshold})`,
  );

  return { askThreshold: raw.askThreshold, denyThreshold: raw.denyThreshold };
}

/**
 * Loads `<baseDir>/adr.config.yaml`. Returns DEFAULT_CONFIG (the exact
 * hardcoded scoring.ts defaults) when the file doesn't exist — every
 * existing project with no config file is unaffected. Throws
 * ConfigValidationError on a malformed file rather than silently falling
 * back, so a broken config is never mistaken for "no config".
 */
export function loadAdrConfig(baseDir: string): AdrConfig {
  const path = join(baseDir, CONFIG_FILENAME);
  if (!existsSync(path)) {
    return DEFAULT_CONFIG;
  }
  const raw = parseYaml(readFileSync(path, 'utf-8'));
  return parseAdrConfig(raw, path);
}
