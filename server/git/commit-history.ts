import { createHash } from 'crypto';
import { GitDomainError } from './git-types.js';
import { assertGitRepository, readOnlyGitOptions, runGitTraced } from './run.js';
import { mapWithConcurrency } from '../lib/concurrency.js';
import { parseNameStatusZ, parseNumstatZ } from './diff-file-list.js';
import { assertExistingCommitRef, assertSafeRef } from './ref-validation.js';
import { exactGitPathspecs } from './pathspecs.js';
import {
  categoryForPath,
  errorFileBody,
  limitedRenderedPatch,
  selectFilePatchFromRawDiff,
} from './rendered-diff.js';
import {
  GIT_REVIEW_DOCUMENT_LIMITS,
  type GitCommandTrace,
  type GitCommitDetails,
  type GitCommitFileBodiesOptions,
  type GitCommitFileBodiesResponse,
  type GitCommitFileStatus,
  type GitCommitFileSummary,
  type GitCommitSnapshotOptions,
  type GitCommitSnapshotResponse,
  type GitCommitSnapshotReady,
  type GitDiffFileRequest,
  type GitHistoryCommitListItem,
  type GitHistoryCommitListOptions,
  type GitHistoryCommitListResponse,
} from './types.js';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const DEFAULT_HISTORY_REF = 'HEAD';
const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 200;

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isInteger(value) || value === undefined || value <= 0) return fallback;
  return Math.min(value, max);
}

function clampOffset(value: number | undefined): number {
  if (!Number.isInteger(value) || value === undefined || value < 0) return 0;
  return value;
}

