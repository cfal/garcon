import { GIT_REVIEW_DOCUMENT_LIMITS } from './types.js';
import { GIT_MAX_RESULT_BYTES } from '../../../common/git-execution.js';
import type {
  GitFileReviewCategory,
  GitReviewFilePatchBody,
  GitReviewLimitReason,
} from './types.js';

const MAX_ENCODED_BODY_BYTES = GIT_MAX_RESULT_BYTES - 1024 * 1024;

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

interface InspectedUnifiedPatch {
  renderedRowCount: number;
  hunkCount: number;
  hasBinaryMarker: boolean;
  maxLineBytes: number;
}

function inspectUnifiedPatch(
  patchText: string,
  options: { allowMultipleFileSections?: boolean } = {},
): InspectedUnifiedPatch {
  let renderedRowCount = 0;
  let hunkCount = 0;
  let currentHunkIndex = -1;
  let sawFileHeader = false;
  let countRows = true;
  let hasBinaryMarker = false;
  let maxLineBytes = 0;
  let start = 0;
  while (start < patchText.length) {
    const newline = patchText.indexOf('\n', start);
    const end = newline === -1 ? patchText.length : newline;
    const line = patchText.slice(start, end);
    start = newline === -1 ? patchText.length : newline + 1;
    maxLineBytes = Math.max(maxLineBytes, Buffer.byteLength(line));
    if (
      line === 'GIT binary patch' ||
      (line.startsWith('Binary files ') && line.endsWith(' differ'))
    ) {
      hasBinaryMarker = true;
    }
    if (line.startsWith('diff --git ')) {
      if (sawFileHeader && !options.allowMultipleFileSections) {
        countRows = false;
        currentHunkIndex = -1;
        continue;
      }
      sawFileHeader = true;
      currentHunkIndex = -1;
      continue;
    }
    if (!countRows) continue;
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
  return { renderedRowCount, hunkCount, hasBinaryMarker, maxLineBytes };
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

export function createReviewPatchBody(
  path: string,
  bodyFingerprint: string,
  patchText: string,
  options: { allowMultipleFileSections?: boolean } = {},
): GitReviewFilePatchBody {
  const inspected = inspectUnifiedPatch(patchText, options);
  if (inspected.hasBinaryMarker) {
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
  if (inspected.maxLineBytes > GIT_REVIEW_DOCUMENT_LIMITS.maxLineBytes) {
    return limitedPatchFileBody(
      path,
      bodyFingerprint,
      'line-too-long',
      `Diff contains a line over ${GIT_REVIEW_DOCUMENT_LIMITS.maxLineBytes} bytes.`,
    );
  }
  if (inspected.renderedRowCount > GIT_REVIEW_DOCUMENT_LIMITS.maxFileRows) {
    return limitedPatchFileBody(
      path,
      bodyFingerprint,
      'file-too-many-rows',
      `Diff exceeds ${GIT_REVIEW_DOCUMENT_LIMITS.maxFileRows} rendered rows.`,
    );
  }
  const body: GitReviewFilePatchBody = {
    path,
    bodyFingerprint,
    bodyState: 'loaded',
    category: categoryForPath(path),
    isBinary: false,
    isTooLarge: false,
    renderedRowCount: inspected.renderedRowCount,
    patchBytes,
    patch: patchText,
  };
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_ENCODED_BODY_BYTES) {
    return limitedPatchFileBody(
      path,
      bodyFingerprint,
      'file-too-many-bytes',
      `Encoded diff exceeds ${MAX_ENCODED_BODY_BYTES} byte display limit.`,
    );
  }
  return body;
}
