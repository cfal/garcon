import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import {
  GIT_REVIEW_DOCUMENT_LIMITS,
  GIT_WORKBENCH_FINGERPRINT_VERSION,
} from './types.js';
import { GitDomainError } from './git-types.js';
import type {
  ChangeEntry,
  ChangeFacet,
  ChangesTreeResult,
  CompatibleTreeFields,
  DiffStats,
  GitReviewDocumentSummary,
  GitReviewFileBodiesResponse,
  GitReviewFileBody,
  GitReviewFileSummary,
  GitWorkbenchFingerprintOptions,
  GitWorkbenchFingerprintResponse,
  GitWorkbenchSnapshotOptions,
  GitWorkbenchSnapshotResponse,
  GitReviewMode,
  HunkHeaderResult,
  HunkLineCounts,
  NumstatMap,
  ParsedPatch,
  PatchHunk,
  PorcelainStatusEntry,
  ReviewFileBodiesOptions,
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
import { parseNumstatZ } from './diff-file-list.js';
import {
  categoryForPath,
  errorFileBody,
  limitedFileBody,
  limitedRenderedPatch,
} from './rendered-diff.js';
import {
  changeKindForStatus,
  hasIndexChange,
  hasWorkTreeChange,
  parsePorcelainV1Z,
} from './porcelain-status.js';
import { chunkGitPathspecs } from './pathspecs.js';

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
  return buildTreeFromChangeEntries(entries, hasCommits, statsState);
}

function buildTreeFromStatusEntries(
  statusEntries: PorcelainStatusEntry[],
  workingStats: NumstatMap,
  cachedStats: NumstatMap,
  hasCommits: boolean,
  statsState: ChangesTreeResult['statsState'],
): ChangesTreeResult {
  const entries = statusEntries
    .map((entry) => buildChangeEntry(entry, workingStats, cachedStats))
    .filter((entry) => entry.path);
  return buildTreeFromChangeEntries(entries, hasCommits, statsState);
}

function buildTreeFromChangeEntries(
  entries: ChangeEntry[],
  hasCommits: boolean,
  statsState: ChangesTreeResult['statsState'],
): ChangesTreeResult {
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

function hashString(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

async function hashFilePrefix(filePath: string): Promise<string> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(65_536);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex').slice(0, 16);
  } finally {
    await handle.close();
  }
}

async function indexFingerprint(projectPath: string, file: string, signal?: AbortSignal): Promise<string> {
  try {
    const { stdout } = await runGit(projectPath, ['ls-files', '-s', '--', file], { signal });
    return stdout.trim();
  } catch {
    return '';
  }
}

async function headObjectFingerprint(projectPath: string, file: string, signal?: AbortSignal): Promise<string> {
  try {
    const { stdout } = await runGit(projectPath, ['rev-parse', `HEAD:${file}`], { signal });
    return stdout.trim();
  } catch {
    return '';
  }
}

async function worktreeFingerprint(
  projectPath: string,
  file: string,
  options: { includeContentHash?: boolean } = {},
): Promise<string> {
  try {
    const filePath = resolvePathWithinProject(projectPath, file);
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) return `not-file:${stats.size}:${stats.mtimeMs}`;
    const parts: Array<string | number> = [
      'file',
      stats.size,
      Math.trunc(stats.mtimeMs),
    ];
    if (options.includeContentHash) parts.push(await hashFilePrefix(filePath));
    return parts.join(':');
  } catch {
    return 'missing';
  }
}

interface BatchedFingerprintInputs {
  indexEntriesByPath: Map<string, string>;
  headEntriesByPath: Map<string, string>;
}

function parseLsFilesStageZ(output: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const token of output.split('\0')) {
    if (!token) continue;
    const tabIndex = token.indexOf('\t');
    if (tabIndex < 0) continue;
    const filePath = token.slice(tabIndex + 1);
    if (filePath) map.set(filePath, token);
  }
  return map;
}

function parseLsTreeZ(output: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const token of output.split('\0')) {
    if (!token) continue;
    const tabIndex = token.indexOf('\t');
    if (tabIndex < 0) continue;
    const filePath = token.slice(tabIndex + 1);
    const objectId = token.slice(0, tabIndex).split(' ')[2] ?? '';
    if (filePath && objectId) map.set(filePath, objectId);
  }
  return map;
}

