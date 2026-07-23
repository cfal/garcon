import { isRecord } from '../../common/json.js';
import type { GitDiffFileRequest } from '../git/types.js';

export function parseGitDiffFileRequests(value: unknown): GitDiffFileRequest[] | null {
  if (!Array.isArray(value)) return null;

  const files: GitDiffFileRequest[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) return null;

    const path = nonEmptyPath(candidate.path);
    const originalPath = candidate.originalPath === undefined ? undefined : nonEmptyPath(candidate.originalPath);
    if (!path || (candidate.originalPath !== undefined && !originalPath)) return null;
    files.push({ path, ...(originalPath ? { originalPath } : {}) });
  }
  return files;
}

function nonEmptyPath(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0') ? value : null;
}
