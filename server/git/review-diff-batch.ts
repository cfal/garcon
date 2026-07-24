import { promises as fs } from 'fs';
import { buildFullFileAddedPatch } from './full-file-patch.js';
import { exactGitPathspecs } from './pathspecs.js';
import type {
  RegisteredGitReviewDocument,
  RegisteredGitReviewFile,
} from './review-document-registry.js';
import {
  compactRenderedPatch,
  errorPatchFileBody,
  limitedPatchFileBody,
  splitPatchesFromRawDiff,
  type SplitRawDiffPatch,
} from './rendered-diff.js';
import {
  GitOutputLimitError,
  isBinaryFile,
  readOnlyGitOptions,
  resolvePathWithinProject,
  runGitTraced,
} from './run.js';
import {
  GIT_REVIEW_DOCUMENT_LIMITS,
  type GitCommandTrace,
  type GitReviewFilePatchBody,
  type GitReviewRouteMetrics,
} from './types.js';
import {
  measureGitReviewPhase,
  measureGitReviewPhaseSync,
} from './review-performance.js';
import { mapWithConcurrencyResult } from '../lib/concurrency.js';

const TARGET_BATCH_ESTIMATED_ROWS = 20_000;
const MAX_BATCH_STDOUT_BYTES = GIT_REVIEW_DOCUMENT_LIMITS.maxLoadedPatchBytes + 2_000_000;

export interface GitReviewDiffBatchMetrics {
  batchCount: number;
  bisectionCount: number;
}

export interface GitReviewDiffBatchResult {
  bodies: GitReviewFilePatchBody[];
  errors: Record<string, string>;
  metrics: GitReviewDiffBatchMetrics;
}

export interface GitReviewLoadedBodyTotals {
  loadedRows: number;
  loadedBytes: number;
}

interface ResponseBudget extends GitReviewLoadedBodyTotals {
  exhausted: boolean;
}

