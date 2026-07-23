import { createHash } from 'crypto';
import { mapWithConcurrency } from '../lib/concurrency.js';
import { getWorkingTreeFingerprint } from './diff-engine.js';
import {
  isExpectedMissingGitResult,
  isUnresolvedRevision,
  needsRevisionFailureDiagnostics,
} from './comparison-errors.js';
import { parseNameStatusZ, parseNumstatZ } from './diff-file-list.js';
import { GitDomainError } from './git-types.js';
import { indexPorcelainStatusByPath, parsePorcelainV1Z } from './porcelain-status.js';
import {
  categoryForPath,
  errorFileBody,
  limitedFileBody,
  limitedRenderedPatch,
  selectFilePatchFromRawDiff,
} from './rendered-diff.js';
import { assertGitRepository, readOnlyGitOptions, runGitTraced } from './run.js';
import { assertSafeRef } from './ref-validation.js';
import { exactGitPathspecs, literalGitPathspec } from './pathspecs.js';
import {
  GIT_REVIEW_DOCUMENT_LIMITS,
  type GitCommandTrace,
  type GitCommitFileStatus,
  type GitCommitFileSummary,
  type GitComparisonFileBodiesOptions,
  type GitComparisonFileBodiesResponse,
  type GitComparisonFileRequest,
  type GitComparisonSnapshotOptions,
  type GitComparisonSnapshotReady,
  type GitComparisonSnapshotResponse,
  type GitReviewFileBody,
  type GitResolvedComparisonRevision,
  type GitResolvedComparisonWorkingTree,
} from './types.js';
import {
  createUntrackedSummaryBudget,
  loadUntrackedComparisonBody,
  summarizeUntrackedFile,
  type UntrackedSummaryBudget,
} from './working-tree-comparison.js';

export const GIT_EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function hashString(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function shortHash(hash: string): string {
  return hash.slice(0, 7);
}

function safeContext(context: number | undefined): number {
  if (!Number.isInteger(context) || context === undefined || context < 0) return 5;
  return Math.min(context, GIT_REVIEW_DOCUMENT_LIMITS.maxContextLines);
}

function statusFromRaw(rawStatus: string): GitCommitFileStatus {
  const status = rawStatus[0];
  if (status === 'A' || status === '?') return 'added';
  if (status === 'M' || status === 'U') return 'modified';
  if (status === 'D') return 'deleted';
  if (status === 'R') return 'renamed';
  if (status === 'C') return 'copied';
  if (status === 'T') return 'type-changed';
  return 'unknown';
}

async function resolveRevision(
  projectPath: string,
  revision: string,
  trace?: GitCommandTrace[],
  signal?: AbortSignal,
): Promise<GitResolvedComparisonRevision | null> {
  try {
    assertSafeRef(revision, 'revision');
  } catch (error) {
    if (error instanceof GitDomainError && error.code === 'INVALID_INPUT') return null;
    throw error;
  }
  if (revision === GIT_EMPTY_TREE) {
    return {
      kind: 'revision',
      requestedRevision: revision,
      label: 'Empty tree',
      hash: revision,
      shortHash: shortHash(revision),
    };
  }
  const resolveHash = async (quiet: boolean): Promise<string> => {
    const { stdout } = await runGitTraced(
      projectPath,
      ['rev-parse', '--verify', ...(quiet ? ['--quiet'] : []), `${revision}^{commit}`],
      trace,
      readOnlyGitOptions({ signal }),
    );
    return stdout.trim();
  };
  let hash: string;
  try {
    hash = await resolveHash(true);
  } catch (error) {
    if (isUnresolvedRevision(error)) return null;
    if (!needsRevisionFailureDiagnostics(error)) throw error;
    try {
      hash = await resolveHash(false);
    } catch (diagnosticError) {
      if (isUnresolvedRevision(diagnosticError)) return null;
      throw diagnosticError;
    }
  }
  if (!hash) return null;
  return {
    kind: 'revision',
    requestedRevision: revision,
    label: revision,
    hash,
    shortHash: shortHash(hash),
  };
}

async function findMergeBase(
  projectPath: string,
  fromHash: string,
  toHash: string,
  trace?: GitCommandTrace[],
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const { stdout } = await runGitTraced(
      projectPath,
      ['merge-base', fromHash, toHash],
      trace,
      readOnlyGitOptions({ signal }),
    );
    return stdout.trim() || null;
  } catch (error) {
    if (isExpectedMissingGitResult(error)) return null;
    throw error;
  }
}

