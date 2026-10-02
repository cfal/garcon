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

function decodeGitPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  const quoted = value.slice(1, -1);
  const escapes: Record<string, string> = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '"': '"', '\\': '\\' };
  const parts: Buffer[] = [];
  let offset = 0;
  for (const match of quoted.matchAll(/\\([0-7]{1,3}|[abfnrtv"\\])/g)) {
    parts.push(Buffer.from(quoted.slice(offset, match.index)));
    const escape = match[1];
    parts.push(/^[0-7]/.test(escape) ? Buffer.from([parseInt(escape, 8)]) : Buffer.from(escapes[escape]));
    offset = match.index + match[0].length;
  }
  parts.push(Buffer.from(quoted.slice(offset)));
  return Buffer.concat(parts).toString('utf8');
}

function diffHeaderPaths(header: string): [string | undefined, string | undefined] {
  const paths = header.slice('diff --git '.length);
  // Unquoted spaces are legal; unchanged names disambiguate embedded " b/".
  const middle = (paths.length - 1) / 2;
  if (Number.isInteger(middle) && paths.startsWith('a/') && paths.slice(middle, middle + 3) === ' b/') {
    const oldPath = paths.slice(2, middle);
    const newPath = paths.slice(middle + 3);
    if (oldPath === newPath) return [oldPath, newPath];
  }
  const match = /^("(?:[^"\\]|\\.)*"|a\/.*?) ("(?:[^"\\]|\\.)*"|b\/.*)$/.exec(paths);
  if (!match) return [undefined, undefined];
  return [stripAbPrefix(decodeGitPath(match[1])), stripAbPrefix(decodeGitPath(match[2]))];
}

function fileHeaderPath(value: string): string {
  // Unquoted header paths may end with a tab delimiter, not part of the filename.
  const path = value.startsWith('"') ? value : value.split('\t', 1)[0];
  return stripAbPrefix(decodeGitPath(path));
}

// Parses a single `diff --git` segment into a compact review body.
function parseDiffFilePatch(segment: string): GitDiffPatchFile | null {
  const lines = segment.split('\n');
  let [oldPath, newPath] = diffHeaderPaths(lines[0]);
  let status = 'M';
  let renameFrom: string | undefined;
  let renameTo: string | undefined;

  for (const line of lines) {
    if (line.startsWith('@@')) break;
    if (line.startsWith('new file mode')) status = 'A';
    else if (line.startsWith('deleted file mode')) status = 'D';
    else if (line.startsWith('rename from ')) {
      renameFrom = decodeGitPath(line.slice('rename from '.length));
      status = 'R';
    } else if (line.startsWith('rename to ')) {
      renameTo = decodeGitPath(line.slice('rename to '.length));
      status = 'R';
    } else if (line.startsWith('--- ')) {
      const value = line.slice(4);
      if (value !== '/dev/null') oldPath = fileHeaderPath(value);
    } else if (line.startsWith('+++ ')) {
      const value = line.slice(4);
      if (value !== '/dev/null') newPath = fileHeaderPath(value);
    }
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
