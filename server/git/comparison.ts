import { createHash } from 'crypto';
import { mapWithConcurrency } from '../lib/concurrency.js';
import {
  captureWorkingTreeObservation,
  isWorkingTreeObservationCurrent,
} from './diff-engine.js';
import {
  isExpectedMissingGitResult,
  isUnresolvedRevision,
  needsRevisionFailureDiagnostics,
} from './comparison-errors.js';
import { parseNameStatusZ, parseNumstatZ, parseUnmergedPaths } from './diff-file-list.js';
import { GitDomainError } from './git-types.js';
import { parsePorcelainV1Z } from './porcelain-status.js';
import { categoryForPath } from './rendered-diff.js';
import { assertGitRepository, readOnlyGitOptions, runGitTraced } from './run.js';
import { assertSafeRef } from './ref-validation.js';
import {
  GIT_REVIEW_DOCUMENT_LIMITS,
  type GitCommandTrace,
  type GitCommitFileStatus,
  type GitCommitFileSummary,
  type GitComparisonFileRequest,
  type GitComparisonFreshnessOptions,
  type GitComparisonFreshnessResponse,
  type GitComparisonSnapshotOptions,
  type GitComparisonSnapshotReady,
  type GitComparisonSnapshotResponse,
  type GitReviewRouteMetrics,
  type GitResolvedComparisonRevision,
  type GitResolvedComparisonWorkingTree,
} from './types.js';
import {
  createUntrackedSummaryBudget,
  summarizeUntrackedFile,
  type UntrackedSummaryBudget,
} from './working-tree-comparison.js';
import {
  GitReviewDocumentRegistry,
  registeredTreeDiffFile,
} from './review-document-registry.js';
import { captureWorkingPathTokens } from './working-path-token.js';
import { measureGitReviewPhaseSync } from './review-performance.js';

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
  workingOutputs?: { status: string; unmerged: string },
) {
  const summary = await loadDiffFileSummary(
    projectPath,
    effectiveFromHash,
    toHash,
    trace,
    signal,
  );
  if (toHash) return summary;
  if (workingOutputs) return { ...summary, ...workingOutputs };
  const [status, unmerged] = await Promise.all([
    runGitTraced(
      projectPath,
      ['status', '--porcelain=v1', '-z', '-uall'],
      trace,
      readOnlyGitOptions({ signal }),
    ),
    runGitTraced(projectPath, ['ls-files', '-u', '-z'], trace, readOnlyGitOptions({ signal })),
  ]);
  return {
    ...summary,
    status: status.stdout,
    unmerged: unmerged.stdout,
  };
}

async function loadDiffFileSummary(
  projectPath: string,
  effectiveFromHash: string,
  toHash: string | null,
  trace?: GitCommandTrace[],
  signal?: AbortSignal,
) {
  const targetArgs = toHash ? [effectiveFromHash, toHash] : [effectiveFromHash];
  const [nameStatus, numstat] = await Promise.all([
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
  ]);
  return {
    nameStatus: nameStatus.stdout,
    numstat: numstat.stdout,
  };
}

