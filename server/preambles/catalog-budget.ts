import { renderPreamblePrefix } from '../../common/preamble-prefix.js';
import {
  PREAMBLE_COMBINED_MAX_LENGTH,
  type Preamble,
} from '../../common/preambles.js';
import { applicablePreambles } from './matching.js';

export interface PreambleCombinedBudgetViolation {
  readonly projectPath: string | null;
  readonly codeUnitLength: number;
}

export function preambleCombinedBudgetViolation(
  preambles: readonly Preamble[],
): PreambleCombinedBudgetViolation | null {
  const projectPaths = new Set<string>();
  for (const preamble of preambles) {
    if (!preamble.enabled) continue;
    if (preamble.scope.type !== 'project-paths') continue;
    for (const rule of preamble.scope.rules) projectPaths.add(rule.projectPath);
  }
  const candidates = [
    {
      projectPath: null,
      entries: preambles.filter((preamble) => preamble.enabled && preamble.scope.type === 'global'),
    },
    ...[...projectPaths].map((projectPath) => ({
      projectPath,
      entries: applicablePreambles(preambles, projectPath),
    })),
  ];
  for (const candidate of candidates) {
    if (candidate.entries.length === 0) continue;
    const length = renderPreamblePrefix(
      '0'.repeat(64),
      candidate.entries.map((entry) => entry.content),
    ).length;
    if (length > PREAMBLE_COMBINED_MAX_LENGTH) {
      return { projectPath: candidate.projectPath, codeUnitLength: length };
    }
  }
  return null;
}
