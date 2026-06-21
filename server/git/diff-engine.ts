import { promises as fs } from 'fs';
import { GIT_DIFF_LIMITS } from './types.js';
import { GitDomainError } from './git-types.js';
import type {
  BatchFileReviewOptions,
  BatchReviewResult,
  ChangeEntry,
  ChangeFacet,
  ChangesStatsOptions,
  ChangesStatsResult,
  ChangesTreeOptions,
  ChangesTreeResult,
  CompatibleTreeFields,
  DiffStats,
  FileReviewOptions,
  GitChangeKind,
  GitDiffLimitReason,
  GitFileReviewCategory,
  GitFileReviewData,
  GitRenderedDiffRow,
  GitRenderedHunk,
  GitReviewMode,
  HunkHeaderResult,
  HunkLineCounts,
  NumstatMap,
  ParsedPatch,
  PatchHunk,
  PorcelainStatusEntry,
  StageHunkOptions,
  StageSelectionOptions,
  TransformedHunk,
  TreeMap,
  TreeNode,
} from './types.js';
import {
  assertGitRepository,
  isBinaryFile,
  isFileUntracked,
  resolvePathWithinProject,
  runGit,
  runGitTraced,
  runGitWithStdin,
} from './run.js';

interface ParsedRenderedPatch {
  rows: GitRenderedDiffRow[];
  hunks: GitRenderedHunk[];
}

function parseUnifiedPatchToRenderedRows(diffText: string): ParsedRenderedPatch {
  const lines = diffText.split('\n');
  const rows: GitRenderedDiffRow[] = [];
  const hunks: GitRenderedHunk[] = [];
  let beforeLine = 0;
  let afterLine = 0;
  let diffLineIndex = 0;
  let currentHunkIndex = -1;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (line === '' && lineIndex === lines.length - 1) continue;

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

function renderedTruncation(
  path: string,
  mode: GitReviewMode,
  statusEntry: PorcelainStatusEntry,
  limitReason: GitDiffLimitReason,
  truncatedReason: string,
): GitFileReviewData {
  return {
    path,
    mode,
    indexStatus: statusEntry.indexStatus,
    workTreeStatus: statusEntry.workTreeStatus,
    isBinary: limitReason === 'binary',
    truncated: true,
    truncatedReason,
    limitReason,
    category: limitReason === 'binary' ? 'binary' : limitReason === 'patch-too-large' ? 'large' : categoryForPath(path),
    rows: [],
    hunks: [],
  };
}

function limitedRenderedPatch(
  path: string,
  mode: GitReviewMode,
  statusEntry: PorcelainStatusEntry,
  patchText: string,
): GitFileReviewData {
  if (hasBinaryPatchMarker(patchText)) {
    return renderedTruncation(
      path,
      mode,
      statusEntry,
      'binary',
      'Binary diff is not available.',
    );
  }

  const patchBytes = Buffer.byteLength(patchText);
  if (patchBytes > GIT_DIFF_LIMITS.maxPatchBytes) {
    return renderedTruncation(
      path,
      mode,
      statusEntry,
      'patch-too-large',
      `Diff exceeds ${GIT_DIFF_LIMITS.maxPatchBytes} byte display limit.`,
    );
  }

  for (const line of patchText.split('\n')) {
    if (Buffer.byteLength(line) > GIT_DIFF_LIMITS.maxLineBytes) {
      return renderedTruncation(
        path,
        mode,
        statusEntry,
        'line-too-long',
        `Diff contains a line over ${GIT_DIFF_LIMITS.maxLineBytes} bytes.`,
      );
    }
  }

  const { rows, hunks } = parseUnifiedPatchToRenderedRows(patchText);
  if (rows.length > GIT_DIFF_LIMITS.maxRenderedRows) {
    return renderedTruncation(
      path,
      mode,
      statusEntry,
      'too-many-rows',
      `Diff exceeds ${GIT_DIFF_LIMITS.maxRenderedRows} rendered rows.`,
    );
  }

  return {
    path,
    mode,
    indexStatus: statusEntry.indexStatus,
    workTreeStatus: statusEntry.workTreeStatus,
    isBinary: false,
    truncated: false,
    category: categoryForPath(path),
    rows,
    hunks,
  };
}

function hasBinaryPatchMarker(patchText: string): boolean {
  return patchText
    .split('\n')
    .some((line) => line === 'GIT binary patch' || /^Binary files .+ differ$/.test(line));
}

// Parses bulk `git diff --numstat` output into a map of file -> { additions, deletions }.
function parseNumstatBulk(numstatOutput: string): NumstatMap {
  const map: NumstatMap = {};
  for (const line of numstatOutput.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length >= 3) {
      const additions = parts[0] === '-' ? 0 : parseInt(parts[0], 10) || 0;
      const deletions = parts[1] === '-' ? 0 : parseInt(parts[1], 10) || 0;
      const filePath = parts[2];
      map[filePath] = { additions, deletions };
    }
  }
  return map;
}

