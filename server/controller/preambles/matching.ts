import { isWithinExecutorPath } from '../../../common/executor-path.js';
import { effectiveExecutorId } from '../../../common/executors.js';
import type {
  Preamble,
  PreambleProjectPathRule,
} from '../../../common/preambles.js';
import type { AgentId } from '../../../common/agents.js';

export interface NewChatPreambleContext {
  readonly executorId?: string | null;
  readonly canonicalProjectPath: string;
  readonly agentId: AgentId;
  readonly tags: readonly string[];
}

export function preambleRuleMatches(
  rule: PreambleProjectPathRule,
  canonicalProjectPath: string,
  executorId?: string | null,
): boolean {
  if (effectiveExecutorId(rule.executorId) !== effectiveExecutorId(executorId)) return false;
  return canonicalProjectPath === rule.projectPath
    || (rule.includeNested && isWithinExecutorPath(rule.projectPath, canonicalProjectPath));
}

export function applicablePreambles(
  preambles: readonly Preamble[],
  canonicalProjectPath: string,
  executorId?: string | null,
): Preamble[] {
  return preambles
    .filter((preamble) => preambleMatchesProjectPath(preamble, canonicalProjectPath, executorId))
    .map((preamble) => structuredClone(preamble));
}

export function preambleScopeMatches(
  preamble: Preamble,
  canonicalProjectPath: string,
  executorId?: string | null,
): boolean {
  return preamble.scope.type === 'global'
    || preamble.scope.rules.some((rule) => preambleRuleMatches(rule, canonicalProjectPath, executorId));
}

export function preambleMatchesProjectPath(
  preamble: Preamble,
  canonicalProjectPath: string,
  executorId?: string | null,
): boolean {
  return preamble.enabled && preambleScopeMatches(preamble, canonicalProjectPath, executorId);
}

export function preambleMatchesNewChatDefaults(
  preamble: Preamble,
  context: NewChatPreambleContext,
): boolean {
  if (!preambleMatchesProjectPath(preamble, context.canonicalProjectPath, context.executorId)) return false;
  if (preamble.agentIds.length > 0 && !preamble.agentIds.includes(context.agentId)) return false;
  if (preamble.tagFilter.tags.length === 0) return true;

  const chatTags = new Set(context.tags);
  if (preamble.tagFilter.mode === 'all') {
    return preamble.tagFilter.tags.every((tag) => chatTags.has(tag));
  }
  return preamble.tagFilter.tags.some((tag) => chatTags.has(tag));
}
