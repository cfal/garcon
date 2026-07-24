import { GIT_REVIEW_DOCUMENT_LIMITS } from './types.js';
import type {
  GitFileReviewCategory,
  GitRenderedDiffRow,
  GitRenderedHunk,
  GitReviewFileBody,
  GitReviewFilePatchBody,
  GitReviewLimitReason,
} from './types.js';

export interface ParsedRenderedPatch {
  rows: GitRenderedDiffRow[];
  hunks: GitRenderedHunk[];
}

interface RawDiffFileEntry {
  path: string;
  originalPath?: string;
  rawStatus: string;
  patchSectionCount: number;
}

export interface SplitRawDiffPatch extends RawDiffFileEntry {
  patch: string;
}

function rawDiffFileEntries(rawText: string): RawDiffFileEntry[] {
  const fields = rawText.split('\0');
  const entries: RawDiffFileEntry[] = [];
  let index = 0;

  while (index < fields.length) {
    const header = fields[index++];
    if (!header.startsWith(':')) {
      throw new Error('Git returned malformed raw diff metadata.');
    }
    const statusStart = header.lastIndexOf(' ') + 1;
    const rawStatus = header.slice(statusStart);
    const status = rawStatus.slice(0, 1);
    const firstPath = fields[index++];
    if (!firstPath) throw new Error('Git raw diff metadata omitted a file path.');
    if (status === 'R' || status === 'C') {
      const destinationPath = fields[index++];
      if (!destinationPath) throw new Error('Git raw diff metadata omitted a destination path.');
      entries.push({
        path: destinationPath,
        originalPath: firstPath,
        rawStatus,
        patchSectionCount: 1,
      });
    } else {
      entries.push({
        path: firstPath,
        rawStatus,
        patchSectionCount: status === 'T' ? 2 : 1,
      });
    }
  }

  return entries;
}

export function splitPatchesFromRawDiff(rawPatchText: string): Map<string, SplitRawDiffPatch> {
  if (!rawPatchText) return new Map();
  const patchMarker = '\0\0diff --git ';
  const patchStart = rawPatchText.indexOf(patchMarker);
  if (patchStart < 0) throw new Error('Git diff output omitted raw file metadata.');

  const entries = rawDiffFileEntries(rawPatchText.slice(0, patchStart));
  const sections = rawPatchText.slice(patchStart + 2).split(/\n(?=diff --git )/);
  const expectedSectionCount = entries.reduce((total, entry) => total + entry.patchSectionCount, 0);
  if (expectedSectionCount !== sections.length) {
    throw new Error('Git diff metadata did not match its patch sections.');
  }

  const result = new Map<string, SplitRawDiffPatch>();
  let sectionIndex = 0;
  for (const entry of entries) {
    const selected = sections.slice(sectionIndex, sectionIndex + entry.patchSectionCount);
    if (result.has(entry.path)) throw new Error(`Git diff repeated ${entry.path}.`);
    const patch = selected.join('\n');
    result.set(entry.path, {
      ...entry,
      patch: patch.endsWith('\n') ? patch : `${patch}\n`,
    });
    sectionIndex += entry.patchSectionCount;
  }
  return result;
}

export function selectFilePatchFromRawDiff(rawPatchText: string, path: string): string {
  if (!rawPatchText) throw new Error(`Git diff output omitted ${path}.`);
  const selected = splitPatchesFromRawDiff(rawPatchText).get(path);
  if (selected) return selected.patch;
  throw new Error(`Git diff output omitted ${path}.`);
}

export function parseUnifiedPatchToRenderedRows(
  diffText: string,
  options: { allowMultipleFileSections?: boolean } = {},
): ParsedRenderedPatch {
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
      if (sawFileHeader && !options.allowMultipleFileSections) break;
      sawFileHeader = true;
      currentHunkIndex = -1;
      continue;
    }

    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
    if (hunkMatch) {
      currentHunkIndex = hunks.length;
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

export interface ScannedUnifiedPatch {
  renderedRowCount: number;
  hunkCount: number;
}

export function scanUnifiedPatch(
  patchText: string,
  options: { allowMultipleFileSections?: boolean } = {},
): ScannedUnifiedPatch {
  let renderedRowCount = 0;
  let hunkCount = 0;
  let currentHunkIndex = -1;
  let sawFileHeader = false;
  const lines = patchText.split('\n');
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (line === '' && lineIndex === lines.length - 1) continue;
    if (line.startsWith('diff --git ')) {
      if (sawFileHeader && !options.allowMultipleFileSections) break;
      sawFileHeader = true;
      currentHunkIndex = -1;
      continue;
    }
    if (/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.test(line)) {
      currentHunkIndex = hunkCount;
      hunkCount += 1;
      renderedRowCount += 1;
      continue;
    }
    if (
      currentHunkIndex >= 0 &&
      !line.startsWith('\\') &&
      (line.startsWith('-') || line.startsWith('+') || line.startsWith(' ') || line === '')
    ) {
      renderedRowCount += 1;
    }
  }
  return { renderedRowCount, hunkCount };
}

export function limitedPatchFileBody(
  path: string,
  bodyFingerprint: string,
  limitReason: GitReviewLimitReason,
  limitMessage: string,
): GitReviewFilePatchBody {
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
    patch: null,
    limitReason,
    limitMessage,
  };
}

export function errorPatchFileBody(
  path: string,
  bodyFingerprint: string,
  message: string,
): GitReviewFilePatchBody {
  return {
    path,
    bodyFingerprint,
    bodyState: 'error',
    category: categoryForPath(path),
    isBinary: false,
    isTooLarge: false,
    renderedRowCount: 0,
    patchBytes: 0,
    patch: null,
    error: message,
  };
}

export function compactRenderedPatch(
  path: string,
  bodyFingerprint: string,
  patchText: string,
  options: { allowMultipleFileSections?: boolean } = {},
): GitReviewFilePatchBody {
  if (hasBinaryPatchMarker(patchText)) {
    return limitedPatchFileBody(
      path,
      bodyFingerprint,
      'binary',
      'Binary diff is not available.',
    );
  }
  const patchBytes = Buffer.byteLength(patchText);
  if (patchBytes > GIT_REVIEW_DOCUMENT_LIMITS.maxFilePatchBytes) {
    return limitedPatchFileBody(
      path,
      bodyFingerprint,
      'file-too-many-bytes',
      `Diff exceeds ${GIT_REVIEW_DOCUMENT_LIMITS.maxFilePatchBytes} byte display limit.`,
    );
  }
  for (const line of patchText.split('\n')) {
    if (Buffer.byteLength(line) > GIT_REVIEW_DOCUMENT_LIMITS.maxLineBytes) {
      return limitedPatchFileBody(
        path,
        bodyFingerprint,
        'line-too-long',
        `Diff contains a line over ${GIT_REVIEW_DOCUMENT_LIMITS.maxLineBytes} bytes.`,
      );
    }
  }
  const scanned = scanUnifiedPatch(patchText, options);
  if (scanned.renderedRowCount > GIT_REVIEW_DOCUMENT_LIMITS.maxFileRows) {
    return limitedPatchFileBody(
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
    renderedRowCount: scanned.renderedRowCount,
    patchBytes,
    patch: patchText,
  };
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
  options: { allowMultipleFileSections?: boolean } = {},
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

  const { rows, hunks } = parseUnifiedPatchToRenderedRows(patchText, options);
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