async function resolveRepositoryRoot(
  projectPath: string,
  trace?: GitCommandTrace[],
  signal?: AbortSignal,
): Promise<string> {
  const { stdout } = await runGitTraced(
    projectPath,
    ['rev-parse', '--show-toplevel'],
    trace,
    readOnlyGitOptions({ signal }),
  );
  return stdout.trim() || projectPath;
}

function parseUnmergedPaths(output: string): Set<string> {
  const paths = new Set<string>();
  for (const token of output.split('\0')) {
    const tab = token.indexOf('\t');
    if (tab >= 0 && token.slice(tab + 1)) paths.add(token.slice(tab + 1));
  }
  return paths;
}

function comparisonFileFingerprint(
  effectiveFromHash: string,
  targetIdentity: string,
  context: number,
  file: GitComparisonFileRequest,
): string {
  return hashString(
    [
      'comparison-file',
      effectiveFromHash,
      targetIdentity,
      context,
      file.originalPath ?? '',
      file.path,
    ].join('\x1f'),
  );
}

function staleFileBodiesResponse(
  documentId: string,
  expectedFingerprint: string,
  actualFingerprint: string,
): GitComparisonFileBodiesResponse {
  return {
    status: 'stale',
    documentId,
    expectedFingerprint,
    actualFingerprint,
    message: 'The Working Tree changed. Refresh the comparison to review the latest content.',
  };
}

async function summarizeComparisonFiles({
  projectPath,
  effectiveFromHash,
  targetIdentity,
  context,
  nameStatusOutput,
  numstatOutput,
  statusOutput,
  unmergedOutput,
  signal,
}: {
  projectPath: string;
  effectiveFromHash: string;
  targetIdentity: string;
  context: number;
  nameStatusOutput: string;
  numstatOutput: string;
  statusOutput?: string;
  unmergedOutput?: string;
  signal?: AbortSignal;
}): Promise<{ files: GitCommitFileSummary[]; totalFilesKnown: number }> {
  const parsed = parseNameStatusZ(nameStatusOutput, parseNumstatZ(numstatOutput));
  const paths = new Set(parsed.map((file) => file.path));
  for (const entry of parsePorcelainV1Z(statusOutput ?? '')) {
    if (entry.indexStatus !== '?' || paths.has(entry.path)) continue;
    parsed.push({ path: entry.path, status: '?', additions: 0, deletions: 0 });
    paths.add(entry.path);
  }
  parsed.sort((left, right) => left.path.localeCompare(right.path));
  const totalFilesKnown = parsed.length;
  const candidates = parsed.slice(0, GIT_REVIEW_DOCUMENT_LIMITS.maxSummaryFiles);
  const unmergedPaths = parseUnmergedPaths(unmergedOutput ?? '');
  const summaries: GitCommitFileSummary[] = [];
  const untrackedSummaryBudget: UntrackedSummaryBudget = createUntrackedSummaryBudget();

  await mapWithConcurrency(candidates, GIT_REVIEW_DOCUMENT_LIMITS.bodyConcurrency, async (file) => {
    signal?.throwIfAborted();
    const isUntracked = file.status === '?';
    const untrackedLimits = isUntracked
      ? await summarizeUntrackedFile(projectPath, file.path, untrackedSummaryBudget, signal)
      : {
          isBinary: false,
          isTooLarge: false,
          unsupported: false,
          additions: 0,
          statsKnown: true,
        };
    const isConflicted = unmergedPaths.has(file.path);
    const isBinary = file.isBinary === true || untrackedLimits.isBinary;
    const additions = isUntracked ? untrackedLimits.additions : file.additions;
    const estimatedRows = Math.max(1, additions + file.deletions + 1);
    const isTooLarge =
      !isBinary &&
      (untrackedLimits.isTooLarge || estimatedRows > GIT_REVIEW_DOCUMENT_LIMITS.maxFileRows);
    const unsupported = untrackedLimits.unsupported || isConflicted;
    const category = categoryForPath(file.path);
    const request = {
      path: file.path,
      ...(file.originalPath ? { originalPath: file.originalPath } : {}),
    };
    let limitReason: GitCommitFileSummary['limitReason'];
    let limitMessage: string | undefined;
    if (isConflicted) {
      limitReason = 'unsupported-file-kind';
      limitMessage = 'Resolve this conflict before reviewing its comparison diff.';
    } else if (untrackedLimits.unsupported) {
      limitReason = 'unsupported-file-kind';
      limitMessage = 'Only regular untracked files can be displayed.';
    } else if (isBinary) {
      limitReason = 'binary';
      limitMessage = 'Binary diff is not available.';
    } else if (isTooLarge) {
      limitReason = untrackedLimits.isTooLarge ? 'file-too-many-bytes' : 'file-too-many-rows';
      limitMessage = untrackedLimits.isTooLarge
        ? `File exceeds ${GIT_REVIEW_DOCUMENT_LIMITS.maxFilePatchBytes} byte display limit.`
        : `Diff exceeds ${GIT_REVIEW_DOCUMENT_LIMITS.maxFileRows} estimated rows.`;
    }

    summaries.push({
      path: file.path,
      ...(file.originalPath ? { originalPath: file.originalPath } : {}),
      status: statusFromRaw(file.status),
      rawStatus: file.status,
      category: isBinary ? 'binary' : isTooLarge || unsupported ? 'large' : category,
      additions,
      deletions: file.deletions,
      ...(isUntracked && !untrackedLimits.statsKnown ? { statsKnown: false } : {}),
      estimatedRows,
      bodyState: isBinary ? 'binary' : isTooLarge || unsupported ? 'too-large' : 'unloaded',
      bodyFingerprint: comparisonFileFingerprint(
        effectiveFromHash,
        targetIdentity,
        context,
        request,
      ),
      isGenerated: category === 'generated',
      isBinary,
      isTooLarge: isTooLarge || unsupported,
      ...(limitReason ? { limitReason } : {}),
      ...(limitMessage ? { limitMessage } : {}),
    });
  });

  return {
    files: summaries.sort((left, right) => left.path.localeCompare(right.path)),
    totalFilesKnown,
  };
}