const CHANGE_KIND_BY_STATUS = Object.freeze({
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'renamed',
  U: 'modified',
  '?': 'untracked',
});

function changeKindForStatus(status: string): GitChangeKind {
  return CHANGE_KIND_BY_STATUS[status as keyof typeof CHANGE_KIND_BY_STATUS] || 'modified';
}

function categoryForPath(filePath: string): GitFileReviewCategory {
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

function hasIndexChange(status: string): boolean {
  return status !== ' ' && status !== '?' && status !== '!' && Boolean(status);
}

function hasWorkTreeChange(status: string): boolean {
  return status !== ' ' && status !== '!' && Boolean(status);
}

function parsePorcelainV1Z(output: string): PorcelainStatusEntry[] {
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

function buildFacet(
  status: string,
  filePath: string,
  stats?: DiffStats,
  originalPath?: string,
): ChangeFacet | undefined {
  if (!status || status === ' ' || status === '!') return undefined;
  return {
    status,
    changeKind: changeKindForStatus(status),
    stats: stats || { additions: 0, deletions: 0 },
    ...(originalPath ? { originalPath } : {}),
    category: categoryForPath(filePath),
  };
}

function compatibleTreeFields(stagedFacet?: ChangeFacet, unstagedFacet?: ChangeFacet): CompatibleTreeFields {
  const primaryFacet = unstagedFacet ?? stagedFacet;
  const stats = unstagedFacet?.stats ?? stagedFacet?.stats ?? { additions: 0, deletions: 0 };
  return {
    staged: Boolean(stagedFacet),
    hasUnstaged: Boolean(unstagedFacet),
    changeKind: primaryFacet?.changeKind,
    additions: stats.additions,
    deletions: stats.deletions,
    category: primaryFacet?.category,
  };
}

function buildChangeEntry(
  statusEntry: PorcelainStatusEntry,
  workingStats: NumstatMap,
  cachedStats: NumstatMap,
): ChangeEntry {
  const filePath = statusEntry.path.replace(/\/+$/g, '');
  const stagedFacet = hasIndexChange(statusEntry.indexStatus)
    ? buildFacet(statusEntry.indexStatus, filePath, cachedStats[filePath], statusEntry.originalPath)
    : undefined;
  const unstagedStatus = statusEntry.indexStatus === '?' ? '?' : statusEntry.workTreeStatus;
  const unstagedFacet = hasWorkTreeChange(unstagedStatus)
    ? buildFacet(unstagedStatus, filePath, workingStats[filePath], statusEntry.originalPath)
    : undefined;

  return {
    path: filePath,
    indexStatus: statusEntry.indexStatus,
    workTreeStatus: statusEntry.workTreeStatus,
    stagedFacet,
    unstagedFacet,
  };
}

function mapTreeToArray(map: TreeMap): TreeNode[] {
  const result: TreeNode[] = [];
  for (const [, node] of map) {
    const entry: TreeNode = { ...node };
    if (entry.children instanceof Map) {
      entry.children = mapTreeToArray(entry.children);
    }
    result.push(entry);
  }
  result.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return result;
}

export function buildTreeFromStatus(
  statusOutput: string,
  workingStats: NumstatMap,
  cachedStats: NumstatMap,
  hasCommits: boolean,
  statsState: ChangesTreeResult['statsState'],
): ChangesTreeResult {
  const entries = parsePorcelainV1Z(statusOutput)
    .map((entry) => buildChangeEntry(entry, workingStats, cachedStats))
    .filter((entry) => entry.path);
  const rootMap: TreeMap = new Map();

  for (const entry of entries) {
    const segments = entry.path.split('/').filter(Boolean);
    if (segments.length === 0) continue;
    let currentLevel = rootMap;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const isLastSegment = i === segments.length - 1;

      if (!currentLevel.has(segment)) {
        if (isLastSegment) {
          const compatible = compatibleTreeFields(entry.stagedFacet, entry.unstagedFacet);
          currentLevel.set(segment, {
            path: entry.path,
            name: segment,
            kind: 'file',
            indexStatus: entry.indexStatus,
            workTreeStatus: entry.workTreeStatus,
            stagedFacet: entry.stagedFacet,
            unstagedFacet: entry.unstagedFacet,
            ...compatible,
          });
        } else {
          currentLevel.set(segment, {
            path: segments.slice(0, i + 1).join('/'),
            name: segment,
            kind: 'directory',
            indexStatus: ' ',
            workTreeStatus: ' ',
            staged: false,
            hasUnstaged: false,
            additions: 0,
            deletions: 0,
            children: new Map(),
          });
        }
      }

      const node = currentLevel.get(segment);
      if (!node) continue;
      if (!isLastSegment && node.kind === 'directory' && node.children instanceof Map) {
        if (entry.stagedFacet) {
          node.staged = true;
          node.stagedFacet = node.stagedFacet || entry.stagedFacet;
          node.indexStatus = 'M';
        }
        if (entry.unstagedFacet) {
          node.hasUnstaged = true;
          node.unstagedFacet = node.unstagedFacet || entry.unstagedFacet;
          node.workTreeStatus = 'M';
        }
        node.changeKind = node.unstagedFacet?.changeKind ?? node.stagedFacet?.changeKind;
        const stats = node.unstagedFacet?.stats ?? node.stagedFacet?.stats ?? { additions: 0, deletions: 0 };
        node.additions = (node.additions || 0) + stats.additions;
        node.deletions = (node.deletions || 0) + stats.deletions;
        currentLevel = node.children;
      }
    }
  }

  return { root: mapTreeToArray(rootMap), hasCommits, statsState };
}

function buildFullFileAddedPatch(contentAfter: string): string {
  const lines = contentAfter.split('\n');
  return `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}`;
}

function buildFullFileDeletedPatch(contentBefore: string | null): string {
  const lines = (contentBefore || '').split('\n');
  return `@@ -1,${lines.length} +0,0 @@\n${lines.map((line) => `-${line}`).join('\n')}`;
}

// Partial-staging implementation follows lazygit's patch-transform approach.
// See https://github.com/jesseduffield/lazygit (pkg/commands/patch/).
//
// Key design decisions (lazygit-aligned):
//
// 1. The patch is always built from the SAME diff the UI displayed. The
//    frontend passes viewMode and contextLines so the server reproduces
//    the exact diff, ensuring line indices match.
//
// 2. For staging (forward apply): unselected deletions become context
//    lines (the old line stays in the index unchanged). Unselected
//    additions are dropped entirely (they won't appear in the index).
//
// 3. For unstaging (reverse apply): the inverse -- unselected additions
//    become context, unselected deletions are dropped.
//
// 4. Hunk headers (@@ lines) are always recomputed from the transformed
//    body rather than parsed from the original, avoiding count drift.
//
// 5. newStart is computed as oldStart + cumulativeOffset where the offset
//    tracks the net line-count delta from prior transformed hunks.
//
// 6. The patch is applied via `git apply --cached` (staging) or
//    `git apply --cached --reverse` (unstaging).

// Parses a full unified diff into its file-level header and per-hunk bodies.
// Replaces full diff header with minimal a/b paths, matching lazygit's
// FileNameOverride approach. Prevents failures when partially staging
// deleted files or files with mode changes.
function simplifyDiffHeader(filePath: string): string[] {
  return [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
  ];
}

// Strips the trailing empty element that `split('\n')` produces from a
// newline-terminated diff -- without this, the last hunk would contain a
// spurious empty line that corrupts line counts in buildHunkHeader.
function parsePatch(patchText: string): ParsedPatch {
  const allLines = patchText.split('\n');
  // Remove trailing empty string artifact from split (diff always ends with \n)
  if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
    allLines.pop();
  }

  const header: string[] = [];
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | null = null;

  for (const line of allLines) {
    if (line.startsWith('diff --git') || line.startsWith('index ') ||
      line.startsWith('new file') || line.startsWith('deleted file') ||
      line.startsWith('---') || line.startsWith('+++') ||
      line.startsWith('old mode') || line.startsWith('new mode')) {
      header.push(line);
      continue;
    }
    if (line.startsWith('@@')) {
      if (current) hunks.push(current);
      current = { rawHeader: line, lines: [] };
      continue;
    }
    if (current) {
      current.lines.push(line);
    }
  }
  if (current) hunks.push(current);
  return { header, hunks };
}

