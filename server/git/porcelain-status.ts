import type { GitChangeKind, PorcelainStatusEntry } from './types.js';

// The seven two-column codes git reports for index conflicts; shared by every
// consumer that needs to recognize unmerged entries.
export const UNMERGED_STATUSES: ReadonlySet<string> = new Set([
  'UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD',
]);

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

    // R/C in either column carries a second token holding the original path;
    // the worktree column form (DR) arises when an intent-to-add destination
    // is paired with a vanished source. Skipping consumption desyncs the
    // token stream and fabricates a phantom entry from the original path.
    if (
      indexStatus === 'R' || indexStatus === 'C' ||
      workTreeStatus === 'R' || workTreeStatus === 'C'
    ) {
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