function comparisonDocumentId(
  projectPath: string,
  effectiveFromHash: string,
  targetIdentity: string,
  context: number,
  files: GitCommitFileSummary[],
): string {
  return hashString(
    [
      'comparison-document',
      projectPath,
      effectiveFromHash,
      targetIdentity,
      context,
      ...files.map((file) => `${file.path}:${file.bodyFingerprint}`),
    ].join('\x1f'),
  );
}

function firstBodyCandidates(files: GitCommitFileSummary[], count: number): string[] {
  return files
    .filter((file) => file.bodyState === 'unloaded')
    .slice(0, count)
    .map((file) => file.path);
}

async function loadDiffSummary(
  projectPath: string,
  effectiveFromHash: string,
  toHash: string | null,
  trace?: GitCommandTrace[],
  signal?: AbortSignal,
) {
  const targetArgs = toHash ? [effectiveFromHash, toHash] : [effectiveFromHash];
  const commands = [
    runGitTraced(
      projectPath,
      ['diff', '--name-status', '-z', '--find-renames', ...targetArgs],
      trace,
      readOnlyGitOptions({ signal }),
    ),
    runGitTraced(
      projectPath,
      ['diff', '--numstat', '-z', '--find-renames', ...targetArgs],
      trace,
      readOnlyGitOptions({ signal }),
    ),
  ];
  if (toHash) {
    const [nameStatus, numstat] = await Promise.all(commands);
    return { nameStatus: nameStatus.stdout, numstat: numstat.stdout };
  }
  const [nameStatus, numstat, status, unmerged] = await Promise.all([
    ...commands,
    runGitTraced(
      projectPath,
      ['status', '--porcelain=v1', '-z', '-uall'],
      trace,
      readOnlyGitOptions({ signal }),
    ),
    runGitTraced(projectPath, ['ls-files', '-u', '-z'], trace, readOnlyGitOptions({ signal })),
  ]);
  return {
    nameStatus: nameStatus.stdout,
    numstat: numstat.stdout,
    status: status.stdout,
    unmerged: unmerged.stdout,
  };
}

async function workingTreeFingerprint(
  projectPath: string,
  trace?: GitCommandTrace[],
  signal?: AbortSignal,
): Promise<string> {
  const result = await getWorkingTreeFingerprint({
    projectPath,
    trace,
    signal,
  });
  if (result.status === 'ready') return result.fingerprint;
  if (result.status === 'not-git-repository') {
    throw new GitDomainError('NOT_REPO', result.message);
  }
  throw new Error(result.message);
}