function uniqueGitPaths(paths: string[]): string[] {
  return Array.from(new Set(paths.filter(Boolean))).sort();
}

async function loadFingerprintIndexEntries(
  projectPath: string,
  paths: string[],
  signal?: AbortSignal,
): Promise<string[]> {
  const entries: string[] = [];
  for (const chunk of chunkGitPathspecs(paths)) {
    try {
      const { stdout } = await runGit(projectPath, ['ls-files', '-s', '-z', '--', ...chunk], { signal });
      for (const [filePath, entry] of parseLsFilesStageZ(stdout)) {
        entries.push(`${filePath}\x00${entry}`);
      }
    } catch {
      // Status output still captures the changed path. Missing index metadata should not make freshness fail.
    }
  }
  return entries.sort();
}

async function worktreeStatFingerprint(projectPath: string, file: string): Promise<string> {
  try {
    const filePath = resolvePathWithinProject(projectPath, file);
    const stats = await fs.stat(filePath);
    const kind = stats.isFile() ? 'file' : 'not-file';
    return [
      kind,
      file,
      stats.size,
      Math.trunc(stats.mtimeMs),
      Math.trunc(stats.ctimeMs),
    ].join(':');
  } catch {
    return `missing:${file}`;
  }
}

function shouldStatWorktreeForFingerprint(entry: PorcelainStatusEntry): boolean {
  if (entry.workTreeStatus === 'D') return false;
  if (entry.indexStatus === '?' || entry.workTreeStatus === '?') return true;
  return hasWorkTreeChange(entry.workTreeStatus);
}

async function loadFingerprintWorktreeStats(
  projectPath: string,
  entries: PorcelainStatusEntry[],
): Promise<string[]> {
  const paths = uniqueGitPaths(
    entries
      .filter(shouldStatWorktreeForFingerprint)
      .map((entry) => entry.path),
  );
  return (await mapWithConcurrencyResult(
    paths,
    16,
    (filePath) => worktreeStatFingerprint(projectPath, filePath),
  )).sort();
}

interface WorkbenchFingerprintInput {
  projectPath: string;
  repoRoot: string;
  branch: string;
  head: string;
  statusOutput: string;
  workingStatsOutput: string;
  cachedStatsOutput: string;
  unmergedOutput: string;
  statusEntries: PorcelainStatusEntry[];
  signal?: AbortSignal;
}

async function buildWorkbenchFingerprintFromInputs({
  projectPath,
  repoRoot,
  branch,
  head,
  statusOutput,
  workingStatsOutput,
  cachedStatsOutput,
  unmergedOutput,
  statusEntries,
  signal,
}: WorkbenchFingerprintInput): Promise<{ fingerprint: string; changedPathCount: number }> {
  const changedPaths = uniqueGitPaths(statusEntries.map((entry) => entry.path));
  const [indexEntryTokens, worktreeStatTokens] = await Promise.all([
    loadFingerprintIndexEntries(projectPath, changedPaths, signal),
    loadFingerprintWorktreeStats(projectPath, statusEntries),
  ]);

  const fingerprint = `v${GIT_WORKBENCH_FINGERPRINT_VERSION}:${hashString([
    `git-workbench-fingerprint-v${GIT_WORKBENCH_FINGERPRINT_VERSION}`,
    projectPath,
    repoRoot,
    branch,
    head,
    statusOutput,
    workingStatsOutput,
    cachedStatsOutput,
    unmergedOutput,
    ...indexEntryTokens,
    ...worktreeStatTokens,
  ].join('\x1f'))}`;

  return { fingerprint, changedPathCount: changedPaths.length };
}

async function loadBatchedFingerprintInputs(
  projectPath: string,
  files: TreeNode[],
  signal?: AbortSignal,
): Promise<BatchedFingerprintInputs> {
  const paths = files.map((file) => file.path);
  const indexEntriesByPath = new Map<string, string>();
  const headEntriesByPath = new Map<string, string>();
  for (const chunk of chunkGitPathspecs(paths)) {
    const [indexResult, headResult] = await Promise.allSettled([
      runGit(projectPath, ['ls-files', '-s', '-z', '--', ...chunk], { signal }),
      runGit(projectPath, ['ls-tree', '-rz', 'HEAD', '--', ...chunk], { signal }),
    ]);
    if (indexResult.status === 'fulfilled') {
      for (const [filePath, entry] of parseLsFilesStageZ(indexResult.value.stdout)) {
        indexEntriesByPath.set(filePath, entry);
      }
    }
    if (headResult.status === 'fulfilled') {
      for (const [filePath, entry] of parseLsTreeZ(headResult.value.stdout)) {
        headEntriesByPath.set(filePath, entry);
      }
    }
  }
  return { indexEntriesByPath, headEntriesByPath };
}