function hashString(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function parseDecorations(value: string): string[] {
  return value
    ? value.split(',').map((entry) => entry.trim()).filter(Boolean)
    : [];
}

function shortHash(hash: string): string {
  return hash.slice(0, 7);
}

function parseCommitList(output: string): GitHistoryCommitListItem[] {
  return output
    .split('\x1e')
    .filter(Boolean)
    .map((entry) => {
      const normalizedEntry = entry.replace(/^\n+/, '').replace(/\n+$/, '');
      const [
        hash = '',
        parentsRaw = '',
        author = '',
        authorEmail = '',
        authorDate = '',
        committer = '',
        committerEmail = '',
        committerDate = '',
        refsRaw = '',
        subject = '',
      ] = normalizedEntry.split('\0');
      return {
        hash,
        shortHash: shortHash(hash),
        parents: parentsRaw ? parentsRaw.split(' ').filter(Boolean) : [],
        author,
        authorEmail,
        authorDate,
        committer,
        committerEmail,
        committerDate,
        subject,
        refs: parseDecorations(refsRaw),
      };
    })
    .filter((commit) => commit.hash.trim().length > 0);
}

function parseCommitDetails(output: string): GitCommitDetails {
  const [
    hash = '',
    parentsRaw = '',
    author = '',
    authorEmail = '',
    authorDate = '',
    committer = '',
    committerEmail = '',
    committerDate = '',
    refsRaw = '',
    subject = '',
    ...bodyParts
  ] = output.split('\0');
  return {
    hash,
    shortHash: shortHash(hash),
    parents: parentsRaw ? parentsRaw.split(' ').filter(Boolean) : [],
    author,
    authorEmail,
    authorDate,
    committer,
    committerEmail,
    committerDate,
    subject,
    body: bodyParts.join('\0').trimEnd(),
    refs: parseDecorations(refsRaw),
  };
}

async function resolveCommit(
  projectPath: string,
  commit: string,
  trace?: GitCommandTrace[],
  signal?: AbortSignal,
): Promise<string | null> {
  assertSafeRef(commit, 'commit');
  try {
    const { stdout } = await runGitTraced(
      projectPath,
      ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`],
      trace,
      readOnlyGitOptions({ signal }),
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function loadCommitDetails(
  projectPath: string,
  commit: string,
  trace?: GitCommandTrace[],
  signal?: AbortSignal,
): Promise<GitCommitDetails> {
  const { stdout } = await runGitTraced(
    projectPath,
    [
      'show',
      '-s',
      '--date=iso-strict',
      '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%D%x00%s%x00%b',
      commit,
    ],
    trace,
    readOnlyGitOptions({ signal }),
  );
  return parseCommitDetails(stdout);
}

function selectCommitParent(parents: string[], requestedParent?: string | null): string | null {
  if (parents.length === 0) {
    if (requestedParent) {
      throw new GitDomainError('INVALID_INPUT', 'Root commits do not have parent diffs.');
    }
    return null;
  }
  if (!requestedParent) return parents[0];
  assertSafeRef(requestedParent, 'parent');
  if (!parents.includes(requestedParent)) {
    throw new GitDomainError('INVALID_INPUT', 'Requested parent is not a direct parent of the commit.');
  }
  return requestedParent;
}

function statusFromRaw(rawStatus: string): GitCommitFileStatus {
  const status = rawStatus[0];
  if (status === 'A') return 'added';
  if (status === 'M') return 'modified';
  if (status === 'D') return 'deleted';
  if (status === 'R') return 'renamed';
  if (status === 'C') return 'copied';
  if (status === 'T') return 'type-changed';
  return 'unknown';
}

function commitFileFingerprint(
  commit: string,
  parent: string | null,
  context: number,
  file: GitDiffFileRequest,
): string {
  return hashString([
    'commit-file',
    commit,
    parent ?? EMPTY_TREE,
    context,
    file.originalPath ?? '',
    file.path,
  ].join('\x1f'));
}

function commitDocumentId(
  projectPath: string,
  commit: string,
  parent: string | null,
  context: number,
  files: GitCommitFileSummary[],
): string {
  return hashString([
    'commit-document',
    projectPath,
    commit,
    parent ?? EMPTY_TREE,
    context,
    ...files.map((file) => `${file.path}:${file.bodyFingerprint}`),
  ].join('\x1f'));
}

function summarizeCommitFiles(
  commit: string,
  parent: string | null,
  context: number,
  nameStatusOutput: string,
  numstatOutput: string,
): GitCommitFileSummary[] {
  const files = parseNameStatusZ(nameStatusOutput, parseNumstatZ(numstatOutput));
  return files.map((file) => {
    const category = file.isBinary ? 'binary' : categoryForPath(file.path);
    const estimatedRows = Math.max(1, file.additions + file.deletions + 1);
    const isTooLarge = !file.isBinary && estimatedRows > GIT_REVIEW_DOCUMENT_LIMITS.maxFileRows;
    const summary: GitCommitFileSummary = {
      path: file.path,
      ...(file.originalPath ? { originalPath: file.originalPath } : {}),
      status: statusFromRaw(file.status),
      rawStatus: file.status,
      category: file.isBinary ? 'binary' : isTooLarge ? 'large' : category,
      additions: file.additions,
      deletions: file.deletions,
      estimatedRows,
      bodyState: file.isBinary ? 'binary' : isTooLarge ? 'too-large' : 'unloaded',
      bodyFingerprint: '',
      isGenerated: category === 'generated',
      isBinary: file.isBinary === true,
      isTooLarge,
      ...(file.isBinary
        ? { limitReason: 'binary' as const, limitMessage: 'Binary diff is not available.' }
        : {}),
      ...(isTooLarge
        ? {
            limitReason: 'file-too-many-rows' as const,
            limitMessage: `Diff exceeds ${GIT_REVIEW_DOCUMENT_LIMITS.maxFileRows} estimated rows.`,
          }
        : {}),
    };
    summary.bodyFingerprint = commitFileFingerprint(commit, parent, context, summary);
    return summary;
  });
}

function chooseFirstBodyCandidates(files: GitCommitFileSummary[], count: number): string[] {
  return files
    .filter((file) => file.bodyState === 'unloaded')
    .slice(0, count)
    .map((file) => file.path);
}

async function getHistoryCommits({
  projectPath,
  ref,
  limit,
  offset,
  trace,
  signal,
}: GitHistoryCommitListOptions): Promise<GitHistoryCommitListResponse> {
  await assertGitRepository(projectPath);
  const requestedRef = ref || DEFAULT_HISTORY_REF;
  const safeLimit = clampLimit(limit, DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);
  const safeOffset = clampOffset(offset);

  try {
    await assertExistingCommitRef(projectPath, requestedRef, 'history', signal);
  } catch (error) {
    if (requestedRef === DEFAULT_HISTORY_REF) {
      return { project: projectPath, ref: requestedRef, commits: [], nextOffset: null };
    }
    throw error;
  }

  const { stdout } = await runGitTraced(
    projectPath,
    [
      'log',
      '--date=iso-strict',
      `-n${safeLimit}`,
      `--skip=${safeOffset}`,
      '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%D%x00%s%x1e',
      requestedRef,
    ],
    trace,
    readOnlyGitOptions({ signal }),
  );
  const commits = parseCommitList(stdout);
  return {
    project: projectPath,
    ref: requestedRef,
    commits,
    nextOffset: commits.length === safeLimit ? safeOffset + commits.length : null,
  };
}

async function getCommitSnapshot({
  projectPath,
  commit,
  parent,
  context = 5,
  bodyCandidateCount = 8,
  trace,
  signal,
}: GitCommitSnapshotOptions): Promise<GitCommitSnapshotResponse> {
  await assertGitRepository(projectPath);
  const resolvedCommit = await resolveCommit(projectPath, commit, trace, signal);
  if (!resolvedCommit) {
    return {
      status: 'not-found',
      project: projectPath,
      commit,
      message: 'Commit was not found in this repository.',
    };
  }

  const details = await loadCommitDetails(projectPath, resolvedCommit, trace, signal);
  const selectedParent = selectCommitParent(details.parents, parent);
  const base = selectedParent ?? EMPTY_TREE;
  const [nameStatus, numstat] = await Promise.all([
    runGitTraced(
      projectPath,
      ['diff', '--name-status', '-z', '--find-renames', base, details.hash],
      trace,
      readOnlyGitOptions({ signal }),
    ),
    runGitTraced(
      projectPath,
      ['diff', '--numstat', '-z', '--find-renames', base, details.hash],
      trace,
      readOnlyGitOptions({ signal }),
    ),
  ]);

  const allFiles = summarizeCommitFiles(details.hash, selectedParent, context, nameStatus.stdout, numstat.stdout);
  const limitedFiles = allFiles.slice(0, GIT_REVIEW_DOCUMENT_LIMITS.maxSummaryFiles);
  const documentId = commitDocumentId(projectPath, details.hash, selectedParent, context, limitedFiles);

  return {
    status: 'ready',
    project: projectPath,
    documentId,
    commit: details,
    selectedParent,
    parentOptions: details.parents.map((hash, index) => ({
      hash,
      shortHash: shortHash(hash),
      label: `Parent ${index + 1}`,
    })),
    files: limitedFiles,
    limits: GIT_REVIEW_DOCUMENT_LIMITS,
    ...(allFiles.length > limitedFiles.length
      ? {
          collectionLimit: {
            reason: 'collection-too-many-files' as const,
            message: `Showing ${limitedFiles.length} of ${allFiles.length} changed files.`,
            visibleFiles: limitedFiles.length,
            totalFilesKnown: allFiles.length,
          },
        }
      : {}),
    firstBodyCandidates: chooseFirstBodyCandidates(
      limitedFiles,
      Math.max(0, Math.min(bodyCandidateCount, GIT_REVIEW_DOCUMENT_LIMITS.maxBodyBatchFiles)),
    ),
  } satisfies GitCommitSnapshotReady;
}

async function getCommitFileBodies({
  projectPath,
  documentId,
  commit,
  parent,
  context = 5,
  files,
  trace,
  signal,
}: GitCommitFileBodiesOptions): Promise<GitCommitFileBodiesResponse> {
  await assertGitRepository(projectPath);
  const resolvedCommit = await resolveCommit(projectPath, commit, trace, signal);
  if (!resolvedCommit) {
    throw new GitDomainError('INVALID_INPUT', 'Commit was not found in this repository.');
  }

  const details = await loadCommitDetails(projectPath, resolvedCommit, trace, signal);
  const selectedParent = selectCommitParent(details.parents, parent);
  const base = selectedParent ?? EMPTY_TREE;
  const requestedFiles = files.slice(0, GIT_REVIEW_DOCUMENT_LIMITS.maxBodyBatchFiles);
  const parsedFiles: GitCommitFileBodiesResponse['files'] = {};
  const errors: GitCommitFileBodiesResponse['errors'] = {};

  await mapWithConcurrency(requestedFiles, GIT_REVIEW_DOCUMENT_LIMITS.bodyConcurrency, async (file) => {
    const pathspecs = exactGitPathspecs(
      file.originalPath ? [file.originalPath, file.path] : [file.path],
    );
    try {
      const { stdout } = await runGitTraced(
        projectPath,
        [
          'diff',
          '--patch-with-raw',
          '-z',
          `-U${context}`,
          '--find-renames',
          '--submodule=short',
          ...(file.originalPath ? ['--diff-filter=RC'] : []),
          base,
          details.hash,
          '--',
          ...pathspecs,
        ],
        trace,
        readOnlyGitOptions({ signal }),
      );
      const fingerprint = commitFileFingerprint(details.hash, selectedParent, context, file);
      parsedFiles[file.path] = limitedRenderedPatch(
        file.path,
        fingerprint,
        selectFilePatchFromRawDiff(stdout, file.path),
        { allowMultipleFileSections: true },
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      const fingerprint = commitFileFingerprint(details.hash, selectedParent, context, file);
      parsedFiles[file.path] = errorFileBody(file.path, fingerprint, error instanceof Error ? error.message : String(error));
      errors[file.path] = error instanceof Error ? error.message : String(error);
    }
  });

  return { documentId, files: parsedFiles, errors };
}

export function createCommitHistoryOperations() {
  return {
    getHistoryCommits,
    getCommitSnapshot,
    getCommitFileBodies,
  };
}