async function loadWorkingTreeIdentity(
  projectPath: string,
  fingerprint: string,
  trace?: GitCommandTrace[],
  signal?: AbortSignal,
): Promise<GitResolvedComparisonWorkingTree> {
  const [branch, head] = await Promise.all([
    runGitTraced(projectPath, ['branch', '--show-current'], trace, readOnlyGitOptions({ signal })),
    runGitTraced(
      projectPath,
      ['rev-parse', '--verify', '--quiet', 'HEAD'],
      trace,
      readOnlyGitOptions({ signal }),
    ).catch((error) => {
      if (isExpectedMissingGitResult(error)) return { stdout: '' };
      throw error;
    }),
  ]);
  return {
    kind: 'working-tree',
    label: 'Working Tree',
    branch: branch.stdout.trim(),
    headHash: head.stdout.trim() || null,
    fingerprint,
    shortFingerprint: fingerprint.slice(-8),
  };
}

async function buildWorkingTreeSnapshot(
  repoRoot: string,
  requestedProjectPath: string,
  from: GitResolvedComparisonRevision,
  context: number,
  bodyCandidateCount: number,
  trace?: GitCommandTrace[],
  signal?: AbortSignal,
): Promise<GitComparisonSnapshotResponse> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = await workingTreeFingerprint(repoRoot, trace, signal);
    let summary: Awaited<ReturnType<typeof loadDiffSummary>>;
    try {
      summary = await loadDiffSummary(repoRoot, from.hash, null, trace, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      const afterFailure = await workingTreeFingerprint(repoRoot, trace, signal);
      if (before !== afterFailure) continue;
      throw error;
    }
    const summarized = await summarizeComparisonFiles({
      projectPath: repoRoot,
      effectiveFromHash: from.hash,
      targetIdentity: before,
      context,
      nameStatusOutput: summary.nameStatus,
      numstatOutput: summary.numstat,
      statusOutput: summary.status,
      unmergedOutput: summary.unmerged,
      signal,
    });
    const identity = await loadWorkingTreeIdentity(repoRoot, before, trace, signal);
    const after = await workingTreeFingerprint(repoRoot, trace, signal);
    if (before !== after) continue;
    const files = summarized.files;
    return {
      status: 'ready',
      project: requestedProjectPath,
      repoRoot,
      documentId: comparisonDocumentId(repoRoot, from.hash, before, context, files),
      mode: 'direct',
      from,
      to: identity,
      effectiveFromHash: from.hash,
      files,
      limits: GIT_REVIEW_DOCUMENT_LIMITS,
      ...(summarized.totalFilesKnown > files.length
        ? {
            collectionLimit: {
              reason: 'collection-too-many-files' as const,
              message: `Showing ${files.length} of ${summarized.totalFilesKnown} changed files.`,
              visibleFiles: files.length,
              totalFilesKnown: summarized.totalFilesKnown,
            },
          }
        : {}),
      firstBodyCandidates: firstBodyCandidates(files, bodyCandidateCount),
    } satisfies GitComparisonSnapshotReady;
  }
  return {
    status: 'working-tree-changing',
    project: requestedProjectPath,
    message:
      'The Working Tree changed while the comparison was loading. Try again when current edits settle.',
  };
}