async function buildSummaryBodyFingerprint(
  projectPath: string,
  file: string,
  statusEntry: PorcelainStatusEntry,
  mode: GitReviewMode,
  inputs: BatchedFingerprintInputs,
): Promise<string> {
  const base = [
    mode,
    file,
    statusEntry.originalPath ?? '',
    statusEntry.indexStatus,
    statusEntry.workTreeStatus,
  ];
  if (mode === 'staged') {
    base.push(inputs.indexEntriesByPath.get(file) ?? '');
  } else if (statusEntry.workTreeStatus === 'D') {
    base.push(inputs.indexEntriesByPath.get(file) ?? '');
    base.push(inputs.headEntriesByPath.get(file) ?? '');
  } else {
    base.push(await worktreeFingerprint(projectPath, file, { includeContentHash: true }));
  }
  return hashString(base.join('\x1f'));
}

async function buildBodyFingerprint(
  projectPath: string,
  file: string,
  statusEntry: PorcelainStatusEntry,
  mode: GitReviewMode,
  signal?: AbortSignal,
): Promise<string> {
  const base = [
    mode,
    file,
    statusEntry.originalPath ?? '',
    statusEntry.indexStatus,
    statusEntry.workTreeStatus,
  ];
  if (mode === 'staged') {
    base.push(await indexFingerprint(projectPath, file, signal));
  } else if (statusEntry.workTreeStatus === 'D') {
    base.push(await indexFingerprint(projectPath, file, signal));
    base.push(await headObjectFingerprint(projectPath, file, signal));
  } else {
    base.push(await worktreeFingerprint(projectPath, file, { includeContentHash: true }));
  }
  return hashString(base.join('\x1f'));
}

async function isBinaryWorktreeFile(projectPath: string, file: string): Promise<boolean> {
  try {
    const filePath = resolvePathWithinProject(projectPath, file);
    const stats = await fs.stat(filePath);
    return stats.isFile() && await isBinaryFile(filePath);
  } catch {
    return false;
  }
}

async function isBinaryIndexBlobPrefix(
  projectPath: string,
  file: string,
  signal?: AbortSignal,
): Promise<boolean> {
  let proc: Bun.Subprocess<'ignore', 'pipe', 'ignore'> | null = null;
  try {
    proc = Bun.spawn(['git', 'show', `:${file}`], {
      cwd: projectPath,
      stdout: 'pipe',
      stderr: 'ignore',
      signal,
    });
    const reader = proc.stdout?.getReader();
    if (!reader) {
      await proc.exited.catch(() => {});
      return false;
    }

    const chunks: Buffer[] = [];
    let bytesRead = 0;
    while (bytesRead < 8192) {
      const next = await reader.read();
      if (next.done || !next.value) break;
      const remaining = 8192 - bytesRead;
      const chunk = next.value.byteLength > remaining
        ? next.value.subarray(0, remaining)
        : next.value;
      chunks.push(Buffer.from(chunk));
      bytesRead += chunk.byteLength;
      if (next.value.byteLength > remaining) break;
    }

    if (bytesRead >= 8192) proc.kill();
    await proc.exited.catch(() => {});
    return bytesRead > 0 && Buffer.concat(chunks, bytesRead).includes(0x00);
  } catch {
    proc?.kill();
    return false;
  }
}

async function isSummaryBinaryFile(
  projectPath: string,
  file: string,
  statusEntry: PorcelainStatusEntry,
  mode: GitReviewMode,
  stats: DiffStats,
  signal?: AbortSignal,
): Promise<boolean> {
  if (stats.isBinary) return true;
  const isAmbiguousChange = stats.additions === 0 && stats.deletions === 0;
  if (mode === 'staged') {
    return statusEntry.indexStatus !== 'D' && isAmbiguousChange
      ? isBinaryIndexBlobPrefix(projectPath, file, signal)
      : false;
  }
  if (statusEntry.workTreeStatus === 'D') return false;
  const isUntracked = statusEntry.indexStatus === '?' || statusEntry.workTreeStatus === '?';
  return (isUntracked || isAmbiguousChange) && await isBinaryWorktreeFile(projectPath, file);
}

