/**
 * Tool-agnostic action shape. This is the ONLY thing src/core/ ever
 * consumes or produces — it must never import or reference a specific
 * coding tool's raw payload format. See docs/architecture.md.
 */
export type NormalizedActionType = 'shell' | 'file_write' | 'file_read' | 'network' | 'other';

export interface NormalizedAction {
  type: NormalizedActionType;
  /** The original adapter-specific payload, kept opaque for audit logging. */
  raw: unknown;
  command?: string;
  filePath?: string;
  content?: string;
  url?: string;
  /** e.g. "claude-code" — the only place an adapter's identity appears in core. */
  source: string;
}

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export interface RuleMatch {
  ruleId: string;
  matched: boolean;
  severity: Severity;
  reason: string;
}

export type Decision = 'allow' | 'ask' | 'deny';

export interface PolicyResult {
  decision: Decision;
  matches: RuleMatch[];
}
