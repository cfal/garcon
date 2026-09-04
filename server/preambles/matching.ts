import path from 'node:path';
import type {
  Preamble,
  PreambleProjectPathRule,
} from '../../common/preambles.js';

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

export function preambleMatchesProjectPath(
  preamble: Preamble,
  canonicalProjectPath: string,
): boolean {
  return preamble.enabled && (
    preamble.scope.type === 'global'
    || preamble.scope.rules.some((rule) => preambleRuleMatches(rule, canonicalProjectPath))
  );
}