interface ReviewFileBodyLoadOptions {
  projectPath: string;
  file: string;
  statusEntry: PorcelainStatusEntry;
  mode: GitReviewMode;
  context: number;
  signal?: AbortSignal;
}

async function getReviewFileBody({
  projectPath,
  file,
  statusEntry,
  mode,
  context = 5,
  signal,
}: ReviewFileBodyLoadOptions): Promise<GitReviewFileBody> {
  const effectiveMode = mode === 'staged' ? 'staged' : 'working';
  const bodyFingerprint = await buildBodyFingerprint(projectPath, file, statusEntry, effectiveMode, signal);
  const isUntracked = effectiveMode === 'working' &&
    (statusEntry.indexStatus === '?' || statusEntry.workTreeStatus === '?');
  const isDeleted = effectiveMode === 'staged'
    ? statusEntry.indexStatus === 'D'
    : statusEntry.workTreeStatus === 'D';

  let filePath: string | null = null;
  if (!isDeleted && effectiveMode === 'working') {
    try {
      filePath = resolvePathWithinProject(projectPath, file);
      const stats = await fs.stat(filePath);
      if (stats.isDirectory()) {
        return limitedFileBody(
          file,
          bodyFingerprint,
          'unsupported-file-kind',
          'Directory diff is not supported. Provide a file path.',
        );
      }
      if (await isBinaryFile(filePath)) {
        return limitedFileBody(
          file,
          bodyFingerprint,
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
    const stats = await fs.stat(filePath);
    if (stats.size > GIT_REVIEW_DOCUMENT_LIMITS.maxFilePatchBytes) {
      return limitedFileBody(
        file,
        bodyFingerprint,
        'file-too-many-bytes',
        `File exceeds ${GIT_REVIEW_DOCUMENT_LIMITS.maxFilePatchBytes} byte display limit.`,
      );
    }
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

  return limitedRenderedPatch(file, bodyFingerprint, diffText);
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

function flattenFileNodes(nodes: TreeNode[]): TreeNode[] {
  const files: TreeNode[] = [];
  for (const node of nodes) {
    if (node.kind === 'file') {
      files.push(node);
      continue;
    }
    if (Array.isArray(node.children)) files.push(...flattenFileNodes(node.children));
  }
  return files;
}

function facetForReviewMode(node: TreeNode, mode: GitReviewMode): ChangeFacet | undefined {
  return mode === 'staged' ? node.stagedFacet : node.unstagedFacet;
}

async function summarizeReviewFile(
  projectPath: string,
  node: TreeNode,
  mode: GitReviewMode,
  fingerprintInputs?: BatchedFingerprintInputs,
  signal?: AbortSignal,
): Promise<GitReviewFileSummary | null> {
  const facet = facetForReviewMode(node, mode);
  if (!facet) return null;

  const statusEntry: PorcelainStatusEntry = {
    path: node.path,
    originalPath: facet.originalPath,
    indexStatus: node.indexStatus ?? ' ',
    workTreeStatus: node.workTreeStatus ?? ' ',
  };
  const stats = facet.stats ?? { additions: 0, deletions: 0 };
  const category = facet.category ?? node.category ?? categoryForPath(node.path);
  const isBinary = await isSummaryBinaryFile(projectPath, node.path, statusEntry, mode, stats, signal);
  const estimatedRows = Math.max(1, stats.additions + stats.deletions + 1);
  const isTooLarge = !isBinary && estimatedRows > GIT_REVIEW_DOCUMENT_LIMITS.maxFileRows;
  const bodyFingerprint = fingerprintInputs
    ? await buildSummaryBodyFingerprint(projectPath, node.path, statusEntry, mode, fingerprintInputs)
    : await buildBodyFingerprint(projectPath, node.path, statusEntry, mode, signal);

  return {
    path: node.path,
    ...(facet.originalPath ? { originalPath: facet.originalPath } : {}),
    indexStatus: statusEntry.indexStatus,
    workTreeStatus: statusEntry.workTreeStatus,
    category: isBinary ? 'binary' : isTooLarge ? 'large' : category,
    additions: stats.additions,
    deletions: stats.deletions,
    estimatedRows,
    bodyState: isBinary ? 'binary' : isTooLarge ? 'too-large' : 'unloaded',
    bodyFingerprint,
    isGenerated: category === 'generated',
    isBinary,
    isTooLarge,
    ...(isBinary ? { limitReason: 'binary' as const, limitMessage: 'Binary diff is not available.' } : {}),
    ...(isTooLarge
      ? {
          limitReason: 'file-too-many-rows' as const,
          limitMessage: `Diff exceeds ${GIT_REVIEW_DOCUMENT_LIMITS.maxFileRows} estimated rows.`,
        }
      : {}),
  };
}

function reviewDocumentId(
  projectPath: string,
  mode: GitReviewMode,
  context: number,
  files: GitReviewFileSummary[],
): string {
  return hashString([
    projectPath,
    mode,
    context,
    ...files.map((file) => `${file.path}:${file.bodyFingerprint}`),
  ].join('\x1f'));
}

async function buildReviewDocumentSummaryFromTree({
  projectPath,
  mode,
  context,
  treeRoot,
  signal,
}: {
  projectPath: string;
  mode: GitReviewMode;
  context: number;
  treeRoot: TreeNode[];
  signal?: AbortSignal;
}): Promise<GitReviewDocumentSummary> {
  const effectiveMode = mode === 'staged' ? 'staged' : 'working';
  const allFiles = flattenFileNodes(treeRoot);
  const relevantFiles = allFiles.filter((node) => Boolean(facetForReviewMode(node, effectiveMode)));
  const limitedFiles = relevantFiles.slice(0, GIT_REVIEW_DOCUMENT_LIMITS.maxSummaryFiles);
  const fingerprintInputs = await loadBatchedFingerprintInputs(projectPath, limitedFiles, signal);
  const summaries = (await mapWithConcurrencyResult(
    limitedFiles,
    GIT_REVIEW_DOCUMENT_LIMITS.bodyConcurrency,
    (node) => summarizeReviewFile(projectPath, node, effectiveMode, fingerprintInputs, signal),
  )).filter((summary): summary is GitReviewFileSummary => Boolean(summary));

  const documentId = reviewDocumentId(projectPath, effectiveMode, context, summaries);
  return {
    documentId,
    project: projectPath,
    mode: effectiveMode,
    context,
    files: summaries,
    limits: GIT_REVIEW_DOCUMENT_LIMITS,
    ...(relevantFiles.length > limitedFiles.length
      ? {
          collectionLimit: {
            reason: 'collection-too-many-files' as const,
            message: `Showing ${limitedFiles.length} of ${relevantFiles.length} changed files.`,
            visibleFiles: limitedFiles.length,
            totalFilesKnown: relevantFiles.length,
          },
        }
      : {}),
  };
}

function chooseSelectedFile(files: GitReviewFileSummary[], selectedFile?: string | null): string | null {
  if (selectedFile && files.some((file) => file.path === selectedFile)) return selectedFile;
  return files[0]?.path ?? null;
}

function chooseFirstBodyCandidates(
  files: GitReviewFileSummary[],
  selectedFile: string | null,
  count: number,
): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  function add(filePath: string | null): void {
    if (!filePath || seen.has(filePath) || candidates.length >= count) return;
    const file = files.find((candidate) => candidate.path === filePath);
    if (!file || file.bodyState !== 'unloaded') return;
    seen.add(filePath);
    candidates.push(filePath);
  }
  add(selectedFile);
  for (const file of files) add(file.path);
  return candidates;
}

function notRepositorySnapshot(projectPath: string): GitWorkbenchSnapshotResponse {
  return {
    status: 'not-git-repository',
    project: projectPath,
    target: null,
    tree: null,
    reviewSummary: null,
    selectedFile: null,
    firstBodyCandidates: [],
    message: 'Git is not initialized in this directory.',
  };
}

function notRepositoryFingerprint(projectPath: string): GitWorkbenchFingerprintResponse {
  return {
    status: 'not-git-repository',
    project: projectPath,
    fingerprintVersion: GIT_WORKBENCH_FINGERPRINT_VERSION,
    fingerprint: null,
    message: 'Git is not initialized in this directory.',
  };
}

async function getWorkbenchFingerprint({
  projectPath,
  trace,
  signal,
}: GitWorkbenchFingerprintOptions): Promise<GitWorkbenchFingerprintResponse> {
  try {
    await fs.access(projectPath);
  } catch {
    return notRepositoryFingerprint(projectPath);
  }

  const [
    repoRootResult,
    branchResult,
    headResult,
    statusResult,
    workingStatsResult,
    cachedStatsResult,
    unmergedResult,
  ] = await Promise.allSettled([
    runGitTraced(projectPath, ['rev-parse', '--show-toplevel'], trace, { signal }),
    runGitTraced(projectPath, ['branch', '--show-current'], trace, { signal }),
    runGitTraced(projectPath, ['rev-parse', 'HEAD'], trace, { signal }),
    runGitTraced(projectPath, ['status', '--porcelain=v1', '-z', '-uall'], trace, { signal }),
    runGitTraced(projectPath, ['diff', '--numstat', '-z'], trace, { signal }),
    runGitTraced(projectPath, ['diff', '--cached', '--numstat', '-z'], trace, { signal }),
    runGitTraced(projectPath, ['ls-files', '-u', '-z'], trace, { signal }),
  ]);

  if (repoRootResult.status === 'rejected') return notRepositoryFingerprint(projectPath);
  if (statusResult.status === 'rejected') throw statusResult.reason;

  const repoRoot = repoRootResult.value.stdout.trim() || projectPath;
  const branch = branchResult.status === 'fulfilled' ? branchResult.value.stdout.trim() : '';
  const head = headResult.status === 'fulfilled' ? headResult.value.stdout.trim() : '';
  const statusEntries = parsePorcelainV1Z(statusResult.value.stdout);
  const { fingerprint, changedPathCount } = await buildWorkbenchFingerprintFromInputs({
    projectPath,
    repoRoot,
    branch,
    head,
    statusOutput: statusResult.value.stdout,
    workingStatsOutput: workingStatsResult.status === 'fulfilled' ? workingStatsResult.value.stdout : '',
    cachedStatsOutput: cachedStatsResult.status === 'fulfilled' ? cachedStatsResult.value.stdout : '',
    unmergedOutput: unmergedResult.status === 'fulfilled' ? unmergedResult.value.stdout : '',
    statusEntries,
    signal,
  });

  return {
    status: 'ready',
    project: projectPath,
    fingerprintVersion: GIT_WORKBENCH_FINGERPRINT_VERSION,
    fingerprint,
    changedPathCount,
  };
}

async function getWorkbenchSnapshot({
  projectPath,
  mode,
  context,
  selectedFile,
  bodyCandidateCount = 8,
  trace,
  signal,
}: GitWorkbenchSnapshotOptions): Promise<GitWorkbenchSnapshotResponse> {
  try {
    await fs.access(projectPath);
  } catch {
    return notRepositorySnapshot(projectPath);
  }

  const [
    repoRootResult,
    branchResult,
    headResult,
    statusResult,
    workingStatsResult,
    cachedStatsResult,
    unmergedResult,
  ] = await Promise.allSettled([
    runGitTraced(projectPath, ['rev-parse', '--show-toplevel'], trace, { signal }),
    runGitTraced(projectPath, ['branch', '--show-current'], trace, { signal }),
    runGitTraced(projectPath, ['rev-parse', 'HEAD'], trace, { signal }),
    runGitTraced(projectPath, ['status', '--porcelain=v1', '-z', '-uall'], trace, { signal }),
    runGitTraced(projectPath, ['diff', '--numstat', '-z'], trace, { signal }),
    runGitTraced(projectPath, ['diff', '--cached', '--numstat', '-z'], trace, { signal }),
    runGitTraced(projectPath, ['ls-files', '-u', '-z'], trace, { signal }),
  ]);

  if (repoRootResult.status === 'rejected') return notRepositorySnapshot(projectPath);
  if (statusResult.status === 'rejected') throw statusResult.reason;

  const effectiveMode = mode === 'staged' ? 'staged' : 'working';
  const repoRoot = repoRootResult.value.stdout.trim() || projectPath;
  const branch = branchResult.status === 'fulfilled' ? branchResult.value.stdout.trim() : '';
  const head = headResult.status === 'fulfilled' ? headResult.value.stdout.trim() : '';
  const hasCommits = headResult.status === 'fulfilled';
  const statusEntries = parsePorcelainV1Z(statusResult.value.stdout);
  const workingStats = workingStatsResult.status === 'fulfilled'
    ? parseNumstatZ(workingStatsResult.value.stdout)
    : {};
  const cachedStats = cachedStatsResult.status === 'fulfilled'
    ? parseNumstatZ(cachedStatsResult.value.stdout)
    : {};
  const tree = buildTreeFromStatusEntries(statusEntries, workingStats, cachedStats, hasCommits, 'loaded');
  const reviewSummary = await buildReviewDocumentSummaryFromTree({
    projectPath,
    mode: effectiveMode,
    context,
    treeRoot: tree.root,
    signal,
  });
  const { fingerprint } = await buildWorkbenchFingerprintFromInputs({
    projectPath,
    repoRoot,
    branch,
    head,
    statusOutput: statusResult.value.stdout,
    workingStatsOutput: workingStatsResult.status === 'fulfilled' ? workingStatsResult.value.stdout : '',
    cachedStatsOutput: cachedStatsResult.status === 'fulfilled' ? cachedStatsResult.value.stdout : '',
    unmergedOutput: unmergedResult.status === 'fulfilled' ? unmergedResult.value.stdout : '',
    statusEntries,
    signal,
  });
  const selected = chooseSelectedFile(reviewSummary.files, selectedFile);

  return {
    status: 'ready',
    project: projectPath,
    target: {
      projectPath,
      repoRoot,
      worktreePath: repoRoot,
      label: path.basename(projectPath) || projectPath,
      branch,
      source: 'chat-project',
    },
    tree: {
      root: tree.root,
      hasCommits,
      statsState: 'loaded',
    },
    reviewSummary,
    selectedFile: selected,
    firstBodyCandidates: chooseFirstBodyCandidates(
      reviewSummary.files,
      selected,
      Math.max(0, Math.min(bodyCandidateCount, GIT_REVIEW_DOCUMENT_LIMITS.maxBodyBatchFiles)),
    ),
    snapshotId: reviewSummary.documentId,
    workbenchFingerprint: fingerprint,
  };
}

async function getReviewFileBodies({
  projectPath,
  documentId,
  files,
  mode = 'working',
  context = 5,
  signal,
}: ReviewFileBodiesOptions): Promise<GitReviewFileBodiesResponse> {
  await assertGitRepository(projectPath);

  const effectiveMode = mode === 'staged' ? 'staged' : 'working';
  const statusByPath = await getStatusMapForFiles(projectPath, files, signal);
  const parsedFiles: Record<string, GitReviewFileBody> = {};
  const errors: Record<string, string> = {};

  await mapWithConcurrency(files, GIT_REVIEW_DOCUMENT_LIMITS.bodyConcurrency, async (file) => {
    try {
      const statusEntry = statusByPath.get(file) ??
        { path: file, indexStatus: ' ', workTreeStatus: ' ' };
      parsedFiles[file] = await getReviewFileBody({
        projectPath,
        file,
        statusEntry,
        mode: effectiveMode,
        context,
        signal,
      });
    } catch (error) {
      const fingerprint = hashString(`${effectiveMode}:${file}:error`);
      parsedFiles[file] = errorFileBody(file, fingerprint, error instanceof Error ? error.message : String(error));
      errors[file] = error instanceof Error ? error.message : String(error);
    }
  });

  return {
    documentId,
    files: Object.fromEntries(files.filter((file) => parsedFiles[file]).map((file) => [file, parsedFiles[file]])),
    errors,
  };
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

async function mapWithConcurrencyResult<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  await mapWithConcurrency(
    items.map((item, index) => ({ item, index })),
    limit,
    async ({ item, index }) => {
      results[index] = await worker(item, index);
    },
  );
  return results;
}

export function createDiffEngine() {
  return {
    getWorkbenchSnapshot,
    getWorkbenchFingerprint,
    getReviewFileBodies,
    stageSelection,
    stageHunk,
  };
}