// Transforms hunk body lines for partial staging/unstaging.
//
// For each line in the hunk body, decides whether to keep, convert to
// context, or drop based on whether its diffLineIndex is in selectedSet.
//
// Forward staging (reverse=false):
//   - Selected lines: kept as-is (both + and -)
//   - Unselected `-` lines: converted to context (` ` prefix). The line
//     exists in the old file and we're NOT removing it from the index.
//   - Unselected `+` lines: dropped entirely. We're NOT adding them.
//
// Reverse staging / unstaging (reverse=true):
//   - Selected lines: kept as-is
//   - Unselected `+` lines: converted to context. In reverse mode,
//     additions in the cached diff represent lines IN the index that we
//     want to keep, so they become context.
//   - Unselected `-` lines: dropped. In reverse mode, deletions represent
//     lines NOT in the index; dropping them is a no-op.
//
// `\ No newline at end of file` markers are dropped when their preceding
// change line was dropped, preserving patch validity.
function transformHunkLines(
  bodyLines: string[],
  selectedSet: Set<number>,
  startIndex: number,
  reverse: boolean,
): TransformedHunk {
  const result: string[] = [];
  let idx = startIndex;
  let lastLineDropped = false;

  for (const line of bodyLines) {
    if (line.startsWith('\\')) {
      // Keep the no-newline marker only if we kept the preceding change line.
      if (!lastLineDropped) result.push(line);
      continue;
    }

    const isAdd = line.startsWith('+');
    const isDel = line.startsWith('-');

    if (!isAdd && !isDel) {
      // Context line: always preserved in the transformed patch.
      result.push(line);
      idx++;
      lastLineDropped = false;
      continue;
    }

    const selected = selectedSet.has(idx);
    idx++;

    if (selected) {
      result.push(line);
      lastLineDropped = false;
    } else if (reverse ? isAdd : isDel) {
      // Unselected deletion (forward) or addition (reverse): convert to
      // context. This preserves the line in the index unchanged.
      result.push(' ' + line.substring(1));
      lastLineDropped = false;
    } else {
      // Unselected addition (forward) or deletion (reverse): drop from
      // the patch entirely. This omits the change from the index.
      lastLineDropped = true;
    }
  }

  return { lines: result, nextIndex: idx };
}

