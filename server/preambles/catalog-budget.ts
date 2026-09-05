import { renderPreamblePrefix } from '../../common/preamble-prefix.js';
import { CHAT_ID_LENGTH } from '../../common/chat-id.js';
import {
  PREAMBLE_COMBINED_MAX_LENGTH,
  PREAMBLE_FILE_CONTEXT_SEPARATOR,
  renderPreambleContent,
  type Preamble,
} from '../../common/preambles.js';
import { preambleMatchesProjectPath } from './matching.js';

const CHAT_ID_LENGTH_SAMPLE = '1'.repeat(CHAT_ID_LENGTH);

export type PreambleCatalogCompositionViolation =
  | {
      readonly kind: 'combined-limit';
      readonly projectPath: string | null;
      readonly codeUnitLength: number;
    }
  | {
      readonly kind: 'file-context-separator';
      readonly projectPath: string | null;
    };

export function preambleCatalogCompositionViolation(
  preambles: readonly Preamble[],
): PreambleCatalogCompositionViolation | null {
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
      entries: preambles.filter((preamble) => (
        preambleMatchesProjectPath(preamble, projectPath)
      )),
    })),
  ];
  for (const candidate of candidates) {
    if (candidate.entries.length === 0) continue;
    const prefix = renderPreamblePrefix(candidate.entries.map((entry) => (
      renderPreambleContent(entry.content, CHAT_ID_LENGTH_SAMPLE)
    )));
    if (prefix.includes(PREAMBLE_FILE_CONTEXT_SEPARATOR)) {
      return { kind: 'file-context-separator', projectPath: candidate.projectPath };
    }
    if (prefix.length > PREAMBLE_COMBINED_MAX_LENGTH) {
      return {
        kind: 'combined-limit',
        projectPath: candidate.projectPath,
        codeUnitLength: prefix.length,
      };
    }
  }
  return null;
}