async function buildWorkingTreeSnapshot(
  repoRoot: string,
  requestedProjectPath: string,
  from: GitResolvedComparisonRevision,
  context: number,
  bodyCandidateCount: number,
  registry: GitReviewDocumentRegistry,
  metrics?: GitReviewRouteMetrics,
  trace?: GitCommandTrace[],
  signal?: AbortSignal,
): Promise<GitComparisonSnapshotResponse> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const [observationResult, summaryResult] = await Promise.allSettled([
      captureWorkingTreeObservation({
        projectPath: repoRoot,
        repoRoot,
        trace,
        signal,
      }),
      loadDiffFileSummary(repoRoot, from.hash, null, trace, signal),
    ]);
    if (observationResult.status === 'rejected') throw observationResult.reason;
    const observation = observationResult.value;
    const before = observation.fingerprint;
    if (summaryResult.status === 'rejected') {
      const error = summaryResult.reason;
      if (signal?.aborted) throw error;
      if (!(await isWorkingTreeObservationCurrent(observation, trace, signal))) continue;
      throw error;
    }
    const summary = {
      ...summaryResult.value,
      status: observation.statusOutput,
      unmerged: observation.unmergedOutput,
    };
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
    const identity: GitResolvedComparisonWorkingTree = {
      kind: 'working-tree',
      label: 'Working Tree',
      branch: observation.branch,
      headHash: observation.head || null,
      fingerprint: before,
      shortFingerprint: before.slice(-8),
    };
    const files = summarized.files;
    const workingPathTokens = await captureWorkingPathTokens(
      repoRoot,
      files.flatMap((file) =>
        file.originalPath ? [file.path, file.originalPath] : [file.path],
      ),
      {
        statusEntries: observation.statusEntries,
        indexEntriesByPath: observation.indexEntriesByPath,
      },
      signal,
    );
    if (!(await isWorkingTreeObservationCurrent(observation, trace, signal))) continue;
    const document = measureGitReviewPhaseSync(metrics, 'document-register', () =>
      registry.register({
        sourceCacheKey: `comparison:${repoRoot}:direct:${from.hash}:working-tree:${context}`,
        projectPath: requestedProjectPath,
        repoRoot,
        context,
        source: {
          kind: 'comparison-working-tree',
          effectiveFromHash: from.hash,
          fingerprint: before,
        },
        files: files.map(registeredTreeDiffFile),
        workingPathTokens,
      }));
    return {
      status: 'ready',
      project: requestedProjectPath,
      repoRoot,
      documentId: document.id,
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
    metrics,
    signal,
  }: GitComparisonSnapshotOptions,
  assertProjectPathAllowed: (projectPath: string) => Promise<string>,
  registry: GitReviewDocumentRegistry,
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
      registry,
      metrics,
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
  const document = measureGitReviewPhaseSync(metrics, 'document-register', () =>
    registry.register({
      sourceCacheKey: `comparison:${repoRoot}:${mode}:${effectiveFromHash}:${to.hash}:${context}`,
      projectPath,
      repoRoot,
      context,
      source: {
        kind: 'comparison-revisions',
        effectiveFromHash,
        toHash: to.hash,
      },
      files: files.map(registeredTreeDiffFile),
    }));
  return {
    status: 'ready',
    project: projectPath,
    repoRoot,
    documentId: document.id,
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

async function getComparisonFreshness(
  {
    projectPath,
    from: fromExpectation,
    to: toExpectation,
    trace,
    signal,
  }: GitComparisonFreshnessOptions,
  assertProjectPathAllowed: (projectPath: string) => Promise<string>,
): Promise<GitComparisonFreshnessResponse> {
  await assertGitRepository(projectPath);
  const repoRoot = await assertProjectPathAllowed(
    await resolveRepositoryRoot(projectPath, trace, signal),
  );
  assertResolvedHash(fromExpectation.hash, 'from.hash');
  if (toExpectation.kind === 'revision') {
    assertResolvedHash(toExpectation.hash, 'to.hash');
  }

  const from = await resolveRevision(repoRoot, fromExpectation.revision, trace, signal);
  if (!from) {
    return {
      status: 'not-found',
      project: projectPath,
      endpoint: 'from',
      revision: fromExpectation.revision,
      message: 'The From revision is no longer available in this repository.',
    };
  }

  const changedEndpoints: Array<'from' | 'to'> = [];
  if (from.hash !== fromExpectation.hash) changedEndpoints.push('from');
  if (toExpectation.kind === 'revision') {
    const to = await resolveRevision(repoRoot, toExpectation.revision, trace, signal);
    if (!to) {
      return {
        status: 'not-found',
        project: projectPath,
        endpoint: 'to',
        revision: toExpectation.revision,
        message: 'The To revision is no longer available in this repository.',
      };
    }
    if (to.hash !== toExpectation.hash) changedEndpoints.push('to');
    return {
      status: 'ready',
      project: projectPath,
      changedEndpoints,
      fromHash: from.hash,
      to: { kind: 'revision', hash: to.hash },
    };
  }

  const observation = await captureWorkingTreeObservation({
    projectPath: repoRoot,
    repoRoot,
    trace,
    signal,
  });
  if (observation.fingerprint !== toExpectation.fingerprint) changedEndpoints.push('to');
  return {
    status: 'ready',
    project: projectPath,
    changedEndpoints,
    fromHash: from.hash,
    to: { kind: 'working-tree', fingerprint: observation.fingerprint },
  };
}

export function createComparisonOperations(
  registry: GitReviewDocumentRegistry,
  assertProjectPathAllowed: (projectPath: string) => Promise<string> = async (projectPath) =>
    projectPath,
) {
  return {
    getComparisonSnapshot: (options: GitComparisonSnapshotOptions) =>
      getComparisonSnapshot(options, assertProjectPathAllowed, registry),
    getComparisonFreshness: (options: GitComparisonFreshnessOptions) =>
      getComparisonFreshness(options, assertProjectPathAllowed),
  };
}
