import { promises as fs } from 'fs';
import { GitDomainError } from './git-types.js';
import type {
  BatchFileReviewOptions,
  BatchReviewResult,
  ChangeEntry,
  ChangeFacet,
  CompatibleTreeFields,
  DiffHunkMetadata,
  DiffOp,
  DiffStats,
  FileReviewOptions,
  GitChangeKind,
  HunkHeaderResult,
  HunkLineCounts,
  NumstatMap,
  ParsedPatch,
  ParsedUnifiedPatch,
  PatchHunk,
  PorcelainStatusEntry,
  ProjectOptions,
  ReviewTruncation,
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
  runGitWithStdin,
} from './run.js';

// Parses a unified diff string into structured diff ops and hunk metadata.
// Each op describes a contiguous range of equal/insert/delete/skip lines
// with before/after line number ranges.
function parseUnifiedPatchToOps(diffText: string, _contextLines: number): ParsedUnifiedPatch {
  const lines = diffText.split('\n');
  const diffOps: DiffOp[] = [];
  const hunks: DiffHunkMetadata[] = [];
  let lineIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
    if (!hunkMatch) continue;

    const oldStart = parseInt(hunkMatch[1], 10);
    const oldLines = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1;
    const newStart = parseInt(hunkMatch[3], 10);
    const newLines = hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1;
    const header = line;

    const hunkStartIndex = lineIndex;
    let beforeLine = oldStart;
    let afterLine = newStart;

    // Collect lines belonging to this hunk
    let j = i + 1;
    while (j < lines.length && !lines[j].startsWith('@@') && !lines[j].startsWith('diff --git')) {
      const dl = lines[j];
      if (dl.startsWith('-')) {
        diffOps.push({
          type: 'delete',
          before: [beforeLine, beforeLine],
          after: [afterLine, afterLine],
        });
        beforeLine++;
        lineIndex++;
      } else if (dl.startsWith('+')) {
        diffOps.push({
          type: 'insert',
          before: [beforeLine, beforeLine],
          after: [afterLine, afterLine],
        });
        afterLine++;
        lineIndex++;
      } else if (dl.startsWith(' ') || dl === '') {
        diffOps.push({
          type: 'equal',
          before: [beforeLine, beforeLine],
          after: [afterLine, afterLine],
        });
        beforeLine++;
        afterLine++;
        lineIndex++;
      } else if (dl.startsWith('\\')) {
        // "\ No newline at end of file" -- skip
        j++;
        continue;
      }
      j++;
    }

    hunks.push({
      id: `hunk-${hunks.length}`,
      header,
      oldStart,
      oldLines,
      newStart,
      newLines,
      lineStartIndex: hunkStartIndex,
      lineEndIndex: lineIndex - 1,
    });

    i = j - 1;
  }

  return { diffOps, hunks };
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

function buildFacet(status: string, stats?: DiffStats, originalPath?: string): ChangeFacet | undefined {
  if (!status || status === ' ' || status === '!') return undefined;
  return {
    status,
    changeKind: changeKindForStatus(status),
    stats: stats || { additions: 0, deletions: 0 },
    ...(originalPath ? { originalPath } : {}),
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
  };
}

function buildChangeEntry(
  statusEntry: PorcelainStatusEntry,
  workingStats: NumstatMap,
  cachedStats: NumstatMap,
): ChangeEntry {
  const filePath = statusEntry.path.replace(/\/+$/g, '');
  const stagedFacet = hasIndexChange(statusEntry.indexStatus)
    ? buildFacet(statusEntry.indexStatus, cachedStats[filePath], statusEntry.originalPath)
    : undefined;
  const unstagedStatus = statusEntry.indexStatus === '?' ? '?' : statusEntry.workTreeStatus;
  const unstagedFacet = hasWorkTreeChange(unstagedStatus)
    ? buildFacet(unstagedStatus, workingStats[filePath], statusEntry.originalPath)
    : undefined;

  return {
    path: filePath,
    indexStatus: statusEntry.indexStatus,
    workTreeStatus: statusEntry.workTreeStatus,
    stagedFacet,
    unstagedFacet,
  };
}

function buildFullFileAddedPatch(contentAfter: string): string {
  const lines = contentAfter.split('\n');
  return `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}`;
}

function buildFullFileDeletedPatch(contentBefore: string | null): string {
  const lines = (contentBefore || '').split('\n');
  return `@@ -1,${lines.length} +0,0 @@\n${lines.map((line) => `-${line}`).join('\n')}`;
}

function maybeTruncateReviewContent(contentBefore: string | null, contentAfter: string | null): ReviewTruncation {
  const MAX_CONTENT_SIZE = 500_000;
  if (
    (contentBefore && contentBefore.length > MAX_CONTENT_SIZE) ||
    (contentAfter && contentAfter.length > MAX_CONTENT_SIZE)
  ) {
    return {
      truncated: true,
      truncatedReason: 'File exceeds 500KB display limit',
    };
  }
  return { truncated: false, truncatedReason: undefined };
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


async function getSingleFileStatus(projectPath: string, file: string): Promise<PorcelainStatusEntry> {
  const { stdout } = await runGit(projectPath, ['status', '--porcelain=v1', '-z', '--', file]);
  const [entry] = parsePorcelainV1Z(stdout);
  return entry || { path: file, indexStatus: ' ', workTreeStatus: ' ' };
}

async function readHeadBlob(projectPath: string, file: string): Promise<string> {
  try {
    const { stdout } = await runGit(projectPath, ['show', `HEAD:${file}`]);
    return stdout;
  } catch {
    return '';
  }
}

async function readIndexBlob(projectPath: string, file: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(projectPath, ['show', `:${file}`]);
    return stdout;
  } catch {
    return null;
  }
}

