import path from 'node:path';
import { renderPreamblePrefix } from '../../common/preamble-prefix.js';
import { CHAT_ID_LENGTH } from '../../common/chat-id.js';
import {
  PREAMBLE_COMBINED_MAX_LENGTH,
  PREAMBLE_FILE_CONTEXT_SEPARATOR,
  renderPreambleContent,
  type Preamble,
} from '../../common/preambles.js';

const CHAT_ID_LENGTH_SAMPLE = '1'.repeat(CHAT_ID_LENGTH);

interface RenderedPreamble {
  readonly bit: bigint;
  readonly content: string;
}

interface PathCandidate {
  readonly projectPath: string;
  exactMask: bigint;
  nestedMask: bigint;
  inheritedNestedMask?: bigint;
}

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
  const rendered: RenderedPreamble[] = [];
  const candidates = new Map<string, PathCandidate>();
  let globalMask = 0n;
  for (const [index, preamble] of preambles.entries()) {
    if (!preamble.enabled) continue;
    const bit = 1n << BigInt(index);
    rendered.push({ bit, content: renderPreambleContent(preamble.content, CHAT_ID_LENGTH_SAMPLE) });
    if (preamble.scope.type === 'global') {
      globalMask |= bit;
      continue;
    }
    for (const rule of preamble.scope.rules) {
      const candidate = candidates.get(rule.projectPath) ?? {
        projectPath: rule.projectPath,
        exactMask: 0n,
        nestedMask: 0n,
      };
      candidate.exactMask |= bit;
      if (rule.includeNested) candidate.nestedMask |= bit;
      candidates.set(rule.projectPath, candidate);
    }
  }
  const checkedMasks = new Set<bigint>();
  const scopes: readonly [string | null, bigint][] = [
    [null, globalMask],
    ...[...candidates.values()].map((candidate): [string, bigint] => [
      candidate.projectPath,
      globalMask | candidate.exactMask | inheritedNestedMask(candidate, candidates),
    ]),
  ];
  for (const [projectPath, mask] of scopes) {
    if (mask === 0n || checkedMasks.has(mask)) continue;
    checkedMasks.add(mask);
    const prefix = renderPreamblePrefix(rendered
      .filter((entry) => (entry.bit & mask) !== 0n)
      .map((entry) => entry.content));
    if (prefix.includes(PREAMBLE_FILE_CONTEXT_SEPARATOR)) {
      return { kind: 'file-context-separator', projectPath };
    }
    if (prefix.length > PREAMBLE_COMBINED_MAX_LENGTH) {
      return {
        kind: 'combined-limit',
        projectPath,
        codeUnitLength: prefix.length,
      };
    }
  }
  return null;
}

function inheritedNestedMask(
  candidate: PathCandidate,
  candidates: ReadonlyMap<string, PathCandidate>,
): bigint {
  if (candidate.inheritedNestedMask !== undefined) return candidate.inheritedNestedMask;
  let cursor = candidate.projectPath;
  let parent: PathCandidate | undefined;
  while (true) {
    const parentPath = path.dirname(cursor);
    if (parentPath === cursor) break;
    parent = candidates.get(parentPath);
    if (parent) break;
    cursor = parentPath;
  }
  candidate.inheritedNestedMask = candidate.nestedMask
    | (parent ? inheritedNestedMask(parent, candidates) : 0n);
  return candidate.inheritedNestedMask;
}
