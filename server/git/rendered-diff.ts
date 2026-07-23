import { GIT_REVIEW_DOCUMENT_LIMITS } from './types.js';
import type {
  GitFileReviewCategory,
  GitRenderedDiffRow,
  GitRenderedHunk,
  GitReviewFileBody,
  GitReviewLimitReason,
} from './types.js';

export interface ParsedRenderedPatch {
  rows: GitRenderedDiffRow[];
  hunks: GitRenderedHunk[];
}

function rawDiffDestinationPaths(rawText: string): string[] {
  const fields = rawText.split('\0');
  const paths: string[] = [];
  let index = 0;

  while (index < fields.length) {
    const header = fields[index++];
    if (!header.startsWith(':')) {
      throw new Error('Git returned malformed raw diff metadata.');
    }
    const statusStart = header.lastIndexOf(' ') + 1;
    const status = header.slice(statusStart, statusStart + 1);
    const firstPath = fields[index++];
    if (!firstPath) throw new Error('Git raw diff metadata omitted a file path.');
    if (status === 'R' || status === 'C') {
      const destinationPath = fields[index++];
      if (!destinationPath) throw new Error('Git raw diff metadata omitted a destination path.');
      paths.push(destinationPath);
    } else {
      paths.push(firstPath);
    }
  }

  return paths;
}

export function selectFilePatchFromRawDiff(rawPatchText: string, path: string): string {
  if (!rawPatchText) return '';
  const patchMarker = '\0\0diff --git ';
  const patchStart = rawPatchText.indexOf(patchMarker);
  if (patchStart < 0) throw new Error('Git diff output omitted raw file metadata.');

  const paths = rawDiffDestinationPaths(rawPatchText.slice(0, patchStart));
  const sections = rawPatchText.slice(patchStart + 2).split(/\n(?=diff --git )/);
  if (paths.length !== sections.length) {
    throw new Error('Git diff metadata did not match its patch sections.');
  }

  const sectionIndex = paths.indexOf(path);
  if (sectionIndex < 0) throw new Error(`Git diff output omitted ${path}.`);
  const section = sections[sectionIndex];
  return section.endsWith('\n') ? section : `${section}\n`;
}

export function parseUnifiedPatchToRenderedRows(diffText: string): ParsedRenderedPatch {
  const lines = diffText.split('\n');
  const rows: GitRenderedDiffRow[] = [];
  const hunks: GitRenderedHunk[] = [];
  let beforeLine = 0;
  let afterLine = 0;
  let diffLineIndex = 0;
  let currentHunkIndex = -1;
  let sawFileHeader = false;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (line === '' && lineIndex === lines.length - 1) continue;
    if (line.startsWith('diff --git ')) {
      if (sawFileHeader) break;
      sawFileHeader = true;
      continue;
    }

    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
    if (hunkMatch) {
      currentHunkIndex += 1;
      beforeLine = Number(hunkMatch[1]);
      afterLine = Number(hunkMatch[3]);
      const hunkId = `hunk-${currentHunkIndex}`;
      rows.push({
        key: `hunk:${currentHunkIndex}:${hunkId}`,
        kind: 'hunk',
        hunkIndex: currentHunkIndex,
        hunkId,
        beforeLine: null,
        afterLine: null,
        text: line,
        diffLineIndex: -1,
      });
      hunks.push({
        id: hunkId,
        header: line,
        oldStart: Number(hunkMatch[1]),
        oldLines: hunkMatch[2] ? Number(hunkMatch[2]) : 1,
        newStart: Number(hunkMatch[3]),
        newLines: hunkMatch[4] ? Number(hunkMatch[4]) : 1,
        rowStartIndex: rows.length - 1,
        rowEndIndex: rows.length - 1,
      });
      continue;
    }

    if (currentHunkIndex < 0 || line.startsWith('\\')) continue;
    const hunk = hunks[currentHunkIndex];

    if (line.startsWith('-')) {
      rows.push({
        key: `line:${diffLineIndex}:del:${beforeLine}`,
        kind: 'del',
        hunkIndex: currentHunkIndex,
        hunkId: hunk.id,
        beforeLine,
        afterLine: null,
        text: line.slice(1),
        diffLineIndex,
      });
      beforeLine += 1;
      diffLineIndex += 1;
    } else if (line.startsWith('+')) {
      rows.push({
        key: `line:${diffLineIndex}:add:${afterLine}`,
        kind: 'add',
        hunkIndex: currentHunkIndex,
        hunkId: hunk.id,
        beforeLine: null,
        afterLine,
        text: line.slice(1),
        diffLineIndex,
      });
      afterLine += 1;
      diffLineIndex += 1;
    } else if (line.startsWith(' ') || line === '') {
      rows.push({
        key: `line:${diffLineIndex}:context:${beforeLine}:${afterLine}`,
        kind: 'context',
        hunkIndex: currentHunkIndex,
        hunkId: hunk.id,
        beforeLine,
        afterLine,
        text: line.startsWith(' ') ? line.slice(1) : '',
        diffLineIndex,
      });
      beforeLine += 1;
      afterLine += 1;
      diffLineIndex += 1;
    }

    hunk.rowEndIndex = rows.length - 1;
  }

  return { rows, hunks };
}

