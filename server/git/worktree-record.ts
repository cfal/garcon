export interface WorktreeRecord {
  path: string;
  branch: string;
  name: string;
  isMain: boolean;
}

export function compareWorktreePaths(
  left: WorktreeRecord,
  right: WorktreeRecord,
): number {
  return Buffer.compare(Buffer.from(left.path), Buffer.from(right.path));
}
