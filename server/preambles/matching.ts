import path from 'node:path';
import type {
  Preamble,
  PreambleProjectPathRule,
} from '../../common/preambles.js';
import type { AgentId } from '../../common/agents.js';

export interface NewChatPreambleContext {
  readonly canonicalProjectPath: string;
  readonly agentId: AgentId;
  readonly tags: readonly string[];
}

export function preambleRuleMatches(
  rule: PreambleProjectPathRule,
  canonicalProjectPath: string,
): boolean {
  const relative = path.relative(rule.projectPath, canonicalProjectPath);
  if (relative === '') return true;
  return rule.includeNested
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

export function applicablePreambles(
  preambles: readonly Preamble[],
  canonicalProjectPath: string,
): Preamble[] {
  return preambles
    .filter((preamble) => preambleMatchesProjectPath(preamble, canonicalProjectPath))
    .map((preamble) => structuredClone(preamble));
}

export function preambleScopeMatches(
  preamble: Preamble,
  canonicalProjectPath: string,
): boolean {
  return preamble.scope.type === 'global'
    || preamble.scope.rules.some((rule) => preambleRuleMatches(rule, canonicalProjectPath));
}

export function preambleMatchesProjectPath(
  preamble: Preamble,
  canonicalProjectPath: string,
): boolean {
  return preamble.enabled && preambleScopeMatches(preamble, canonicalProjectPath);
}

export function preambleMatchesNewChatDefaults(
  preamble: Preamble,
  context: NewChatPreambleContext,
): boolean {
  if (!preambleMatchesProjectPath(preamble, context.canonicalProjectPath)) return false;
  if (preamble.agentIds.length > 0 && !preamble.agentIds.includes(context.agentId)) return false;
  if (preamble.tagFilter.tags.length === 0) return true;

  const chatTags = new Set(context.tags);
  if (preamble.tagFilter.mode === 'all') {
    return preamble.tagFilter.tags.every((tag) => chatTags.has(tag));
  }
  return preamble.tagFilter.tags.some((tag) => chatTags.has(tag));
}
