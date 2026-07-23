import type { GitChangeKind, PorcelainStatusEntry } from './types.js';

const CHANGE_KIND_BY_STATUS = Object.freeze({
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'renamed',
  U: 'modified',
  '?': 'untracked',
});

export function changeKindForStatus(status: string): GitChangeKind {
  return CHANGE_KIND_BY_STATUS[status as keyof typeof CHANGE_KIND_BY_STATUS] || 'modified';
}

export function hasIndexChange(status: string): boolean {
  return status !== ' ' && status !== '?' && status !== '!' && Boolean(status);
}

export function hasWorkTreeChange(status: string): boolean {
  return status !== ' ' && status !== '!' && Boolean(status);
}

export function parsePorcelainV1Z(output: string): PorcelainStatusEntry[] {
  const tokens = output.split('\0').filter(Boolean);
  const entries: PorcelainStatusEntry[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const indexStatus = token[0] || ' ';
    const workTreeStatus = token[1] || ' ';
    const filePath = token.slice(3);

    if (indexStatus === 'R' || indexStatus === 'C') {
      entries.push({
        path: filePath,
        originalPath: tokens[++i] || '',
        indexStatus,
        workTreeStatus,
      });
      continue;
    }

    entries.push({ path: filePath, indexStatus, workTreeStatus });
  }

  return entries;
}

export function indexPorcelainStatusByPath(
  entries: PorcelainStatusEntry[],
): Map<string, PorcelainStatusEntry> {
  const byPath = new Map<string, PorcelainStatusEntry>();
  for (const entry of entries) {
    const existing = byPath.get(entry.path);
    if (!existing || existing.indexStatus === '?') byPath.set(entry.path, entry);
  }
  return byPath;
}
