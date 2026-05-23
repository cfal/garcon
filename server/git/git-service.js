import path from 'path';
import { promises as fs } from 'fs';
import { GitDomainError } from './git-types.js';

const GIT_LOCK_RETRY_DELAY_MS = 100;
const GIT_LOCK_MAX_RETRIES = 50;

// Returns true when stderr indicates a git index.lock contention error.
function isLockError(stderr) {
  const lower = stderr.toLowerCase();
  return lower.includes('index.lock') || lower.includes('unable to create') && lower.includes('.lock');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Spawns a git subprocess and returns stdout/stderr on success.
// Retries transparently when the index.lock is held by another process.
async function runGit(cwd, args) {
  for (let attempt = 0; ; attempt++) {
    const proc = Bun.spawn(['git', ...args], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      proc.stdout.text(),
      proc.stderr.text(),
      proc.exited,
    ]);
    if (exitCode === 0) return { stdout, stderr };

    if (isLockError(stderr) && attempt < GIT_LOCK_MAX_RETRIES) {
      await sleep(GIT_LOCK_RETRY_DELAY_MS);
      continue;
    }

    const error = new Error(`git ${args[0]} failed (exit ${exitCode}): ${stderr.trim()}`);
    error.code = exitCode;
    error.stdout = stdout;
    error.stderr = stderr;
    throw error;
  }
}

// Spawns a git subprocess that reads from stdin (e.g. git apply).
// Retries transparently on index.lock contention.
async function runGitWithStdin(cwd, args, input) {
  for (let attempt = 0; ; attempt++) {
    const proc = Bun.spawn(['git', ...args], {
      cwd,
      stdin: new Blob([input]),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stderr, exitCode] = await Promise.all([
      proc.stderr.text(),
      proc.exited,
    ]);
    if (exitCode === 0) return;

    if (isLockError(stderr) && attempt < GIT_LOCK_MAX_RETRIES) {
      await sleep(GIT_LOCK_RETRY_DELAY_MS);
      continue;
    }

    throw new Error(`git apply failed: ${stderr.trim()}`);
  }
}

// Detects binary files by checking for null bytes in the first 8KB.
// This is the same heuristic Git uses in its buffer_is_binary() function.
async function isBinaryFile(filePath) {
  try {
    const fileHandle = await fs.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(8192);
      const { bytesRead } = await fileHandle.read(buf, 0, 8192, 0);
      return bytesRead > 0 && buf.subarray(0, bytesRead).includes(0x00);
    } finally {
      await fileHandle.close();
    }
  } catch {
    return false;
  }
}

// Strips git diff metadata headers, keeping only hunk content starting from @@ markers.
function stripDiffHeaders(diff) {
  if (!diff) return '';
  if (diff.startsWith('@@')) return diff;
  const hunkStart = diff.indexOf('\n@@');
  return hunkStart === -1 ? diff : diff.substring(hunkStart + 1);
}

// Asserts that the given path is an accessible git working tree.
// Throws on failure with a descriptive error message.
async function assertGitRepository(projectPath) {
  try {
    await fs.access(projectPath);
  } catch {
    throw new Error(`Unable to access project directory: ${projectPath}`);
  }

  let stdout;
  try {
    ({ stdout } = await runGit(projectPath, ['rev-parse', '--is-inside-work-tree']));
  } catch {
    throw new Error('Git is not initialized in this directory. Initialize a repository with "git init" before using source control actions.');
  }

  if (stdout.trim() !== 'true') {
    throw new Error('The target path exists but is not inside a Git working tree.');
  }
}

// Checks whether a file is untracked (status `??`) via git status --porcelain.
async function isFileUntracked(projectPath, file) {
  try {
    const { stdout } = await runGit(projectPath, ['status', '--porcelain', '--', file]);
    return stdout.trimStart().startsWith('??');
  } catch {
    return false;
  }
}

// Resolves a file path within a project root, guarding against path traversal.
function resolvePathWithinProject(projectPath, file) {
  const resolvedRoot = path.resolve(projectPath);
  const resolvedFile = path.resolve(resolvedRoot, file);
  const normalizedRoot = `${resolvedRoot}${path.sep}`;
  if (!resolvedFile.startsWith(normalizedRoot) && resolvedFile !== resolvedRoot) {
    throw new Error('The requested file path resolves outside the project root.');
  }
  return resolvedFile;
}

const DEFAULT_COMMIT_PROMPT = `Write a high-quality Conventional Commit message based on the staged changes.

Strict output rules:
- Return plain text only. Do not include markdown, code fences, labels, or commentary.
- First line must follow: type(scope): subject
- Allowed types: feat, fix, docs, style, refactor, perf, test, build, ci, chore
- Subject must be imperative, specific, and 50 characters or fewer
- Add a body only when it improves clarity; wrap body lines to 72 characters or fewer

Content guidance:
- Prioritize user-visible behavior changes
- Include critical technical context when behavior changes depend on it
- Reflect both additions and removals when relevant
- Avoid vague subjects such as "update files" or "misc changes"

Changed files:
{{files}}

Diff excerpt:
{{diff}}

Return only the commit message now.`;