async function getFileReviewData({ projectPath, file, mode = 'working', context = 5 }: FileReviewOptions): Promise<unknown> {
  await assertGitRepository(projectPath);

  const effectiveMode = mode === 'staged' ? 'staged' : 'working';
  const statusEntry = await getSingleFileStatus(projectPath, file);
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
        return {
          path: file,
          mode: effectiveMode,
          indexStatus: statusEntry.indexStatus,
          workTreeStatus: statusEntry.workTreeStatus,
          isBinary: false,
          truncated: false,
          contentBefore: null,
          contentAfter: null,
          diffOps: [],
          hunks: [],
          error: 'Directory diff is not supported. Provide a file path.',
        };
      }
      if (await isBinaryFile(filePath)) {
        return {
          path: file,
          mode: effectiveMode,
          indexStatus: statusEntry.indexStatus,
          workTreeStatus: statusEntry.workTreeStatus,
          isBinary: true,
          truncated: false,
          contentBefore: null,
          contentAfter: null,
          diffOps: [],
          hunks: [],
        };
      }
    } catch {
      filePath = null;
    }
  }

  let contentBefore: string | null = null;
  let contentAfter: string | null = null;
  let diffText = '';

  if (effectiveMode === 'staged') {
    contentBefore = await readHeadBlob(projectPath, file);
    contentAfter = isDeleted ? null : await readIndexBlob(projectPath, file);
    if (contentAfter === null && !isDeleted) contentAfter = contentBefore;
    try {
      const { stdout } = await runGit(projectPath, ['diff', '--cached', `-U${context}`, '--', file]);
      diffText = stdout;
    } catch {
      diffText = '';
    }
  } else if (isUntracked) {
    if (!filePath) filePath = resolvePathWithinProject(projectPath, file);
    contentBefore = null;
    contentAfter = await fs.readFile(filePath, 'utf-8');
    diffText = buildFullFileAddedPatch(contentAfter);
  } else if (isDeleted) {
    contentBefore = await readIndexBlob(projectPath, file);
    if (contentBefore === null) contentBefore = await readHeadBlob(projectPath, file);
    contentAfter = null;
    try {
      const { stdout } = await runGit(projectPath, ['diff', `-U${context}`, '--', file]);
      diffText = stdout || buildFullFileDeletedPatch(contentBefore);
    } catch {
      diffText = buildFullFileDeletedPatch(contentBefore);
    }
  } else {
    if (!filePath) filePath = resolvePathWithinProject(projectPath, file);
    contentBefore = await readIndexBlob(projectPath, file);
    if (contentBefore === null) contentBefore = await readHeadBlob(projectPath, file);
    contentAfter = await fs.readFile(filePath, 'utf-8');
    try {
      const { stdout } = await runGit(projectPath, ['diff', `-U${context}`, '--', file]);
      diffText = stdout;
    } catch {
      diffText = '';
    }
  }

  const truncatedResult = maybeTruncateReviewContent(contentBefore, contentAfter);
  const { diffOps, hunks } = parseUnifiedPatchToOps(diffText, context);

  return {
    path: file,
    mode: effectiveMode,
    indexStatus: statusEntry.indexStatus,
    workTreeStatus: statusEntry.workTreeStatus,
    isBinary: false,
    truncated: truncatedResult.truncated,
    truncatedReason: truncatedResult.truncatedReason,
    contentBefore: truncatedResult.truncated ? null : contentBefore,
    contentAfter: truncatedResult.truncated ? null : contentAfter,
    diffOps,
    hunks,
  };
}

async function getChangesTree({ projectPath }: ProjectOptions): Promise<unknown> {
  await assertGitRepository(projectPath);

  let hasCommits = true;
  try {
    await runGit(projectPath, ['rev-parse', 'HEAD']);
  } catch {
    hasCommits = false;
  }

  const { stdout: statusOutput } = await runGit(projectPath, ['status', '--porcelain=v1', '-z', '-uall']);
  if (!statusOutput.trim()) {
    return { root: [], hasCommits };
  }

  let workingStats: NumstatMap = {};
  let cachedStats: NumstatMap = {};
  try {
    const { stdout } = await runGit(projectPath, ['diff', '--numstat']);
    workingStats = parseNumstatBulk(stdout);
  } catch { /* empty working tree diff */ }
  try {
    const { stdout } = await runGit(projectPath, ['diff', '--cached', '--numstat']);
    cachedStats = parseNumstatBulk(stdout);
  } catch { /* no cached changes */ }

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

  function mapToArray(map: TreeMap): TreeNode[] {
    const result: TreeNode[] = [];
    for (const [, node] of map) {
      const entry: TreeNode = { ...node };
      if (entry.children instanceof Map) {
        entry.children = mapToArray(entry.children);
      }
      result.push(entry);
    }
    result.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return result;
  }

  return { root: mapToArray(rootMap), hasCommits };
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
  mode,
  context,
}: BatchFileReviewOptions): Promise<BatchReviewResult> {
  const result: BatchReviewResult = { files: {}, errors: {} };
  await mapWithConcurrency(files, 4, async (file) => {
    try {
      result.files[file] = await getFileReviewData({ projectPath, file, mode, context });
    } catch (error) {
      result.errors[file] = error instanceof Error ? error.message : String(error);
    }
  });
  return result;
}


export function createDiffEngine() {
  return {
    getFileReviewData,
    getFileReviewDataBatch,
    getChangesTree,
    stageSelection,
    stageHunk,
  };
}