async function getComparisonSnapshot(
  {
    projectPath,
    from: fromInput,
    to: toInput,
    mode,
    context: requestedContext,
    bodyCandidateCount = 8,
    trace,
    signal,
  }: GitComparisonSnapshotOptions,
  assertProjectPathAllowed: (projectPath: string) => Promise<string>,
): Promise<GitComparisonSnapshotResponse> {
  await assertGitRepository(projectPath);
  const repoRoot = await assertProjectPathAllowed(
    await resolveRepositoryRoot(projectPath, trace, signal),
  );
  const context = safeContext(requestedContext);
  const candidateCount = Math.max(
    0,
    Math.min(bodyCandidateCount, GIT_REVIEW_DOCUMENT_LIMITS.maxBodyBatchFiles),
  );
  const from = await resolveRevision(repoRoot, fromInput.revision, trace, signal);
  if (!from) {
    return {
      status: 'not-found',
      project: projectPath,
      endpoint: 'from',
      revision: fromInput.revision,
      message: 'The From revision was not found in this repository.',
    };
  }
  if (toInput.kind === 'working-tree') {
    if (mode !== 'direct') {
      throw new GitDomainError('INVALID_INPUT', 'Working Tree comparisons require direct mode.');
    }
    return buildWorkingTreeSnapshot(
      repoRoot,
      projectPath,
      from,
      context,
      candidateCount,
      trace,
      signal,
    );
  }

  const to = await resolveRevision(repoRoot, toInput.revision, trace, signal);
  if (!to) {
    return {
      status: 'not-found',
      project: projectPath,
      endpoint: 'to',
      revision: toInput.revision,
      message: 'The To revision was not found in this repository.',
    };
  }
  if (mode === 'merge-base' && (from.hash === GIT_EMPTY_TREE || to.hash === GIT_EMPTY_TREE)) {
    return {
      status: 'no-merge-base',
      project: projectPath,
      from,
      to,
      message: 'These revisions do not have a common ancestor.',
    };
  }
  const mergeBaseHash =
    mode === 'merge-base' ? await findMergeBase(repoRoot, from.hash, to.hash, trace, signal) : null;
  if (mode === 'merge-base' && !mergeBaseHash) {
    return {
      status: 'no-merge-base',
      project: projectPath,
      from,
      to,
      message: 'These revisions do not have a common ancestor.',
    };
  }
  const effectiveFromHash = mergeBaseHash ?? from.hash;
  const summary = await loadDiffSummary(repoRoot, effectiveFromHash, to.hash, trace, signal);
  const summarized = await summarizeComparisonFiles({
    projectPath: repoRoot,
    effectiveFromHash,
    targetIdentity: to.hash,
    context,
    nameStatusOutput: summary.nameStatus,
    numstatOutput: summary.numstat,
    signal,
  });
  const files = summarized.files;
  return {
    status: 'ready',
    project: projectPath,
    repoRoot,
    documentId: comparisonDocumentId(repoRoot, effectiveFromHash, to.hash, context, files),
    mode,
    from,
    to,
    effectiveFromHash,
    ...(mergeBaseHash ? { mergeBaseHash } : {}),
    files,
    limits: GIT_REVIEW_DOCUMENT_LIMITS,
    ...(summarized.totalFilesKnown > files.length
      ? {
          collectionLimit: {
            reason: 'collection-too-many-files' as const,
            message: `Showing ${files.length} of ${summarized.totalFilesKnown} changed files.`,
            visibleFiles: files.length,
            totalFilesKnown: summarized.totalFilesKnown,
          },
        }
      : {}),
    firstBodyCandidates: firstBodyCandidates(files, candidateCount),
  } satisfies GitComparisonSnapshotReady;
}

function assertResolvedHash(hash: string, field: string): void {
  if (!/^[0-9a-f]{40,64}$/.test(hash)) {
    throw new GitDomainError('INVALID_INPUT', `${field} must be a resolved Git object hash.`);
  }
}

async function loadComparisonBody({
  projectPath,
  effectiveFromHash,
  targetIdentity,
  toHash,
  context,
  file,
  workingTreeStatus,
  pathsTrackedAtFrom,
  unmergedPaths,
  trace,
  signal,
}: {
  projectPath: string;
  effectiveFromHash: string;
  targetIdentity: string;
  toHash: string | null;
  context: number;
  file: GitComparisonFileRequest;
  workingTreeStatus: Map<string, { indexStatus: string; workTreeStatus: string }>;
  pathsTrackedAtFrom: Set<string>;
  unmergedPaths: Set<string>;
  trace?: GitCommandTrace[];
  signal?: AbortSignal;
}) {
  const fingerprint = comparisonFileFingerprint(effectiveFromHash, targetIdentity, context, file);
  if (!toHash && unmergedPaths.has(file.path)) {
    return limitedFileBody(
      file.path,
      fingerprint,
      'unsupported-file-kind',
      'Resolve this conflict before reviewing its comparison diff.',
    );
  }
  const status = workingTreeStatus.get(file.path);
  if (!toHash && status?.indexStatus === '?' && !pathsTrackedAtFrom.has(file.path)) {
    return loadUntrackedComparisonBody(projectPath, file, fingerprint, signal);
  }
  const endpoints = toHash ? [effectiveFromHash, toHash] : [effectiveFromHash];
  const pathspecs = exactGitPathspecs(
    file.originalPath ? [file.originalPath, file.path] : [file.path],
  );
  const { stdout } = await runGitTraced(
    projectPath,
    [
      'diff',
      '--patch-with-raw',
      '-z',
      '--no-color',
      '--no-ext-diff',
      `-U${context}`,
      '--find-renames',
      '--submodule=short',
      ...(file.originalPath ? ['--diff-filter=RC'] : []),
      ...endpoints,
      '--',
      ...pathspecs,
    ],
    trace,
    readOnlyGitOptions({ signal }),
  );
  return limitedRenderedPatch(
    file.path,
    fingerprint,
    selectFilePatchFromRawDiff(stdout, file.path),
    { allowMultipleFileSections: true },
  );
}