const COMMIT_MESSAGE_ERROR_MAP = Object.freeze({
  COMMIT_MESSAGE_NO_STAGED_FILES: { status: 400, errorCode: 'commit_message_no_staged_files' },
  COMMIT_MESSAGE_AGENT_AUTH_REQUIRED: { status: 401, errorCode: 'commit_message_agent_auth_required' },
  COMMIT_MESSAGE_RATE_LIMITED: { status: 429, errorCode: 'commit_message_rate_limited' },
  COMMIT_MESSAGE_AGENT_UNAVAILABLE: { status: 503, errorCode: 'commit_message_agent_unavailable' },
  COMMIT_MESSAGE_TIMEOUT: { status: 504, errorCode: 'commit_message_timeout' },
  COMMIT_MESSAGE_EMPTY_RESPONSE: { status: 502, errorCode: 'commit_message_empty_response' },
  COMMIT_MESSAGE_INVALID_RESPONSE: { status: 502, errorCode: 'commit_message_invalid_response' },
  COMMIT_MESSAGE_GENERATION_FAILED: { status: 500, errorCode: 'commit_message_generation_failed' },
});

function classifyCommitMessageAgentError(error) {
  const message = String(error?.message || '').toLowerCase();
  if (
    message.includes('401')
    || message.includes('unauthorized')
    || message.includes('forbidden')
    || message.includes('auth')
    || message.includes('login')
    || message.includes('api key')
  ) {
    return 'COMMIT_MESSAGE_AGENT_AUTH_REQUIRED';
  }
  if (
    message.includes('429')
    || message.includes('rate limit')
    || message.includes('quota')
    || message.includes('too many requests')
  ) {
    return 'COMMIT_MESSAGE_RATE_LIMITED';
  }
  if (
    message.includes('timed out')
    || message.includes('timeout')
    || message.includes('deadline')
    || message.includes('etimedout')
  ) {
    return 'COMMIT_MESSAGE_TIMEOUT';
  }
  if (
    message.includes('service unavailable')
    || message.includes('unavailable')
    || message.includes('econnrefused')
    || message.includes('enotfound')
    || message.includes('network')
    || message.includes('failed to create opencode session')
  ) {
    return 'COMMIT_MESSAGE_AGENT_UNAVAILABLE';
  }
  return 'COMMIT_MESSAGE_GENERATION_FAILED';
}

// Generates a conventional commit message using the configured agent.
// When customPrompt is non-empty, it is used as the template with
// {{files}} and {{diff}} placeholders substituted in.
async function generateCommitMessage(files, diffContext, agentId, projectPath, runSingleQueryFn, options = {}) {
  const filesList = files.map((f) => `- ${f}`).join('\n');
  const diffExcerpt = diffContext.substring(0, 4000);
  const { model, apiProviderId, modelEndpointId, modelProtocol, customPrompt } = options;

  let prompt;
  if (customPrompt && customPrompt.trim()) {
    prompt = customPrompt
      .replace(/\{\{files\}\}/g, filesList)
      .replace(/\{\{diff\}\}/g, diffExcerpt);
  } else {
    prompt = DEFAULT_COMMIT_PROMPT
      .replace(/\{\{files\}\}/g, filesList)
      .replace(/\{\{diff\}\}/g, diffExcerpt);
  }

  try {
    const opts = { agentId, cwd: projectPath };
    if (model) opts.model = model;
    if (apiProviderId) opts.apiProviderId = apiProviderId;
    if (modelEndpointId) opts.modelEndpointId = modelEndpointId;
    if (modelProtocol) opts.modelProtocol = modelProtocol;
    const responseText = await runSingleQueryFn(prompt, opts);
    if (!responseText?.trim()) {
      throw new GitDomainError('COMMIT_MESSAGE_EMPTY_RESPONSE', 'Provider returned an empty commit message response.');
    }
    const cleaned = normalizeCommitMessage(responseText);
    if (!cleaned) {
      throw new GitDomainError('COMMIT_MESSAGE_INVALID_RESPONSE', 'Provider returned an invalid commit message format.');
    }
    return cleaned;
  } catch (error) {
    if (error instanceof GitDomainError) throw error;
    console.error('Error generating commit message:', error);
    throw new GitDomainError(
      classifyCommitMessageAgentError(error),
      'Failed to generate commit message.',
    );
  }
}