// Returns true when a transformed hunk body contains real changes.
function hunkHasChanges(bodyLines: string[]): boolean {
  return bodyLines.some((l) => l.startsWith('+') || l.startsWith('-'));
}

// Counts old-side and new-side lines in a hunk body. Context lines count
// toward both sides. `\` markers are ignored. This always recomputes from
// the actual body content rather than trusting the original @@ header,
// because transformHunkLines may have changed the line composition.
function countHunkLines(bodyLines: string[]): HunkLineCounts {
  let oldCount = 0;
  let newCount = 0;
  for (const l of bodyLines) {
    if (l.startsWith('\\')) continue;
    if (l.startsWith('-')) oldCount++;
    else if (l.startsWith('+')) newCount++;
    else { oldCount++; newCount++; }
  }
  return { oldCount, newCount };
}

// Builds a corrected @@ hunk header. `startOffset` is the cumulative
// delta (newCount - oldCount) from all prior hunks. newStart is computed
// as oldStart + startOffset, with an additional adjustment when a side
// transitions to/from zero length (matching lazygit's hunk header logic).
function buildHunkHeader(rawHeader: string, bodyLines: string[], startOffset: number): HunkHeaderResult {
  const match = rawHeader.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
  if (!match) return { header: rawHeader, nextOffset: startOffset };

  const oldStart = parseInt(match[1], 10);
  const trailing = match[3] || '';
  const { oldCount, newCount } = countHunkLines(bodyLines);

  // When a side is zero-length (e.g. new file or deleted file), the start
  // position needs an extra +1/-1 adjustment per unified diff convention.
  let zeroLengthAdj = 0;
  if (oldCount === 0) zeroLengthAdj = 1;
  else if (newCount === 0) zeroLengthAdj = -1;

  const newStart = oldStart + startOffset + zeroLengthAdj;
  const nextOffset = startOffset + (newCount - oldCount);

  return {
    header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${trailing}`,
    nextOffset,
  };
}

// Builds git diff args for the diff that the frontend tab displays.
// Unstaged tab: `git diff` (index vs working tree).
// Staged tab: `git diff --cached` (HEAD vs index).
// The same diff is used for both display and `git apply --cached`.
function tabDiffArgs(contextLines: number, file: string, isUnstage: boolean): string[] {
  const ctx = `-U${contextLines}`;
  if (isUnstage) {
    return ['diff', '--cached', ctx, '--', file];
  }
  return ['diff', ctx, '--', file];
}


async function getSingleFileStatus(
  projectPath: string,
  file: string,
  signal?: AbortSignal,
): Promise<PorcelainStatusEntry> {
  const { stdout } = await runGit(
    projectPath,
    ['status', '--porcelain=v1', '-z', '--', file],
    { signal },
  );
  const [entry] = parsePorcelainV1Z(stdout);
  return entry || { path: file, indexStatus: ' ', workTreeStatus: ' ' };
}

async function readHeadBlob(projectPath: string, file: string, signal?: AbortSignal): Promise<string> {
  try {
    const { stdout } = await runGit(projectPath, ['show', `HEAD:${file}`], { signal });
    return stdout;
  } catch {
    return '';
  }
}

async function readIndexBlob(projectPath: string, file: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const { stdout } = await runGit(projectPath, ['show', `:${file}`], { signal });
    return stdout;
  } catch {
    return null;
  }
}

function isRenderedPatchSupported(statusEntry: PorcelainStatusEntry, mode: GitReviewMode): boolean {
  if (statusEntry.indexStatus === 'R' || statusEntry.indexStatus === 'C') return false;
  if (mode === 'working') {
    return statusEntry.indexStatus !== '?' && statusEntry.workTreeStatus !== '?';
  }
  return statusEntry.indexStatus !== '?' && statusEntry.indexStatus !== ' ';
}

function unsupportedRenderedData(
  path: string,
  mode: GitReviewMode,
  statusEntry: PorcelainStatusEntry,
  message: string,
): GitFileReviewData {
  return {
    path,
    mode,
    indexStatus: statusEntry.indexStatus,
    workTreeStatus: statusEntry.workTreeStatus,
    isBinary: false,
    truncated: true,
    truncatedReason: message,
    limitReason: 'unsupported-file-kind',
    category: categoryForPath(path),
    rows: [],
    hunks: [],
  };
}

async function getFileReviewData({
  projectPath,
  file,
  mode = 'working',
  context = 5,
  signal,
}: FileReviewOptions): Promise<GitFileReviewData> {
  await assertGitRepository(projectPath);

  const effectiveMode = mode === 'staged' ? 'staged' : 'working';
  const statusEntry = await getSingleFileStatus(projectPath, file, signal);
  const isUntracked = effectiveMode === 'working' &&
    (statusEntry.indexStatus === '?' || statusEntry.workTreeStatus === '?');
  const isDeleted = effectiveMode === 'staged'
    ? statusEntry.indexStatus === 'D'
    : statusEntry.workTreeStatus === 'D';

  let filePath: string | null = null;
  if (!isDeleted) {
    try {
      filePath = resolvePathWithinProject(projectPath, file);
      const stats = await fs.stat(filePath);
      if (stats.isDirectory()) {
        return unsupportedRenderedData(
          file,
          effectiveMode,
          statusEntry,
          'Directory diff is not supported. Provide a file path.',
        );
      }
      if (await isBinaryFile(filePath)) {
        return renderedTruncation(
          file,
          effectiveMode,
          statusEntry,
          'binary',
          'Binary diff is not available.',
        );
      }
    } catch {
      filePath = null;
    }
  }

  let diffText = '';
  if (isUntracked) {
    if (!filePath) filePath = resolvePathWithinProject(projectPath, file);
    const contentAfter = await fs.readFile(filePath, 'utf-8');
    diffText = buildFullFileAddedPatch(contentAfter);
  } else {
    const args = effectiveMode === 'staged'
      ? ['diff', '--cached', `-U${context}`, '--', file]
      : ['diff', `-U${context}`, '--', file];
    try {
      const { stdout } = await runGit(projectPath, args, { signal });
      diffText = stdout;
    } catch {
      if (isDeleted) {
        const contentBefore = effectiveMode === 'staged'
          ? await readHeadBlob(projectPath, file, signal)
          : await readIndexBlob(projectPath, file, signal) ?? await readHeadBlob(projectPath, file, signal);
        diffText = buildFullFileDeletedPatch(contentBefore);
      } else {
        diffText = '';
      }
    }
  }

  return limitedRenderedPatch(file, effectiveMode, statusEntry, diffText);
}

async function getStatusMapForFiles(
  projectPath: string,
  files: string[],
  signal?: AbortSignal,
): Promise<Map<string, PorcelainStatusEntry>> {
  const result = new Map<string, PorcelainStatusEntry>();
  if (files.length === 0) return result;
  const { stdout } = await runGit(
    projectPath,
    ['status', '--porcelain=v1', '-z', '--', ...files],
    { signal },
  );
  for (const entry of parsePorcelainV1Z(stdout)) {
    result.set(entry.path, entry);
  }
  for (const file of files) {
    if (!result.has(file)) {
      result.set(file, { path: file, indexStatus: ' ', workTreeStatus: ' ' });
    }
  }
  return result;
}

function parseDiffGitPath(pathToken: string): string {
  if (pathToken === '/dev/null') return pathToken;
  if ((pathToken.startsWith('a/') || pathToken.startsWith('b/')) && pathToken.length > 2) {
    return pathToken.slice(2);
  }
  return pathToken;
}

function parseDiffGitHeaderPath(line: string, knownPaths: Set<string>): string | null {
  if (!line.startsWith('diff --git ')) return null;

  const rest = line.slice('diff --git '.length);
  const candidates = Array.from(knownPaths).sort((left, right) => right.length - left.length);
  for (const filePath of candidates) {
    if (rest.endsWith(` b/${filePath}`)) return filePath;
  }

  const match = rest.match(/^a\/(.+) b\/(.+)$/);
  if (!match) return null;
  return parseDiffGitPath(`b/${match[2]}`);
}

function parseDiffMetadataPath(line: string, marker: '---' | '+++'): string | null {
  const prefix = `${marker} `;
  if (!line.startsWith(prefix)) return null;
  return parseDiffGitPath(line.slice(prefix.length));
}

function resolvePatchChunkPath(lines: string[], fallbackPath: string | null): string | null {
  let oldPath: string | null = null;
  let newPath: string | null = null;

  for (const line of lines) {
    if (!oldPath) oldPath = parseDiffMetadataPath(line, '---');
    if (!newPath) newPath = parseDiffMetadataPath(line, '+++');
    if (oldPath && newPath) break;
  }

  if (newPath && newPath !== '/dev/null') return newPath;
  if (oldPath && oldPath !== '/dev/null') return oldPath;
  return fallbackPath;
}

function splitPatchByDiffGitBoundary(
  diffText: string,
  knownPaths: Set<string>,
): Map<string, string> {
  const chunks = new Map<string, string>();
  let fallbackPath: string | null = null;
  let currentLines: string[] = [];

  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const currentPath = resolvePatchChunkPath(currentLines, fallbackPath);
      if (currentPath) chunks.set(currentPath, currentLines.join('\n'));
      fallbackPath = parseDiffGitHeaderPath(line, knownPaths);
      currentLines = [line];
      continue;
    }
    if (currentLines.length > 0) currentLines.push(line);
  }

  const currentPath = resolvePatchChunkPath(currentLines, fallbackPath);
  if (currentPath) chunks.set(currentPath, currentLines.join('\n'));
  return chunks;
}

function parseMultiFileRenderedPatchByDiffGitBoundary(
  diffText: string,
  statusByPath: Map<string, PorcelainStatusEntry>,
  mode: GitReviewMode,
): Record<string, GitFileReviewData> {
  const files: Record<string, GitFileReviewData> = {};
  const chunks = splitPatchByDiffGitBoundary(diffText, new Set(statusByPath.keys()));
  for (const [filePath, patchText] of chunks) {
    const statusEntry = statusByPath.get(filePath) ??
      { path: filePath, indexStatus: ' ', workTreeStatus: ' ' };
    files[filePath] = limitedRenderedPatch(filePath, mode, statusEntry, patchText);
  }
  return files;
}

async function getChangesStats({
  projectPath,
  trace,
  signal,
  skipRepositoryAssert = false,
}: ChangesStatsOptions): Promise<ChangesStatsResult> {
  if (!skipRepositoryAssert) await assertGitRepository(projectPath);

  const [workingStatsResult, cachedStatsResult] = await Promise.allSettled([
    runGitTraced(projectPath, ['diff', '--numstat'], trace, { signal }),
    runGitTraced(projectPath, ['diff', '--cached', '--numstat'], trace, { signal }),
  ]);

  return {
    working: workingStatsResult.status === 'fulfilled'
      ? parseNumstatBulk(workingStatsResult.value.stdout)
      : {},
    staged: cachedStatsResult.status === 'fulfilled'
      ? parseNumstatBulk(cachedStatsResult.value.stdout)
      : {},
  };
}

async function getChangesTree({
  projectPath,
  includeStats = false,
  trace,
  signal,
}: ChangesTreeOptions): Promise<ChangesTreeResult> {
  await assertGitRepository(projectPath);

  const [headResult, statusResult] = await Promise.allSettled([
    runGitTraced(projectPath, ['rev-parse', 'HEAD'], trace, { signal }),
    runGitTraced(projectPath, ['status', '--porcelain=v1', '-z', '-uall'], trace, { signal }),
  ]);

  const hasCommits = headResult.status === 'fulfilled';
  if (statusResult.status === 'rejected') throw statusResult.reason;

  const statusOutput = statusResult.value.stdout;
  if (!statusOutput.trim()) {
    return { root: [], hasCommits, statsState: includeStats ? 'loaded' : 'pending' };
  }

  if (!includeStats) {
    return buildTreeFromStatus(statusOutput, {}, {}, hasCommits, 'pending');
  }

  const stats = await getChangesStats({ projectPath, trace, signal, skipRepositoryAssert: true });
  return buildTreeFromStatus(statusOutput, stats.working, stats.staged, hasCommits, 'loaded');
}

// Partially stages or unstages selected diff lines for a file.
//
// The frontend always shows HEAD vs working tree (`git diff HEAD`), so
// selection indices refer to positions in that diff. However, `git apply
// --cached` applies against the index, not HEAD. When the index already
// contains staged changes, context lines from a HEAD diff won't match
// the index, causing "patch does not apply".
//
// To handle this correctly (following lazygit's approach):
//   Staging: build the patch from `git diff` (index vs WT), translating
//     the HEAD-diff indices to index-diff indices by content matching.
//   Unstaging: build the patch from `git diff --cached` (HEAD vs index)
//     directly, since the frontend indices already match.
//
// For untracked files, intent-to-add (`git add -N`) creates an empty
// index entry first so `git diff` can produce a usable patch. On
// failure, the intent-to-add is rolled back.
async function stageSelection({
  projectPath,
  file,
  mode,
  selection,
  contextLines = 5,
}: StageSelectionOptions): Promise<unknown> {
  await assertGitRepository(projectPath);

  const reverse = mode === 'unstage';

  // For untracked files, create an empty index entry so git diff works.
  let didIntentToAdd = false;
  if (!reverse && await isFileUntracked(projectPath, file)) {
    await runGit(projectPath, ['add', '-N', '--', file]);
    didIntentToAdd = true;
  }

  try {
    // Frontend sends indices from the same diff that git apply --cached
    // operates on, so no translation is needed. Unstaged tab uses
    // `git diff`, staged tab uses `git diff --cached`.
    const diffArgs = tabDiffArgs(contextLines, file, reverse);
    const { stdout: patchText } = await runGit(projectPath, diffArgs);

    if (!patchText.trim()) {
      throw new GitDomainError('INVALID_INPUT', 'No diff is available for the requested file.');
    }

    const selectedSet = new Set(selection.lineIndices);
    const { hunks } = parsePatch(patchText);

    // Walk each hunk, transforming lines and propagating the cumulative
    // offset that adjusts newStart in subsequent hunk headers.
    const outputLines = [...simplifyDiffHeader(file)];
    let startOffset = 0;
    let diffLineIndex = 0;

    for (const hunk of hunks) {
      const { lines: bodyLines, nextIndex } = transformHunkLines(
        hunk.lines, selectedSet, diffLineIndex, reverse,
      );
      diffLineIndex = nextIndex;

      if (!hunkHasChanges(bodyLines)) continue;

      const { header: hunkHeader, nextOffset } = buildHunkHeader(
        hunk.rawHeader, bodyLines, startOffset,
      );
      startOffset = nextOffset;

      outputLines.push(hunkHeader);
      outputLines.push(...bodyLines);
    }

    const transformedPatch = outputLines.join('\n') + '\n';

    const applyArgs = reverse
      ? ['apply', '--cached', '--reverse', '-']
      : ['apply', '--cached', '-'];

    await runGitWithStdin(projectPath, applyArgs, transformedPatch);

    return { success: true };
  } catch (err) {
    if (didIntentToAdd) {
      try { await runGit(projectPath, ['reset', '--', file]); } catch { /* best effort */ }
    }
    throw err;
  }
}

// Stages or unstages a single hunk by its index. The hunk index refers
// to the diff the frontend tab displayed (unstaged tab = `git diff`,
// staged tab = `git diff --cached`).
async function stageHunk({
  projectPath,
  file,
  mode,
  hunkIndex,
  contextLines = 5,
}: StageHunkOptions): Promise<unknown> {
  await assertGitRepository(projectPath);

  const isUnstage = mode === 'unstage';

  let didIntentToAdd = false;
  if (!isUnstage && await isFileUntracked(projectPath, file)) {
    await runGit(projectPath, ['add', '-N', '--', file]);
    didIntentToAdd = true;
  }

  try {
    const diffArgs = tabDiffArgs(contextLines, file, isUnstage);
    const { stdout: fullPatch } = await runGit(projectPath, diffArgs);
    if (!fullPatch.trim()) {
      throw new GitDomainError('INVALID_INPUT', 'No diff is available for the requested target.');
    }
    const parsed = parsePatch(fullPatch);
    if (hunkIndex < 0 || hunkIndex >= parsed.hunks.length) {
      throw new GitDomainError('INVALID_INPUT', `Invalid hunk index ${hunkIndex}`);
    }
    const hunk = parsed.hunks[hunkIndex];

    const singleHunkPatch = [...simplifyDiffHeader(file), hunk.rawHeader, ...hunk.lines].join('\n') + '\n';

    const applyArgs = isUnstage
      ? ['apply', '--cached', '--reverse', '-']
      : ['apply', '--cached', '-'];

    await runGitWithStdin(projectPath, applyArgs, singleHunkPatch);

    return { success: true };
  } catch (err) {
    if (didIntentToAdd) {
      try { await runGit(projectPath, ['reset', '--', file]); } catch { /* best effort */ }
    }
    throw err;
  }
}


async function mapWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  const executing = new Set<Promise<void>>();
  for (const item of items) {
    const promise = Promise.resolve().then(() => worker(item));
    executing.add(promise);
    promise.finally(() => executing.delete(promise));
    if (executing.size >= limit) await Promise.race(executing);
  }
  await Promise.all(executing);
}

async function getFileReviewDataBatch({
  projectPath,
  files,
  mode = 'working',
  context = 5,
  signal,
}: BatchFileReviewOptions): Promise<BatchReviewResult> {
  await assertGitRepository(projectPath);

  const effectiveMode = mode === 'staged' ? 'staged' : 'working';
  const statusByPath = await getStatusMapForFiles(projectPath, files, signal);
  const regularFiles = files.filter((file) => {
    const statusEntry = statusByPath.get(file);
    return Boolean(statusEntry && isRenderedPatchSupported(statusEntry, effectiveMode));
  });
  const regularFileSet = new Set(regularFiles);
  const specialFiles = files.filter((file) => !regularFileSet.has(file));
  const parsedFiles: Record<string, GitFileReviewData> = {};
  const errors: Record<string, string> = {};

  if (regularFiles.length > 0) {
    const args = effectiveMode === 'staged'
      ? ['diff', '--cached', `-U${context}`, '--', ...regularFiles]
      : ['diff', `-U${context}`, '--', ...regularFiles];
    const { stdout } = await runGit(projectPath, args, { signal });
    Object.assign(
      parsedFiles,
      parseMultiFileRenderedPatchByDiffGitBoundary(stdout, statusByPath, effectiveMode),
    );
  }

  const fallbackFiles = [
    ...specialFiles,
    ...regularFiles.filter((file) => !parsedFiles[file]),
  ];

  await mapWithConcurrency(fallbackFiles, 4, async (file) => {
    try {
      parsedFiles[file] = await getFileReviewData({
        projectPath,
        file,
        mode: effectiveMode,
        context,
        signal,
      });
    } catch (error) {
      errors[file] = error instanceof Error ? error.message : String(error);
    }
  });

  return {
    files: Object.fromEntries(files.filter((file) => parsedFiles[file]).map((file) => [file, parsedFiles[file]])),
    errors,
  };
}


export function createDiffEngine() {
  return {
    getFileReviewData,
    getFileReviewDataBatch,
    getChangesTree,
    getChangesStats,
    stageSelection,
    stageHunk,
  };
}