async function getComparisonFileBodies(
  {
    projectPath,
    documentId,
    effectiveFromHash,
    to,
    context: requestedContext,
    files,
    trace,
    signal,
  }: GitComparisonFileBodiesOptions,
  assertProjectPathAllowed: (projectPath: string) => Promise<string>,
): Promise<GitComparisonFileBodiesResponse> {
  await assertGitRepository(projectPath);
  const repoRoot = await assertProjectPathAllowed(
    await resolveRepositoryRoot(projectPath, trace, signal),
  );
  assertResolvedHash(effectiveFromHash, 'effectiveFromHash');
  if (to.kind === 'revision') assertResolvedHash(to.hash, 'to.hash');
  const context = safeContext(requestedContext);
  const requestedFiles = files.slice(0, GIT_REVIEW_DOCUMENT_LIMITS.maxBodyBatchFiles);
  const expectedFingerprint = to.kind === 'working-tree' ? to.fingerprint : null;
  if (expectedFingerprint) {
    const actualFingerprint = await workingTreeFingerprint(repoRoot, trace, signal);
    if (actualFingerprint !== expectedFingerprint) {
      return staleFileBodiesResponse(documentId, expectedFingerprint, actualFingerprint);
    }
  }

  let workingTreeStatus = new Map<string, { indexStatus: string; workTreeStatus: string }>();
  let pathsTrackedAtFrom = new Set<string>();
  let unmergedPaths = new Set<string>();
  if (to.kind === 'working-tree') {
    const [status, unmerged, trackedAtFrom] = await Promise.all([
      runGitTraced(
        repoRoot,
        [
          'status',
          '--porcelain=v1',
          '-z',
          '-uall',
          '--',
          ...requestedFiles.map((file) => literalGitPathspec(file.path)),
        ],
        trace,
        readOnlyGitOptions({ signal }),
      ),
      runGitTraced(repoRoot, ['ls-files', '-u', '-z'], trace, readOnlyGitOptions({ signal })),
      runGitTraced(
        repoRoot,
        [
          'ls-tree',
          '-r',
          '-z',
          '--name-only',
          effectiveFromHash,
          '--',
          ...requestedFiles.map((file) => literalGitPathspec(file.path)),
        ],
        trace,
        readOnlyGitOptions({ signal }),
      ),
    ]);
    workingTreeStatus = indexPorcelainStatusByPath(parsePorcelainV1Z(status.stdout));
    unmergedPaths = parseUnmergedPaths(unmerged.stdout);
    pathsTrackedAtFrom = new Set(trackedAtFrom.stdout.split('\0').filter(Boolean));
  }

  const parsedFiles: Record<string, GitReviewFileBody> = {};
  const errors: Record<string, string> = {};
  await mapWithConcurrency(
    requestedFiles,
    GIT_REVIEW_DOCUMENT_LIMITS.bodyConcurrency,
    async (file) => {
      try {
        parsedFiles[file.path] = await loadComparisonBody({
          projectPath: repoRoot,
          effectiveFromHash,
          targetIdentity: to.kind === 'revision' ? to.hash : to.fingerprint,
          toHash: to.kind === 'revision' ? to.hash : null,
          context,
          file,
          workingTreeStatus,
          pathsTrackedAtFrom,
          unmergedPaths,
          trace,
          signal,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        const message = error instanceof Error ? error.message : String(error);
        const fingerprint = comparisonFileFingerprint(
          effectiveFromHash,
          to.kind === 'revision' ? to.hash : to.fingerprint,
          context,
          file,
        );
        parsedFiles[file.path] = errorFileBody(file.path, fingerprint, message);
        errors[file.path] = message;
      }
    },
  );

  if (expectedFingerprint) {
    const actualFingerprint = await workingTreeFingerprint(repoRoot, trace, signal);
    if (actualFingerprint !== expectedFingerprint) {
      return staleFileBodiesResponse(documentId, expectedFingerprint, actualFingerprint);
    }
  }

  return { status: 'ready', documentId, files: parsedFiles, errors };
}

export function createComparisonOperations(
  assertProjectPathAllowed: (projectPath: string) => Promise<string> = async (projectPath) =>
    projectPath,
) {
  return {
    getComparisonSnapshot: (options: GitComparisonSnapshotOptions) =>
      getComparisonSnapshot(options, assertProjectPathAllowed),
    getComparisonFileBodies: (options: GitComparisonFileBodiesOptions) =>
      getComparisonFileBodies(options, assertProjectPathAllowed),
  };
}
