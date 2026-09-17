import type { Decision, NormalizedAction, PolicyResult, RuleMatch, Severity } from './types.js';

interface Rule {
  id: string;
  severity: Severity;
  reason: string;
  applies: (action: NormalizedAction) => boolean;
  test: (action: NormalizedAction) => boolean;
}

const DANGEROUS_RM_PATTERN =
  /\brm\s+(?:-[\w-]+\s+)*-(?:[\w-]*r[\w-]*f[\w-]*|[\w-]*f[\w-]*r[\w-]*)(?:\s+-[\w-]+)*\s+(?:"|')?(\/|~\/?|\*|\.\.?\/?|\$HOME)(?:"|')?(?=\s|$)/i;

const CURL_PIPE_SHELL_PATTERN = /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i;

const CREDENTIAL_PATH_PATTERN =
  /(\.ssh\/|(^|\/)\.env(\.|$)|id_rsa|id_ed25519|(^|\/)credentials(\.json)?$|\.aws\/credentials|\.npmrc$|\.pem$)/i;

const EVAL_EXEC_PATTERN = /\b(eval|exec)\s*\(/;

const DEFAULT_HOST_ALLOWLIST = new Set([
  'github.com',
  'raw.githubusercontent.com',
  'api.anthropic.com',
  'registry.npmjs.org',
  'pypi.org',
]);

function isAllowlistedHost(url: string): boolean {
  try {
    return DEFAULT_HOST_ALLOWLIST.has(new URL(url).hostname);
  } catch {
    // Unparsable URL is treated as not-allowlisted, not as a free pass.
    return false;
  }
}

const rules: Rule[] = [
  {
    id: 'dangerous-rm',
    severity: 'critical',
    reason: 'Recursive force-delete targeting a broad path (/, ~, *, .., $HOME)',
    applies: (a) => a.type === 'shell' && !!a.command,
    test: (a) => DANGEROUS_RM_PATTERN.test(a.command ?? ''),
  },
  {
    id: 'curl-pipe-shell',
    severity: 'high',
    reason: 'Downloads a remote script and pipes it directly into a shell interpreter',
    applies: (a) => a.type === 'shell' && !!a.command,
    test: (a) => CURL_PIPE_SHELL_PATTERN.test(a.command ?? ''),
  },
  {
    id: 'credential-file-write',
    severity: 'high',
    reason: 'Writes to a path that commonly holds credentials or private keys',
    applies: (a) => a.type === 'file_write' && !!a.filePath,
    test: (a) => CREDENTIAL_PATH_PATTERN.test(a.filePath ?? ''),
  },
  {
    id: 'eval-exec-usage',
    severity: 'medium',
    reason: 'Uses eval(/exec( which can run dynamically constructed code',
    applies: (a) => a.type === 'shell' || a.type === 'file_write',
    test: (a) => EVAL_EXEC_PATTERN.test(a.command ?? a.content ?? ''),
  },
  {
    id: 'unallowlisted-network-host',
    severity: 'medium',
    reason: 'Outbound request to a host not on the default allowlist',
    applies: (a) => a.type === 'network' && !!a.url,
    test: (a) => !isAllowlistedHost(a.url ?? ''),
  },
];

/** Evaluates every applicable rule against the action. Non-applicable rules are skipped entirely (not returned as non-matches). */
export function evaluate(action: NormalizedAction): RuleMatch[] {
  return rules
    .filter((rule) => rule.applies(action))
    .map((rule) => ({
      ruleId: rule.id,
      matched: rule.test(action),
      severity: rule.severity,
      reason: rule.reason,
    }));
}

const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

const SEVERITY_TO_DECISION: Record<Severity, Decision> = {
  low: 'allow',
  medium: 'ask',
  high: 'ask',
  critical: 'deny',
};

/** Reduces matched rules to a single decision, driven by the highest-severity match. */
export function decide(matches: RuleMatch[]): PolicyResult {
  const triggered = matches.filter((m) => m.matched);
  if (triggered.length === 0) {
    return { decision: 'allow', matches };
  }

  const worst = triggered.reduce((acc, m) =>
    SEVERITY_RANK[m.severity] > SEVERITY_RANK[acc.severity] ? m : acc,
  );

  return { decision: SEVERITY_TO_DECISION[worst.severity], severity: worst.severity, matches };
}