export function planReviewDiffBatches(
  files: readonly RegisteredGitReviewFile[],
): RegisteredGitReviewFile[][] {
  const batches: RegisteredGitReviewFile[][] = [];
  let current: RegisteredGitReviewFile[] = [];
  let currentRows = 0;
  for (const file of files) {
    const rows = Math.max(1, file.estimatedRows);
    if (
      current.length > 0 &&
      (current.length >= GIT_REVIEW_DOCUMENT_LIMITS.maxBodyBatchFiles ||
        currentRows + rows > TARGET_BATCH_ESTIMATED_ROWS)
    ) {
      batches.push(current);
      current = [];
      currentRows = 0;
    }
    current.push(file);
    currentRows += rows;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function isUntracked(document: RegisteredGitReviewDocument, file: RegisteredGitReviewFile): boolean {
  if (file.change.kind === 'tree-diff') return file.change.rawStatus.startsWith('?');
  if (document.source.kind !== 'workbench' || document.source.mode !== 'working') return false;
  return file.change.indexStatus === '?' || file.change.workTreeStatus === '?';
}

function expectedStatus(
  document: RegisteredGitReviewDocument,
  file: RegisteredGitReviewFile,
): string {
  if (file.change.kind === 'tree-diff') return file.change.rawStatus.slice(0, 1);
  return document.source.kind === 'workbench' && document.source.mode === 'staged'
    ? file.change.indexStatus
    : file.change.workTreeStatus;
}

function splitMatches(
  document: RegisteredGitReviewDocument,
  file: RegisteredGitReviewFile,
  split: SplitRawDiffPatch,
): boolean {
  const expected = expectedStatus(document, file);
  const actual = split.rawStatus.slice(0, 1);
  if (expected && expected !== ' ' && expected !== actual) return false;
  return (file.originalPath ?? null) === (split.originalPath ?? null);
}

function diffArgs(
  document: RegisteredGitReviewDocument,
  files: readonly RegisteredGitReviewFile[],
  fallback: boolean,
): string[] {
  const paths = files.flatMap((file) =>
    file.originalPath ? [file.originalPath, file.path] : [file.path],
  );
  const endpoints: string[] = [];
  let cached = false;
  switch (document.source.kind) {
    case 'workbench':
      cached = document.source.mode === 'staged';
      if (cached) endpoints.push(document.source.stagedBaseHash);
      break;
    case 'commit':
      endpoints.push(document.source.baseHash, document.source.targetHash);
      break;
    case 'comparison-revisions':
      endpoints.push(document.source.effectiveFromHash, document.source.toHash);
      break;
    case 'comparison-working-tree':
      endpoints.push(document.source.effectiveFromHash);
      break;
  }
  return [
    'diff',
    '--patch-with-raw',
    '-z',
    '--no-color',
    '--no-ext-diff',
    `-U${document.context}`,
    '--find-renames',
    '--submodule=short',
    ...(cached ? ['--cached'] : []),
    ...(fallback && files[0]?.originalPath ? ['--diff-filter=RC'] : []),
    ...endpoints,
    '--',
    ...exactGitPathspecs(paths),
  ];
}

async function loadUntrackedBody(
  document: RegisteredGitReviewDocument,
  file: RegisteredGitReviewFile,
  routeMetrics?: GitReviewRouteMetrics,
  signal?: AbortSignal,
): Promise<GitReviewFilePatchBody> {
  try {
    signal?.throwIfAborted();
    const filePath = resolvePathWithinProject(document.repoRoot, file.path);
    const stats = await fs.lstat(filePath);
    signal?.throwIfAborted();
    if (!stats.isFile()) {
      return limitedPatchFileBody(
        file.path,
        file.bodyFingerprint,
        'unsupported-file-kind',
        'Only regular untracked files can be reviewed.',
      );
    }
    if (stats.size > GIT_REVIEW_DOCUMENT_LIMITS.maxFilePatchBytes) {
      return limitedPatchFileBody(
        file.path,
        file.bodyFingerprint,
        'file-too-many-bytes',
        `File exceeds ${GIT_REVIEW_DOCUMENT_LIMITS.maxFilePatchBytes} byte display limit.`,
      );
    }
    if (await isBinaryFile(filePath)) {
      return limitedPatchFileBody(
        file.path,
        file.bodyFingerprint,
        'binary',
        'Binary diff is not available.',
      );
    }
    const content = await fs.readFile(filePath, 'utf8');
    signal?.throwIfAborted();
    return measureGitReviewPhaseSync(
      routeMetrics,
      'patch-scan',
      () => compactRenderedPatch(
        file.path,
        file.bodyFingerprint,
        buildFullFileAddedPatch(content),
      ),
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    return errorPatchFileBody(
      file.path,
      file.bodyFingerprint,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function runTrackedBatch(
  document: RegisteredGitReviewDocument,
  files: RegisteredGitReviewFile[],
  trace: GitCommandTrace[] | undefined,
  signal: AbortSignal | undefined,
  metrics: GitReviewDiffBatchMetrics,
  routeMetrics?: GitReviewRouteMetrics,
): Promise<GitReviewFilePatchBody[]> {
  metrics.batchCount += 1;
  try {
    const { stdout } = await measureGitReviewPhase(
      routeMetrics,
      'body-git',
      () => runGitTraced(
        document.repoRoot,
        diffArgs(document, files, false),
        trace,
        readOnlyGitOptions({ signal, maxStdoutBytes: MAX_BATCH_STDOUT_BYTES }),
      ),
    );
    const split = measureGitReviewPhaseSync(
      routeMetrics,
      'body-split',
      () => splitPatchesFromRawDiff(stdout),
    );
    const bodies: GitReviewFilePatchBody[] = [];
    for (const file of files) {
      let entry = split.get(file.path);
      if (!entry || !splitMatches(document, file, entry)) {
        const fallback = await measureGitReviewPhase(
          routeMetrics,
          'body-git',
          () => runGitTraced(
            document.repoRoot,
            diffArgs(document, [file], true),
            trace,
            readOnlyGitOptions({
              signal,
              maxStdoutBytes: GIT_REVIEW_DOCUMENT_LIMITS.maxFilePatchBytes + 1_000_000,
            }),
          ),
        );
        entry = measureGitReviewPhaseSync(
          routeMetrics,
          'body-split',
          () => splitPatchesFromRawDiff(fallback.stdout).get(file.path),
        );
      }
      if (!entry || !splitMatches(document, file, entry)) {
        bodies.push(errorPatchFileBody(
          file.path,
          file.bodyFingerprint,
          `Git diff output did not match the registered change for ${file.path}.`,
        ));
        continue;
      }
      bodies.push(measureGitReviewPhaseSync(
        routeMetrics,
        'patch-scan',
        () => compactRenderedPatch(
          file.path,
          file.bodyFingerprint,
          entry.patch,
          { allowMultipleFileSections: entry.patchSectionCount > 1 },
        ),
      ));
    }
    return bodies;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (files.length > 1) {
      metrics.bisectionCount += 1;
      const midpoint = Math.ceil(files.length / 2);
      return [
        ...await runTrackedBatch(
          document,
          files.slice(0, midpoint),
          trace,
          signal,
          metrics,
          routeMetrics,
        ),
        ...await runTrackedBatch(
          document,
          files.slice(midpoint),
          trace,
          signal,
          metrics,
          routeMetrics,
        ),
      ];
    }
    const file = files[0];
    if (error instanceof GitOutputLimitError) {
      return [limitedPatchFileBody(
        file.path,
        file.bodyFingerprint,
        'file-too-many-bytes',
        `Diff exceeds ${GIT_REVIEW_DOCUMENT_LIMITS.maxFilePatchBytes} byte display limit.`,
      )];
    }
    return [errorPatchFileBody(
      file.path,
      file.bodyFingerprint,
      error instanceof Error ? error.message : String(error),
    )];
  }
}

export async function loadReviewDiffBatches(
  document: RegisteredGitReviewDocument,
  requestedFiles: readonly RegisteredGitReviewFile[],
  trace?: GitCommandTrace[],
  signal?: AbortSignal,
  routeMetrics?: GitReviewRouteMetrics,
  initialTotals: GitReviewLoadedBodyTotals = { loadedRows: 0, loadedBytes: 0 },
): Promise<GitReviewDiffBatchResult> {
  const metrics = { batchCount: 0, bisectionCount: 0 };
  const bodies: GitReviewFilePatchBody[] = [];
  const errors: Record<string, string> = {};
  const tracked: RegisteredGitReviewFile[] = [];
  const untracked: RegisteredGitReviewFile[] = [];
  const budget = createResponseBudget(initialTotals);

  for (const file of requestedFiles) {
    if (file.bodyState !== 'unloaded') {
      appendWithinResponseBudget(bodies, budget, limitedPatchFileBody(
        file.path,
        file.bodyFingerprint,
        file.limitReason ?? 'unsupported-file-kind',
        file.limitMessage ?? 'This file cannot be rendered.',
      ));
    } else if (isUntracked(document, file)) {
      untracked.push(file);
    } else {
      tracked.push(file);
    }
  }

  if (budget.exhausted) {
    const firstUnloaded = untracked[0] ?? tracked[0];
    if (firstUnloaded) bodies.push(responseLimitBody(firstUnloaded, budget));
  }
  for (
    let offset = 0;
    offset < untracked.length && !budget.exhausted;
    offset += GIT_REVIEW_DOCUMENT_LIMITS.bodyConcurrency
  ) {
    const group = untracked.slice(offset, offset + GIT_REVIEW_DOCUMENT_LIMITS.bodyConcurrency);
    const loaded = await mapWithConcurrencyResult(
      group,
      GIT_REVIEW_DOCUMENT_LIMITS.bodyConcurrency,
      (file) => loadUntrackedBody(document, file, routeMetrics, signal),
    );
    for (const body of loaded) {
      appendWithinResponseBudget(bodies, budget, body);
      if (budget.exhausted) break;
    }
  }
  for (const batch of planReviewDiffBatches(tracked)) {
    if (budget.exhausted) break;
    const loaded = await runTrackedBatch(
      document,
      batch,
      trace,
      signal,
      metrics,
      routeMetrics,
    );
    for (const body of loaded) {
      appendWithinResponseBudget(bodies, budget, body);
      if (budget.exhausted) break;
    }
  }
  for (const body of bodies) {
    if (body.error) errors[body.path] = body.error;
  }
  if (routeMetrics) {
    routeMetrics.batchCount = (routeMetrics.batchCount ?? 0) + metrics.batchCount;
    routeMetrics.bisectionCount =
      (routeMetrics.bisectionCount ?? 0) + metrics.bisectionCount;
  }
  return { bodies, errors, metrics };
}

export function loadedGitReviewBodyTotals(
  bodies: Iterable<GitReviewFilePatchBody>,
): GitReviewLoadedBodyTotals {
  let loadedRows = 0;
  let loadedBytes = 0;
  for (const body of bodies) {
    if (body.bodyState !== 'loaded') continue;
    loadedRows += body.renderedRowCount;
    loadedBytes += body.patchBytes;
  }
  return { loadedRows, loadedBytes };
}

export function isGitReviewCollectionLimitBody(body: GitReviewFilePatchBody): boolean {
  return body.limitReason === 'collection-too-many-rows'
    || body.limitReason === 'collection-too-many-bytes';
}

export function limitGitReviewResponseBodies(
  candidates: Iterable<GitReviewFilePatchBody>,
): GitReviewFilePatchBody[] {
  const bodies: GitReviewFilePatchBody[] = [];
  const budget = createResponseBudget({ loadedRows: 0, loadedBytes: 0 });
  for (const body of candidates) {
    appendWithinResponseBudget(bodies, budget, body);
    if (budget.exhausted) break;
  }
  return bodies;
}

function createResponseBudget(initialTotals: GitReviewLoadedBodyTotals): ResponseBudget {
  return {
    ...initialTotals,
    exhausted:
      initialTotals.loadedRows >= GIT_REVIEW_DOCUMENT_LIMITS.maxLoadedRows
      || initialTotals.loadedBytes >= GIT_REVIEW_DOCUMENT_LIMITS.maxLoadedPatchBytes,
  };
}

function appendWithinResponseBudget(
  bodies: GitReviewFilePatchBody[],
  budget: ResponseBudget,
  body: GitReviewFilePatchBody,
): void {
  if (budget.exhausted) return;
  if (isGitReviewCollectionLimitBody(body)) {
    bodies.push(body);
    budget.exhausted = true;
    return;
  }
  if (body.bodyState !== 'loaded') {
    bodies.push(body);
    return;
  }
  const rowsExceeded =
    budget.loadedRows + body.renderedRowCount > GIT_REVIEW_DOCUMENT_LIMITS.maxLoadedRows;
  const bytesExceeded =
    budget.loadedBytes + body.patchBytes > GIT_REVIEW_DOCUMENT_LIMITS.maxLoadedPatchBytes;
  if (!rowsExceeded && !bytesExceeded) {
    bodies.push(body);
    budget.loadedRows += body.renderedRowCount;
    budget.loadedBytes += body.patchBytes;
    return;
  }
  const reason = rowsExceeded ? 'collection-too-many-rows' : 'collection-too-many-bytes';
  bodies.push(responseLimitBody(body, budget, reason));
  budget.exhausted = true;
}

function responseLimitBody(
  file: Pick<RegisteredGitReviewFile, 'path' | 'bodyFingerprint'>,
  budget: GitReviewLoadedBodyTotals,
  reason: 'collection-too-many-rows' | 'collection-too-many-bytes' =
    budget.loadedRows >= GIT_REVIEW_DOCUMENT_LIMITS.maxLoadedRows
      ? 'collection-too-many-rows'
      : 'collection-too-many-bytes',
): GitReviewFilePatchBody {
  const amount = reason === 'collection-too-many-rows'
    ? `${budget.loadedRows.toLocaleString()} rendered rows`
    : `${budget.loadedBytes.toLocaleString()} patch bytes`;
  return limitedPatchFileBody(
    file.path,
    file.bodyFingerprint,
    reason,
    `Stopped loading after ${amount}.`,
  );
}