// Extracts a conventional commit message from AI-generated text by
// stripping fences, markdown headers, and leading non-commit prose.
function normalizeCommitMessage(text) {
  if (!text?.trim()) return '';

  const lines = text.trim().split('\n');
  const cleaned = [];
  let foundCommit = false;

  for (const raw of lines) {
    if (raw.startsWith('```')) continue;
    const line = raw.replace(/^#+\s*/, '');

    if (!foundCommit && /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore)(\(.+?\))?:/.test(line)) {
      foundCommit = true;
    }
    if (foundCommit) cleaned.push(line);
  }

  const result = cleaned.length > 0 ? cleaned : lines.filter(l => !l.startsWith('```'));

  if (result.length > 0) {
    result[0] = result[0].replace(/^["']|["']$/g, '');
  }

  return result.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Parses a unified diff string into structured diff ops and hunk metadata.
// Each op describes a contiguous range of equal/insert/delete/skip lines
// with before/after line number ranges.
function parseUnifiedPatchToOps(diffText, contextLines) {
  const lines = diffText.split('\n');
  const diffOps = [];
  const hunks = [];
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
function parseNumstatBulk(numstatOutput) {
  const map = {};
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

function changeKindForStatus(status) {
  return CHANGE_KIND_BY_STATUS[status] || 'modified';
}

function hasIndexChange(status) {
  return status !== ' ' && status !== '?' && status !== '!' && Boolean(status);
}

function hasWorkTreeChange(status) {
  return status !== ' ' && status !== '!' && Boolean(status);
}

function parsePorcelainV1Z(output) {
  const tokens = output.split('\0').filter(Boolean);
  const entries = [];

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

function buildFacet(status, stats, originalPath) {
  if (!status || status === ' ' || status === '!') return undefined;
  return {
    status,
    changeKind: changeKindForStatus(status),
    stats: stats || { additions: 0, deletions: 0 },
    ...(originalPath ? { originalPath } : {}),
  };
}

function compatibleTreeFields(stagedFacet, unstagedFacet) {
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

function buildChangeEntry(statusEntry, workingStats, cachedStats) {
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

function buildFullFileAddedPatch(contentAfter) {
  const lines = contentAfter.split('\n');
  return `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}`;
}

function buildFullFileDeletedPatch(contentBefore) {
  const lines = (contentBefore || '').split('\n');
  return `@@ -1,${lines.length} +0,0 @@\n${lines.map((line) => `-${line}`).join('\n')}`;
}

function maybeTruncateReviewContent(contentBefore, contentAfter) {
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
function simplifyDiffHeader(filePath) {
  return [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
  ];
}

// Strips the trailing empty element that `split('\n')` produces from a
// newline-terminated diff -- without this, the last hunk would contain a
// spurious empty line that corrupts line counts in buildHunkHeader.
function parsePatch(patchText) {
  const allLines = patchText.split('\n');
  // Remove trailing empty string artifact from split (diff always ends with \n)
  if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
    allLines.pop();
  }

  const header = [];
  const hunks = [];
  let current = null;

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
function transformHunkLines(bodyLines, selectedSet, startIndex, reverse) {
  const result = [];
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
function hunkHasChanges(bodyLines) {
  return bodyLines.some(l => l.startsWith('+') || l.startsWith('-'));
}

// Counts old-side and new-side lines in a hunk body. Context lines count
// toward both sides. `\` markers are ignored. This always recomputes from
// the actual body content rather than trusting the original @@ header,
// because transformHunkLines may have changed the line composition.
function countHunkLines(bodyLines) {
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
function buildHunkHeader(rawHeader, bodyLines, startOffset) {
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
function tabDiffArgs(contextLines, file, isUnstage) {
  const ctx = `-U${contextLines}`;
  if (isUnstage) {
    return ['diff', '--cached', ctx, '--', file];
  }
  return ['diff', ctx, '--', file];
}

// Creates the git service with all domain operations. The returned object
// exposes methods that correspond 1:1 with route handlers, plus a
// toHttpError() helper for mapping errors to Response objects at the
// route boundary.
export function createGitService({ agents, classifyGitError }) {

  async function getStatus({ projectPath }) {
    await assertGitRepository(projectPath);

    let branch = 'main';
    let hasCommits = true;
    try {
      const { stdout: branchOutput } = await runGit(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
      branch = branchOutput.trim();
    } catch (error) {
      if (error.message.includes('unknown revision') || error.message.includes('ambiguous argument')) {
        hasCommits = false;
        branch = 'main';
      } else {
        throw error;
      }
    }

    const { stdout: statusOutput } = await runGit(projectPath, ['status', '--porcelain', '-uall']);

    const modified = [];
    const added = [];
    const deleted = [];
    const untracked = [];
    statusOutput.split('\n').forEach((line) => {
      if (!line.trim()) return;
      const status = line.substring(0, 2);
      const file = line.substring(3).trim().replace(/\/+$/g, '');
      if (!file) return;
      if (status === 'M ' || status === ' M' || status === 'MM') {
        modified.push(file);
      } else if (status === 'A ' || status === 'AM') {
        added.push(file);
      } else if (status === 'D ' || status === ' D') {
        deleted.push(file);
      } else if (status === '??') {
        untracked.push(file);
      }
    });

    return { branch, hasCommits, modified, added, deleted, untracked };
  }

  async function getDiff({ projectPath, file }) {
    await assertGitRepository(projectPath);

    const { stdout: statusOutput } = await runGit(projectPath, ['status', '--porcelain', '--', file]);
    const isUntracked = statusOutput.startsWith('??');
    const isDeleted = statusOutput.trim().startsWith('D ') || statusOutput.trim().startsWith(' D');

    let diff;
    if (isUntracked) {
      const filePath = resolvePathWithinProject(projectPath, file);
      const stats = await fs.stat(filePath);
      if (stats.isDirectory()) {
        diff = `--- directory: ${file}`;
      } else {
        const fileContent = await fs.readFile(filePath, 'utf-8');
        const lines = fileContent.split('\n');
        diff = `--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}`;
      }
    } else if (isDeleted) {
      const { stdout: fileContent } = await runGit(projectPath, ['show', `HEAD:${file}`]);
      const lines = fileContent.split('\n');
      diff = `--- a/${file}\n+++ /dev/null\n@@ -1,${lines.length} +0,0 @@\n${lines.map((line) => `-${line}`).join('\n')}`;
    } else {
      const { stdout: unstagedDiff } = await runGit(projectPath, ['diff', '--', file]);
      if (unstagedDiff) {
        diff = stripDiffHeaders(unstagedDiff);
      } else {
        const { stdout: stagedDiff } = await runGit(projectPath, ['diff', '--cached', '--', file]);
        diff = stripDiffHeaders(stagedDiff) || '';
      }
    }

    return { diff };
  }

  async function getFileWithDiff({ projectPath, file }) {
    await assertGitRepository(projectPath);

    const { stdout: statusOutput } = await runGit(projectPath, ['status', '--porcelain', '--', file]);
    const isUntracked = statusOutput.startsWith('??');
    const isDeleted = statusOutput.trim().startsWith('D ') || statusOutput.trim().startsWith(' D');

    let currentContent = '';
    let oldContent = '';

    if (isDeleted) {
      const { stdout: headContent } = await runGit(projectPath, ['show', `HEAD:${file}`]);
      oldContent = headContent;
      currentContent = headContent;
    } else {
      const filePath = resolvePathWithinProject(projectPath, file);
      const stats = await fs.stat(filePath);
      if (stats.isDirectory()) {
        throw new GitDomainError('INVALID_INPUT', 'Cannot generate a line diff for a directory. Select a file instead.');
      }
      currentContent = await fs.readFile(filePath, 'utf-8');
      if (!isUntracked) {
        try {
          const { stdout: headContent } = await runGit(projectPath, ['show', `HEAD:${file}`]);
          oldContent = headContent;
        } catch {
          oldContent = '';
        }
      }
    }

    return { currentContent, oldContent, isDeleted, isUntracked };
  }

  async function initialCommit({ projectPath }) {
    await assertGitRepository(projectPath);

    try {
      await runGit(projectPath, ['rev-parse', 'HEAD']);
      throw new GitDomainError('INVALID_INPUT', 'Initial commit is only available for repositories with no existing commits.');
    } catch (e) {
      if (e instanceof GitDomainError) throw e;
      // Expected: rev-parse fails when there are no commits
    }

    await runGit(projectPath, ['add', '.']);
    const { stdout } = await runGit(projectPath, ['commit', '-m', 'Initial commit']);
    return { success: true, output: stdout, message: 'Initial commit created successfully' };
  }

  async function commit({ projectPath, message, files }) {
    await assertGitRepository(projectPath);
    for (const file of files) {
      await runGit(projectPath, ['add', '--', file]);
    }
    const { stdout } = await runGit(projectPath, ['commit', '-m', message]);
    return { success: true, output: stdout };
  }

  async function getBranches({ projectPath }) {
    await assertGitRepository(projectPath);
    const { stdout } = await runGit(projectPath, ['branch', '-a']);
    const branches = stdout
      .split('\n')
      .map((branch) => branch.trim())
      .filter((branch) => branch && !branch.includes('->'))
      .map((branch) => {
        if (branch.startsWith('* ')) return branch.substring(2);
        if (branch.startsWith('remotes/origin/')) return branch.substring(15);
        return branch;
      })
      .filter((branch, index, self) => self.indexOf(branch) === index);
    return { branches };
  }

  async function checkout({ projectPath, branch }) {
    const { stdout } = await runGit(projectPath, ['checkout', branch]);
    return { success: true, output: stdout };
  }

  async function createBranch({ projectPath, branch }) {
    const { stdout } = await runGit(projectPath, ['checkout', '-b', branch]);
    return { success: true, output: stdout };
  }

  async function getCommits({ projectPath, limit }) {
    await assertGitRepository(projectPath);
    const parsedLimit = Number.parseInt(String(limit), 10);
    const safeLimit = Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, 100)
      : 10;

    const { stdout } = await runGit(projectPath, [
      'log', '--pretty=format:%H|%an|%ae|%ad|%s', '--date=relative', '-n', String(safeLimit),
    ]);

    const commits = stdout
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        const [hash, author, email, date, ...messageParts] = line.split('|');
        return {
          hash,
          author,
          email,
          date,
          message: messageParts.join('|'),
        };
      });

    for (const c of commits) {
      try {
        const { stdout: stats } = await runGit(projectPath, ['show', '--stat', '--format=', c.hash]);
        c.stats = stats.trim().split('\n').pop();
      } catch {
        c.stats = '';
      }
    }

    return { commits };
  }

  async function getCommitDiff({ projectPath, commit: commitHash }) {
    const { stdout } = await runGit(projectPath, ['show', String(commitHash)]);
    return { diff: stdout };
  }

  async function generateCommitMessageForFiles({
    projectPath,
    files,
    agentId,
    model,
    apiProviderId,
    modelEndpointId,
    modelProtocol,
    customPrompt,
  }) {
    if (!Array.isArray(files) || files.length === 0) {
      throw new GitDomainError('COMMIT_MESSAGE_NO_STAGED_FILES', 'No staged files to generate a commit message.');
    }

    // Use --cached to get the staged diff (HEAD vs index). This correctly
    // handles new files, deletions, and partial staging unlike diff HEAD.
    let diffContext = '';
    for (const file of files) {
      try {
        const { stdout } = await runGit(projectPath, ['diff', '--cached', '--', file]);
        if (stdout) {
          diffContext += `\n--- ${file} ---\n${stdout}`;
        }
      } catch (error) {
        console.error(`Error getting diff for ${file}:`, error);
      }
    }

    if (!diffContext.trim()) {
      throw new GitDomainError('COMMIT_MESSAGE_NO_STAGED_FILES', 'No staged changes found for selected files.');
    }

    const message = await generateCommitMessage(
      files,
      diffContext,
      agentId,
      projectPath,
      (prompt, opts) => agents.runSingleQuery(prompt, opts),
      { model, apiProviderId, modelEndpointId, modelProtocol, customPrompt },
    );
    return { message };
  }

  async function getRemoteStatus({ projectPath }) {
    await assertGitRepository(projectPath);

    const { stdout: currentBranch } = await runGit(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = currentBranch.trim();

    let trackingBranch;
    let remoteName;
    try {
      const { stdout } = await runGit(projectPath, ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`]);
      trackingBranch = stdout.trim();
      remoteName = trackingBranch.split('/')[0];
    } catch {
      let hasRemote = false;
      let foundRemoteName = null;
      try {
        const { stdout } = await runGit(projectPath, ['remote']);
        const remotes = stdout.trim().split('\n').filter((r) => r.trim());
        if (remotes.length > 0) {
          hasRemote = true;
          foundRemoteName = remotes.includes('origin') ? 'origin' : remotes[0];
        }
      } catch { }

      return {
        hasRemote,
        hasUpstream: false,
        branch,
        remoteName: foundRemoteName,
        message: 'No remote tracking branch configured',
      };
    }

    const { stdout: countOutput } = await runGit(projectPath, ['rev-list', '--count', '--left-right', `${trackingBranch}...HEAD`]);
    const [behind, ahead] = countOutput.trim().split('\t').map(Number);

    return {
      hasRemote: true,
      hasUpstream: true,
      branch,
      remoteBranch: trackingBranch,
      remoteName,
      ahead: ahead || 0,
      behind: behind || 0,
      isUpToDate: ahead === 0 && behind === 0,
    };
  }

  async function fetch({ projectPath }) {
    await assertGitRepository(projectPath);

    const { stdout: fetchBranch } = await runGit(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = fetchBranch.trim();

    let remoteName = 'origin';
    try {
      const { stdout } = await runGit(projectPath, ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`]);
      remoteName = stdout.trim().split('/')[0];
    } catch {
      console.log('No upstream configured, using origin as fallback');
    }

    const { stdout } = await runGit(projectPath, ['fetch', remoteName]);
    return { success: true, output: stdout || 'Fetch completed successfully', remoteName };
  }

  async function pull({ projectPath }) {
    await assertGitRepository(projectPath);

    const { stdout: pullBranch } = await runGit(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = pullBranch.trim();

    let remoteName = 'origin';
    let remoteBranch = branch;
    try {
      const { stdout } = await runGit(projectPath, ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`]);
      const tracking = stdout.trim();
      remoteName = tracking.split('/')[0];
      remoteBranch = tracking.split('/').slice(1).join('/');
    } catch {
      console.log('No upstream configured, using origin/branch as fallback');
    }

    const { stdout } = await runGit(projectPath, ['pull', remoteName, remoteBranch]);
    return {
      success: true,
      output: stdout || 'Pull completed successfully',
      remoteName,
      remoteBranch,
    };
  }

  // Returns list of configured remotes with their fetch URLs.
  async function getRemotes({ projectPath }) {
    await assertGitRepository(projectPath);

    const { stdout } = await runGit(projectPath, ['remote', '-v']);
    const seen = new Map();
    for (const line of stdout.trim().split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split(/\s+/);
      if (parts.length >= 2 && !seen.has(parts[0])) {
        seen.set(parts[0], { name: parts[0], url: parts[1] });
      }
    }
    return { remotes: Array.from(seen.values()) };
  }

  // Pushes to a specific remote. Never sets upstream tracking.
  async function push({ projectPath, remote, remoteBranch }) {
    await assertGitRepository(projectPath);

    const { stdout: headBranch } = await runGit(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = headBranch.trim();
    const targetRemote = remote || 'origin';
    const targetBranch = remoteBranch || branch;

    const { stdout } = await runGit(projectPath, ['push', targetRemote, `${branch}:${targetBranch}`]);
    return {
      success: true,
      output: stdout || 'Push completed successfully',
      remoteName: targetRemote,
      remoteBranch: targetBranch,
    };
  }

  async function discard({ projectPath, file }) {
    await assertGitRepository(projectPath);

    const { stdout: statusOutput } = await runGit(projectPath, ['status', '--porcelain', '--', file]);
    if (!statusOutput.trim()) {
      throw new GitDomainError('INVALID_INPUT', 'No local working-tree changes were found for this file.');
    }

    const status = statusOutput.substring(0, 2);
    if (status === '??') {
      const filePath = resolvePathWithinProject(projectPath, file);
      const stats = await fs.stat(filePath);
      if (stats.isDirectory()) {
        await fs.rm(filePath, { recursive: true, force: true });
      } else {
        await fs.unlink(filePath);
      }
    } else if (status.includes('M') || status.includes('D')) {
      await runGit(projectPath, ['restore', '--', file]);
    } else if (status.includes('A')) {
      await runGit(projectPath, ['reset', 'HEAD', '--', file]);
    }

    return { success: true, message: `Changes discarded for ${file}` };
  }

  async function deleteUntracked({ projectPath, file }) {
    await assertGitRepository(projectPath);

    const { stdout: statusOutput } = await runGit(projectPath, ['status', '--porcelain', '--', file]);
    if (!statusOutput.trim()) {
      throw new GitDomainError('INVALID_INPUT', 'The file is either tracked already or does not exist on disk.');
    }

    const status = statusOutput.substring(0, 2);
    if (status !== '??') {
      throw new GitDomainError('INVALID_INPUT', 'The file is tracked by Git. Use discard for tracked files.');
    }

    const filePath = resolvePathWithinProject(projectPath, file);
    const stats = await fs.stat(filePath);
    if (stats.isDirectory()) {
      await fs.rm(filePath, { recursive: true, force: true });
      return { success: true, message: `Untracked directory ${file} deleted successfully` };
    }

    await fs.unlink(filePath);
    return { success: true, message: `Untracked file ${file} deleted successfully` };
  }

  async function getSingleFileStatus(projectPath, file) {
    const { stdout } = await runGit(projectPath, ['status', '--porcelain=v1', '-z', '--', file]);
    const [entry] = parsePorcelainV1Z(stdout);
    return entry || { path: file, indexStatus: ' ', workTreeStatus: ' ' };
  }

  async function readHeadBlob(projectPath, file) {
    try {
      const { stdout } = await runGit(projectPath, ['show', `HEAD:${file}`]);
      return stdout;
    } catch {
      return '';
    }
  }

  async function readIndexBlob(projectPath, file) {
    try {
      const { stdout } = await runGit(projectPath, ['show', `:${file}`]);
      return stdout;
    } catch {
      return null;
    }
  }

  async function getFileReviewData({ projectPath, file, mode = 'working', context }) {
    await assertGitRepository(projectPath);

    const effectiveMode = mode === 'staged' ? 'staged' : 'working';
    const statusEntry = await getSingleFileStatus(projectPath, file);
    const isUntracked = effectiveMode === 'working' &&
      (statusEntry.indexStatus === '?' || statusEntry.workTreeStatus === '?');
    const isDeleted = effectiveMode === 'staged'
      ? statusEntry.indexStatus === 'D'
      : statusEntry.workTreeStatus === 'D';

    let filePath = null;
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

    let contentBefore = null;
    let contentAfter = null;
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

  async function getChangesTree({ projectPath }) {
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

    let workingStats = {};
    let cachedStats = {};
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
    const rootMap = new Map();

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
        if (!isLastSegment && node.kind === 'directory') {
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

    function mapToArray(map) {
      const result = [];
      for (const [, node] of map) {
        const entry = { ...node };
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
  async function stageSelection({ projectPath, file, mode, selection, contextLines = 5 }) {
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
  async function stageHunk({ projectPath, file, mode, hunkIndex, contextLines = 5 }) {
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

  // Lightweight git capability probe. Reports whether a path is inside a
  // git repository and, if so, the repository root and current worktree path.
  async function getRepoInfo({ projectPath }) {
    try {
      await fs.access(projectPath);
    } catch {
      return { isGitRepository: false };
    }

    try {
      const { stdout: topLevelOut } = await runGit(projectPath, ['rev-parse', '--show-toplevel']);
      const repoRoot = topLevelOut.trim();

      // --show-toplevel gives the worktree root, which equals projectPath
      // when the user points at a worktree directory directly.
      return {
        isGitRepository: true,
        repoRoot,
        currentWorktreePath: repoRoot,
      };
    } catch {
      return { isGitRepository: false };
    }
  }

  async function getWorktrees({ projectPath }) {
    await assertGitRepository(projectPath);

    const { stdout } = await runGit(projectPath, ['worktree', 'list', '--porcelain']);
    const worktrees = [];
    let current = null;

    for (const line of stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current) worktrees.push(current);
        current = { path: line.substring(9), branch: '', name: '', isCurrent: false, isMain: false, isPathMissing: false };
      } else if (line.startsWith('HEAD ') && current) {
        // HEAD hash, skip
      } else if (line.startsWith('branch ') && current) {
        const ref = line.substring(7);
        current.branch = ref.replace('refs/heads/', '');
        current.name = current.branch;
      } else if (line === 'bare' && current) {
        current.isMain = true;
        current.name = current.name || path.basename(current.path);
      } else if (line === 'detached' && current) {
        current.branch = '(detached)';
        current.name = current.name || path.basename(current.path);
      }
    }
    if (current) worktrees.push(current);

    const resolvedProject = path.resolve(projectPath);
    for (const wt of worktrees) {
      const resolvedWt = path.resolve(wt.path);
      if (resolvedWt === resolvedProject) wt.isCurrent = true;
      if (!wt.name) wt.name = path.basename(wt.path);
      try {
        await fs.access(wt.path);
      } catch {
        wt.isPathMissing = true;
      }
    }
    if (worktrees.length > 0) worktrees[0].isMain = true;

    return { worktrees };
  }

  async function getTargetCandidates({ projectPath }) {
    await assertGitRepository(projectPath);

    const repoInfo = await getRepoInfo({ projectPath });
    const { worktrees } = await getWorktrees({ projectPath });
    const targets = [];
    const seen = new Set();

    function addTarget(target) {
      if (!target.worktreePath || seen.has(target.worktreePath)) return;
      seen.add(target.worktreePath);
      targets.push(target);
    }

    addTarget({
      projectPath,
      repoRoot: repoInfo.repoRoot || projectPath,
      worktreePath: repoInfo.currentWorktreePath || projectPath,
      label: path.basename(projectPath) || projectPath,
      branch: '',
      source: 'chat-project',
      isCurrent: true,
      isMissing: false,
    });

    for (const wt of worktrees) {
      addTarget({
        projectPath: wt.path,
        repoRoot: repoInfo.repoRoot || projectPath,
        worktreePath: wt.path,
        label: `${wt.name || path.basename(wt.path)}${wt.branch ? ` (${wt.branch})` : ''}`,
        branch: wt.branch,
        source: 'worktree',
        isCurrent: wt.isCurrent,
        isMissing: wt.isPathMissing,
      });
    }

    return { targets };
  }

  async function mapWithConcurrency(items, limit, worker) {
    const executing = new Set();
    for (const item of items) {
      const promise = Promise.resolve().then(() => worker(item));
      executing.add(promise);
      promise.finally(() => executing.delete(promise));
      if (executing.size >= limit) await Promise.race(executing);
    }
    await Promise.all(executing);
  }

  async function getFileReviewDataBatch({ projectPath, files, mode, context }) {
    const result = { files: {}, errors: {} };
    await mapWithConcurrency(files, 4, async (file) => {
      try {
        result.files[file] = await getFileReviewData({ projectPath, file, mode, context });
      } catch (error) {
        result.errors[file] = error instanceof Error ? error.message : String(error);
      }
    });
    return result;
  }

  async function createWorktree({ projectPath, baseRef, worktreePath, branch, detach }) {
    await assertGitRepository(projectPath);

    const args = ['worktree', 'add'];
    if (detach) {
      args.push('--detach', worktreePath);
      if (baseRef) args.push(baseRef);
    } else if (branch) {
      // Check if the branch already exists to avoid `-b` failure.
      const branchExists = await runGit(projectPath, ['rev-parse', '--verify', `refs/heads/${branch}`])
        .then(() => true)
        .catch(() => false);
      if (branchExists) {
        // Checkout existing branch into the new worktree path.
        args.push(worktreePath, branch);
      } else {
        args.push('-b', branch, worktreePath);
        if (baseRef) args.push(baseRef);
      }
    } else {
      args.push(worktreePath);
      if (baseRef) args.push(baseRef);
    }

    const { stdout } = await runGit(projectPath, args);
    const resolvedPath = path.resolve(projectPath, worktreePath);
    return { success: true, output: stdout || 'Worktree created', worktreePath: resolvedPath };
  }

  async function removeWorktree({ projectPath, worktreePath, force }) {
    await assertGitRepository(projectPath);

    const args = ['worktree', 'remove'];
    if (force) args.push('--force');
    args.push(worktreePath);

    const { stdout } = await runGit(projectPath, args);
    return { success: true, output: stdout || 'Worktree removed' };
  }

  async function commitIndex({ projectPath, message }) {
    await assertGitRepository(projectPath);
    const { stdout } = await runGit(projectPath, ['commit', '-m', message]);
    return { success: true, output: stdout };
  }

  async function stageFile({ projectPath, file, mode }) {
    await assertGitRepository(projectPath);
    resolvePathWithinProject(projectPath, file);

    if (mode === 'stage') {
      await runGit(projectPath, ['add', '--', file]);
    } else {
      await runGit(projectPath, ['reset', 'HEAD', '--', file]);
    }
    return { success: true };
  }

  async function revertLastCommit({ projectPath, strategy }) {
    await assertGitRepository(projectPath);

    try {
      await runGit(projectPath, ['rev-parse', 'HEAD']);
    } catch {
      throw new GitDomainError('INVALID_INPUT', 'No commit history found to revert.');
    }

    const effectiveStrategy = strategy || 'revert';
    if (effectiveStrategy === 'revert') {
      const { stdout } = await runGit(projectPath, ['revert', '--no-edit', 'HEAD']);
      return { success: true, output: stdout || 'Last commit reverted' };
    } else {
      const { stdout } = await runGit(projectPath, ['reset', '--soft', 'HEAD~1']);
      return { success: true, output: stdout || 'Last commit soft-reset' };
    }
  }

  // Maps a thrown error to an HTTP Response. GitDomainError instances
  // use their code for status selection; all other errors pass through
  // the classifier. Logs the error so route handlers stay minimal.
  function toHttpError(error) {
    console.error('[git]', error);

    if (error instanceof GitDomainError) {
      const code = error.code;
      if (COMMIT_MESSAGE_ERROR_MAP[code]) {
        const entry = COMMIT_MESSAGE_ERROR_MAP[code];
        return Response.json(
          { error: error.message, errorCode: entry.errorCode },
          { status: entry.status },
        );
      }
      if (code === 'INVALID_INPUT') return Response.json({ error: error.message }, { status: 400 });
      if (code === 'NOT_REPO') return Response.json({ error: error.message }, { status: 400 });
      if (code === 'AUTH_FAILED') return Response.json({ error: error.message }, { status: 401 });
      return Response.json({ error: error.message }, { status: 500 });
    }

    const classified = classifyGitError(error);
    const body = { error: classified.message };
    if (classified.details) body.details = classified.details;
    return Response.json(body, { status: classified.status });
  }

  return {
    getStatus,
    getDiff,
    getFileWithDiff,
    initialCommit,
    commit,
    getBranches,
    checkout,
    createBranch,
    getCommits,
    getCommitDiff,
    generateCommitMessageForFiles,
    getRemoteStatus,
    getRemotes,
    fetch,
    pull,
    push,
    discard,
    deleteUntracked,
    getFileReviewData,
    getFileReviewDataBatch,
    getChangesTree,
    stageSelection,
    stageHunk,
    getRepoInfo,
    getWorktrees,
    getTargetCandidates,
    createWorktree,
    removeWorktree,
    commitIndex,
    stageFile,
    revertLastCommit,
    toHttpError,
  };
}