export function categoryForPath(filePath: string): GitFileReviewCategory {
  const normalized = filePath.replace(/\\/g, '/');
  const name = normalized.split('/').pop() ?? normalized;
  if (
    name === 'bun.lock' ||
    name === 'package-lock.json' ||
    name === 'pnpm-lock.yaml' ||
    name === 'yarn.lock' ||
    name === 'Cargo.lock' ||
    name === 'go.sum'
  ) {
    return 'lockfile';
  }
  if (
    normalized.includes('/generated/') ||
    normalized.endsWith('.min.js') ||
    normalized.includes('/src/lib/paraglide/')
  ) {
    return 'generated';
  }
  return 'normal';
}

export function limitedFileBody(
  path: string,
  bodyFingerprint: string,
  limitReason: GitReviewLimitReason,
  limitMessage: string,
): GitReviewFileBody {
  const isBinary = limitReason === 'binary';
  return {
    path,
    bodyFingerprint,
    bodyState: isBinary ? 'binary' : 'too-large',
    category: isBinary ? 'binary' : 'large',
    isBinary,
    isTooLarge: !isBinary,
    renderedRowCount: 0,
    patchBytes: 0,
    limitReason,
    limitMessage,
    rows: [],
    hunks: [],
  };
}

export function errorFileBody(path: string, bodyFingerprint: string, message: string): GitReviewFileBody {
  return {
    path,
    bodyFingerprint,
    bodyState: 'error',
    category: categoryForPath(path),
    isBinary: false,
    isTooLarge: false,
    renderedRowCount: 0,
    patchBytes: 0,
    rows: [],
    hunks: [],
    error: message,
  };
}

export function limitedRenderedPatch(
  path: string,
  bodyFingerprint: string,
  patchText: string,
): GitReviewFileBody {
  if (hasBinaryPatchMarker(patchText)) {
    return limitedFileBody(
      path,
      bodyFingerprint,
      'binary',
      'Binary diff is not available.',
    );
  }

  const patchBytes = Buffer.byteLength(patchText);
  if (patchBytes > GIT_REVIEW_DOCUMENT_LIMITS.maxFilePatchBytes) {
    return limitedFileBody(
      path,
      bodyFingerprint,
      'file-too-many-bytes',
      `Diff exceeds ${GIT_REVIEW_DOCUMENT_LIMITS.maxFilePatchBytes} byte display limit.`,
    );
  }

  for (const line of patchText.split('\n')) {
    if (Buffer.byteLength(line) > GIT_REVIEW_DOCUMENT_LIMITS.maxLineBytes) {
      return limitedFileBody(
        path,
        bodyFingerprint,
        'line-too-long',
        `Diff contains a line over ${GIT_REVIEW_DOCUMENT_LIMITS.maxLineBytes} bytes.`,
      );
    }
  }

  const { rows, hunks } = parseUnifiedPatchToRenderedRows(patchText);
  if (rows.length > GIT_REVIEW_DOCUMENT_LIMITS.maxFileRows) {
    return limitedFileBody(
      path,
      bodyFingerprint,
      'file-too-many-rows',
      `Diff exceeds ${GIT_REVIEW_DOCUMENT_LIMITS.maxFileRows} rendered rows.`,
    );
  }

  return {
    path,
    bodyFingerprint,
    bodyState: 'loaded',
    category: categoryForPath(path),
    isBinary: false,
    isTooLarge: false,
    renderedRowCount: rows.length,
    patchBytes,
    rows,
    hunks,
  };
}

function hasBinaryPatchMarker(patchText: string): boolean {
  return patchText
    .split('\n')
    .some((line) => line === 'GIT binary patch' || /^Binary files .+ differ$/.test(line));
}
