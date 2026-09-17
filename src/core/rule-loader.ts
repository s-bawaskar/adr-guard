import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import type { CompiledRule } from './policy-engine.js';
import type { NormalizedAction, NormalizedActionType, Severity } from './types.js';

/** Fields on NormalizedAction a rule's `match` can be tested against. */
export type MatchField = 'command' | 'content' | 'filePath' | 'url';

const VALID_FIELDS: MatchField[] = ['command', 'content', 'filePath', 'url'];
const VALID_SEVERITIES: Severity[] = ['low', 'medium', 'high', 'critical'];
const VALID_APPLIES_TO: Array<NormalizedActionType | 'any'> = [
  'shell',
  'file_write',
  'file_read',
  'network',
  'other',
  'any',
];

export interface RegexMatch {
  kind: 'regex';
  pattern: string;
  flags?: string;
}

export interface PathPrefixMatch {
  kind: 'path_prefix';
  prefixes: string[];
}

export interface DomainAllowlistMatch {
  kind: 'domain_allowlist';
  domains: string[];
}

export interface DomainDenylistMatch {
  kind: 'domain_denylist';
  domains: string[];
}

export type MatchSpec = RegexMatch | PathPrefixMatch | DomainAllowlistMatch | DomainDenylistMatch;

export interface RuleDefinition {
  id: string;
  appliesTo: NormalizedActionType | 'any';
  /** Which NormalizedAction field(s) to test. Matches if ANY listed field satisfies the rule. Defaults per match kind if omitted (path_prefix -> filePath, domain_* -> url). */
  field?: MatchField | MatchField[];
  match: MatchSpec;
  severity: Severity;
  message: string;
}

class RuleValidationError extends Error {
  constructor(sourceFile: string, reason: string) {
    super(`Invalid rule in ${sourceFile}: ${reason}`);
    this.name = 'RuleValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function assert(condition: boolean, sourceFile: string, reason: string): asserts condition {
  if (!condition) {
    throw new RuleValidationError(sourceFile, reason);
  }
}

function validateMatchSpec(raw: unknown, sourceFile: string): MatchSpec {
  assert(isRecord(raw), sourceFile, '"match" must be an object');
  const kind = raw.kind;

  switch (kind) {
    case 'regex':
      assert(typeof raw.pattern === 'string', sourceFile, 'match.pattern must be a string');
      assert(
        raw.flags === undefined || typeof raw.flags === 'string',
        sourceFile,
        'match.flags must be a string if present',
      );
      return { kind: 'regex', pattern: raw.pattern, flags: raw.flags as string | undefined };

    case 'path_prefix':
      assert(isStringArray(raw.prefixes), sourceFile, 'match.prefixes must be an array of strings');
      return { kind: 'path_prefix', prefixes: raw.prefixes };

    case 'domain_allowlist':
      assert(isStringArray(raw.domains), sourceFile, 'match.domains must be an array of strings');
      return { kind: 'domain_allowlist', domains: raw.domains };

    case 'domain_denylist':
      assert(isStringArray(raw.domains), sourceFile, 'match.domains must be an array of strings');
      return { kind: 'domain_denylist', domains: raw.domains };

    default:
      throw new RuleValidationError(
        sourceFile,
        `match.kind must be one of regex, path_prefix, domain_allowlist, domain_denylist (got ${JSON.stringify(kind)})`,
      );
  }
}

function validateField(raw: unknown, sourceFile: string): MatchField | MatchField[] | undefined {
  if (raw === undefined) return undefined;
  const values = Array.isArray(raw) ? raw : [raw];
  for (const v of values) {
    assert(
      typeof v === 'string' && (VALID_FIELDS as string[]).includes(v),
      sourceFile,
      `field must be one of ${VALID_FIELDS.join(', ')} (got ${JSON.stringify(v)})`,
    );
  }
  return raw as MatchField | MatchField[];
}

export function parseRuleDefinition(raw: unknown, sourceFile: string): RuleDefinition {
  assert(isRecord(raw), sourceFile, 'rule must be a YAML mapping');
  assert(
    typeof raw.id === 'string' && raw.id.length > 0,
    sourceFile,
    '"id" must be a non-empty string',
  );
  assert(
    typeof raw.appliesTo === 'string' && (VALID_APPLIES_TO as string[]).includes(raw.appliesTo),
    sourceFile,
    `"appliesTo" must be one of ${VALID_APPLIES_TO.join(', ')}`,
  );
  assert(
    typeof raw.severity === 'string' && (VALID_SEVERITIES as string[]).includes(raw.severity),
    sourceFile,
    `"severity" must be one of ${VALID_SEVERITIES.join(', ')}`,
  );
  assert(
    typeof raw.message === 'string' && raw.message.length > 0,
    sourceFile,
    '"message" must be a non-empty string',
  );

  const field = validateField(raw.field, sourceFile);
  const match = validateMatchSpec(raw.match, sourceFile);

  return {
    id: raw.id,
    appliesTo: raw.appliesTo as NormalizedActionType | 'any',
    field,
    match,
    severity: raw.severity as Severity,
    message: raw.message,
  };
}

/** Reads and validates every .yaml/.yml file in `rulesDir`. Returns [] if the directory doesn't exist. */
export function loadRuleDefinitions(rulesDir: string): RuleDefinition[] {
  if (!existsSync(rulesDir)) {
    return [];
  }
  const files = readdirSync(rulesDir)
    .filter((f) => extname(f) === '.yaml' || extname(f) === '.yml')
    .sort();

  return files.map((file) => {
    const fullPath = join(rulesDir, file);
    const raw = parseYaml(readFileSync(fullPath, 'utf-8'));
    return parseRuleDefinition(raw, file);
  });
}

function getFieldValues(
  action: NormalizedAction,
  field: MatchField | MatchField[] | undefined,
): string[] {
  const fields = field === undefined ? [] : Array.isArray(field) ? field : [field];
  return fields.map((f) => action[f]).filter((v): v is string => typeof v === 'string');
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/** Turns a validated RuleDefinition into the applies()/test() predicates the policy engine runs. */
export function compileRule(def: RuleDefinition): CompiledRule {
  const applies = (action: NormalizedAction): boolean =>
    def.appliesTo === 'any' || action.type === def.appliesTo;

  let test: (action: NormalizedAction) => boolean;

  switch (def.match.kind) {
    case 'regex': {
      const regex = new RegExp(def.match.pattern, def.match.flags ?? 'i');
      test = (action) => getFieldValues(action, def.field).some((v) => regex.test(v));
      break;
    }
    case 'path_prefix': {
      const { prefixes } = def.match;
      test = (action) =>
        getFieldValues(action, def.field ?? 'filePath').some((v) =>
          prefixes.some((p) => v.startsWith(p)),
        );
      break;
    }
    case 'domain_allowlist': {
      const allow = new Set(def.match.domains);
      test = (action) =>
        getFieldValues(action, def.field ?? 'url').some((v) => {
          const host = hostOf(v);
          return host === undefined || !allow.has(host);
        });
      break;
    }
    case 'domain_denylist': {
      const deny = new Set(def.match.domains);
      test = (action) =>
        getFieldValues(action, def.field ?? 'url').some((v) => {
          const host = hostOf(v);
          return host !== undefined && deny.has(host);
        });
      break;
    }
  }

  return { id: def.id, severity: def.severity, reason: def.message, applies, test };
}

/** Loads every rule file in `rulesDir` and compiles it, ready to pass to policy-engine's evaluate(). */
export function loadCompiledRules(rulesDir: string): CompiledRule[] {
  return loadRuleDefinitions(rulesDir).map(compileRule);
}
