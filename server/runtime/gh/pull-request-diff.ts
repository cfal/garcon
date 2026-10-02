import { createHash } from 'node:crypto';
import { createReviewPatchBody } from '../git/review-patch.js';
import { stripDiffHeaders } from '../git/run.js';
import type { GitReviewFilePatchBody } from '../git/types.js';

export interface GitDiffPatchFile {
  path: string;
  originalPath?: string;
  status: string;
  changeKind: string;
  additions: number;
  deletions: number;
  isBinary: boolean;
  body: GitReviewFilePatchBody;
}

const PATCH_CHANGE_KIND: Record<string, string> = {
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'renamed',
  M: 'modified',
};

function stripAbPrefix(candidate: string): string {
  return candidate.startsWith('a/') || candidate.startsWith('b/') ? candidate.slice(2) : candidate;
}

// Parses a single `diff --git` segment into a compact review body.
function parseDiffFilePatch(segment: string): GitDiffPatchFile | null {
  const lines = segment.split('\n');
  const headerMatch = lines[0].match(/^diff --git a\/(.*) b\/(.*)$/);
  let oldPath = headerMatch?.[1];
  let newPath = headerMatch?.[2];
  let status = 'M';
  let renameFrom: string | undefined;
  let renameTo: string | undefined;

  for (const line of lines) {
    if (line.startsWith('new file mode')) status = 'A';
    else if (line.startsWith('deleted file mode')) status = 'D';
    else if (line.startsWith('rename from ')) {
      renameFrom = line.slice('rename from '.length);
      status = 'R';
    } else if (line.startsWith('rename to ')) {
      renameTo = line.slice('rename to '.length);
      status = 'R';
    } else if (line.startsWith('--- ')) {
      const value = line.slice(4);
      if (value !== '/dev/null') oldPath = stripAbPrefix(value);
    } else if (line.startsWith('+++ ')) {
      const value = line.slice(4);
      if (value !== '/dev/null') newPath = stripAbPrefix(value);
    }
    if (status !== 'M' && line.startsWith('@@')) break;
  }

  const path = status === 'D' ? oldPath ?? newPath : renameTo ?? newPath ?? oldPath;
  if (!path) return null;

  const patchBody = stripDiffHeaders(segment);
  const fingerprint = createHash('sha1').update(segment).digest('hex').slice(0, 16);
  const body = createReviewPatchBody(path, fingerprint, patchBody);

  let additions = 0;
  let deletions = 0;
  let insideHunk = false;
  for (const line of patchBody.split('\n')) {
    if (line.startsWith('@@')) {
      insideHunk = true;
      continue;
    }
    if (!insideHunk || line.startsWith('\\')) continue;
    if (line.startsWith('+')) additions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }

  return {
    path,
    originalPath: status === 'R' ? renameFrom ?? oldPath : undefined,
    status,
    changeKind: PATCH_CHANGE_KIND[status] ?? 'modified',
    additions,
    deletions,
    isBinary: body.isBinary,
    body,
  };
}

// Splits a multi-file unified diff into compact per-file patch bodies.
export function parseMultiFileDiffPatches(diffText: string): GitDiffPatchFile[] {
  if (!diffText.trim()) return [];
  const segments = diffText.split(/\n(?=diff --git )/);
  const files: GitDiffPatchFile[] = [];
  for (const segment of segments) {
    if (!segment.startsWith('diff --git ')) continue;
    const parsed = parseDiffFilePatch(segment);
    if (parsed) files.push(parsed);
  }
  return files;
}
