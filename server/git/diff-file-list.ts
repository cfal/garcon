import type { DiffStats, NumstatMap } from './types.js';

export interface ParsedDiffFile {
  path: string;
  status: string;
  originalPath?: string;
  additions: number;
  deletions: number;
  isBinary?: boolean;
}

// Parses `git diff --numstat -z` output without splitting paths on tabs.
export function parseNumstatZ(numstatOutput: string): NumstatMap {
  const map: NumstatMap = {};
  const tokens = numstatOutput.split('\0');

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;

    const firstTab = token.indexOf('\t');
    const secondTab = firstTab >= 0 ? token.indexOf('\t', firstTab + 1) : -1;
    if (firstTab < 0 || secondTab < 0) continue;

    const additionsRaw = token.slice(0, firstTab);
    const deletionsRaw = token.slice(firstTab + 1, secondTab);
    const isBinary = additionsRaw === '-' || deletionsRaw === '-';
    const additions = isBinary ? 0 : parseInt(additionsRaw, 10) || 0;
    const deletions = isBinary ? 0 : parseInt(deletionsRaw, 10) || 0;
    const pathPart = token.slice(secondTab + 1);

    if (pathPart) {
      map[pathPart] = { additions, deletions, ...(isBinary ? { isBinary } : {}) };
      continue;
    }

    const originalPath = tokens[++i];
    const renamedPath = tokens[++i] ?? originalPath;
    if (renamedPath) map[renamedPath] = { additions, deletions, ...(isBinary ? { isBinary } : {}) };
  }
  return map;
}

export function parseNameStatusZ(output: string, stats: NumstatMap): ParsedDiffFile[] {
  const files: ParsedDiffFile[] = [];
  const tokens = output.split('\0');
  if (tokens[tokens.length - 1] === '') tokens.pop();

  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++] ?? '';
    if (!status) continue;
    const isRenameOrCopy = status.startsWith('R') || status.startsWith('C');
    const originalPath = isRenameOrCopy ? tokens[index++] : undefined;
    const path = tokens[index++];
    if (!path) continue;
    const fileStats: DiffStats = stats[path] ?? { additions: 0, deletions: 0 };
    files.push({
      path,
      status,
      ...(originalPath ? { originalPath } : {}),
      additions: fileStats.additions,
      deletions: fileStats.deletions,
      ...(fileStats.isBinary ? { isBinary: true } : {}),
    });
  }
	return files;
}
