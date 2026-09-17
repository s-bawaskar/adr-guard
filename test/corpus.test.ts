import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { load as parseYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { decide, evaluate } from '../src/core/policy-engine.js';
import { loadCompiledRules } from '../src/core/rule-loader.js';
import type { Decision, NormalizedAction, NormalizedActionType } from '../src/core/types.js';

const RULES_DIR = fileURLToPath(new URL('../rules', import.meta.url));
const rules = loadCompiledRules(RULES_DIR);

interface CorpusActionSpec {
  type: NormalizedActionType;
  command?: string;
  filePath?: string;
  content?: string;
  url?: string;
}

interface LegitCorpusEntry {
  description: string;
  action: CorpusActionSpec;
}

interface MaliciousCorpusEntry extends LegitCorpusEntry {
  expectDecision: Decision;
}

function loadCorpus<T>(fileName: string): T[] {
  const path = fileURLToPath(new URL(`./fixtures/${fileName}`, import.meta.url));
  return parseYaml(readFileSync(path, 'utf-8')) as T[];
}

function toAction(spec: CorpusActionSpec): NormalizedAction {
  return { ...spec, raw: {}, source: 'test-corpus' };
}

function decisionFor(spec: CorpusActionSpec): Decision {
  const action = toAction(spec);
  return decide(action, evaluate(action, rules)).decision;
}

const legitCorpus = loadCorpus<LegitCorpusEntry>('legit-corpus.yaml');
const maliciousCorpus = loadCorpus<MaliciousCorpusEntry>('malicious-corpus.yaml');

describe('legit corpus: everyday actions must not be flagged', () => {
  it('loaded a non-trivial corpus', () => {
    expect(legitCorpus.length).toBeGreaterThanOrEqual(20);
  });

  for (const entry of legitCorpus) {
    it(`allows: ${entry.description}`, () => {
      expect(decisionFor(entry.action)).toBe('allow');
    });
  }

  it('has a 0% false-positive rate across the full corpus', () => {
    const falsePositives = legitCorpus.filter((entry) => decisionFor(entry.action) !== 'allow');
    const rate = falsePositives.length / legitCorpus.length;
    if (falsePositives.length > 0) {
      console.error(
        'False positives:',
        falsePositives.map((e) => e.description),
      );
    }
    expect(rate).toBe(0);
  });
});

describe('malicious corpus: dangerous actions must be flagged', () => {
  it('loaded a corpus covering every shipped rule', () => {
    expect(maliciousCorpus.length).toBeGreaterThanOrEqual(rules.length);
  });

  for (const entry of maliciousCorpus) {
    it(`${entry.expectDecision}s: ${entry.description}`, () => {
      expect(decisionFor(entry.action)).toBe(entry.expectDecision);
    });
  }

  it('has a 0% false-negative rate across the full corpus', () => {
    const falseNegatives = maliciousCorpus.filter((entry) => decisionFor(entry.action) === 'allow');
    const rate = falseNegatives.length / maliciousCorpus.length;
    if (falseNegatives.length > 0) {
      console.error(
        'False negatives:',
        falseNegatives.map((e) => e.description),
      );
    }
    expect(rate).toBe(0);
  });
});
