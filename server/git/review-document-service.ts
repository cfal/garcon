import { GitDomainError } from './git-types.js';
import {
  isGitReviewCollectionLimitBody,
  limitGitReviewResponseBodies,
  loadedGitReviewBodyTotals,
  loadReviewDiffBatches,
} from './review-diff-batch.js';
import {
  GitReviewDocumentRegistry,
  type GitReviewDocumentSource,
} from './review-document-registry.js';
import {
  captureWorkingPathTokens,
  changedWorkingPathTokens,
  type GitWorkingPathToken,
} from './working-path-token.js';
import type {
  GitReviewBodyPurpose,
  GitReviewDocumentFileBodiesOptions,
  GitReviewDocumentFileBodiesResponse,
} from './types.js';
import {
  measureGitReviewPhase,
  measureGitReviewPhaseSync,
} from './review-performance.js';

interface QueuedPrefetch<T> {
  signal?: AbortSignal;
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

class GitReviewBodyExecutor {
  private readonly prefetchQueue: QueuedPrefetch<unknown>[] = [];
  private prefetchRunning = false;

  run<T>(purpose: GitReviewBodyPurpose, signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
    if (purpose === 'visible') return task();
    return new Promise<T>((resolve, reject) => {
      this.prefetchQueue.push({
        signal,
        task,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.pumpPrefetch();
    });
  }

  private pumpPrefetch(): void {
    if (this.prefetchRunning) return;
    const queued = this.prefetchQueue.shift();
    if (!queued) return;
    if (queued.signal?.aborted) {
      queued.reject(queued.signal.reason);
      this.pumpPrefetch();
      return;
    }
    this.prefetchRunning = true;
    void queued.task()
      .then(queued.resolve, queued.reject)
      .finally(() => {
        this.prefetchRunning = false;
        this.pumpPrefetch();
      });
  }
}

function isMutableDocument(source: GitReviewDocumentSource): boolean {
  return source.kind === 'workbench' || source.kind === 'comparison-working-tree';
}

function tokenScope(sourceKind: string, mode?: string): 'working-tree' | 'index' {
  return sourceKind === 'workbench' && mode === 'staged' ? 'index' : 'working-tree';
}

function expectedTokens(
  allTokens: ReadonlyMap<string, GitWorkingPathToken>,
  paths: readonly string[],
): Map<string, GitWorkingPathToken> {
  const tokens = new Map<string, GitWorkingPathToken>();
  for (const path of paths) {
    const token = allTokens.get(path);
    if (!token) {
      throw new GitDomainError(
        'STALE_DOCUMENT',
        `The review no longer has working-tree identity for ${path}.`,
      );
    }
    tokens.set(path, token);
  }
  return tokens;
}

export function createReviewDocumentOperations(registry: GitReviewDocumentRegistry) {
  const executor = new GitReviewBodyExecutor();

  return {
    async getReviewDocumentFileBodies(
      options: GitReviewDocumentFileBodiesOptions,
    ): Promise<GitReviewDocumentFileBodiesResponse> {
      return executor.run(options.purpose, options.signal, async () => {
        const lease = measureGitReviewPhaseSync(
          options.metrics,
          'resolve',
          () => registry.acquire(options.projectPath, options.documentId),
        );
        if (!lease) {
          return {
            status: 'document-expired',
            documentId: options.documentId,
            message: 'This review expired. Refresh it to load the latest diff.',
          };
        }

        try {
          const requestedPaths = Array.from(new Set(options.files));
          const requestedFiles = measureGitReviewPhaseSync(
            options.metrics,
            'resolve',
            () => requestedPaths.map((path) => {
              const file = lease.document.filesByPath.get(path);
              if (!file) {
                throw new GitDomainError('INVALID_INPUT', `The review does not contain ${path}.`);
              }
              return file;
            }),
          );
          const mutable = isMutableDocument(lease.document.source);
          const freshnessPaths = requestedFiles.flatMap((file) =>
            file.originalPath ? [file.path, file.originalPath] : [file.path],
          );
          const expected = mutable
            ? expectedTokens(lease.document.workingPathTokens, freshnessPaths)
            : new Map<string, GitWorkingPathToken>();
          const scope = tokenScope(
            lease.document.source.kind,
            lease.document.source.kind === 'workbench' ? lease.document.source.mode : undefined,
          );

          if (mutable) {
            const before = await measureGitReviewPhase(
              options.metrics,
              'freshness-before',
              () => captureWorkingPathTokens(
                lease.document.repoRoot,
                freshnessPaths,
                { scope },
                options.signal,
              ),
            );
            const changedPaths = changedWorkingPathTokens(expected, before);
            if (changedPaths.length > 0) {
              return {
                status: 'stale',
                documentId: options.documentId,
                changedPaths,
                message: 'The requested files changed. Refresh the review to load the latest diff.',
              };
            }
          }

          const cached = measureGitReviewPhaseSync(
            options.metrics,
            'body-cache',
            () => new Map(
              requestedPaths.flatMap((path) => {
                const body = lease.getBody(path);
                return body ? [[path, body] as const] : [];
              }),
            ),
          );
          if (options.metrics) options.metrics.cacheHits = cached.size;
          const missing = requestedFiles.filter((file) => !cached.has(file.path));
          let errors: Record<string, string> = {};
          if (missing.length > 0) {
            const cachedTotals = loadedGitReviewBodyTotals(cached.values());
            const loaded = await loadReviewDiffBatches(
              lease.document,
              missing,
              options.trace,
              options.signal,
              options.metrics,
              cachedTotals,
            );
            errors = loaded.errors;
            for (const body of loaded.bodies) cached.set(body.path, body);
            if (mutable) {
              const after = await measureGitReviewPhase(
                options.metrics,
                'freshness-after',
                () => captureWorkingPathTokens(
                  lease.document.repoRoot,
                  freshnessPaths,
                  { scope },
                  options.signal,
                ),
              );
              const changedPaths = changedWorkingPathTokens(expected, after);
              if (changedPaths.length > 0) {
                return {
                  status: 'stale',
                  documentId: options.documentId,
                  changedPaths,
                  message: 'The requested files changed while the diff was loading. Refresh the review.',
                };
              }
            }
            lease.setBodies(loaded.bodies.filter(
              (body) => body.bodyState !== 'error' && !isGitReviewCollectionLimitBody(body),
            ));
          }

          const responseBodies = limitGitReviewResponseBodies(
            requestedPaths.flatMap((path) => {
              const body = cached.get(path);
              return body ? [body] : [];
            }),
          );
          const files = Object.fromEntries(responseBodies.map((body) => [body.path, body]));
          if (options.metrics) {
            options.metrics.fileCount = Object.keys(files).length;
            options.metrics.rowCount = Object.values(files).reduce(
              (total, body) => total + body.renderedRowCount,
              0,
            );
          }
          return {
            status: 'ready',
            documentId: options.documentId,
            files,
            errors,
          };
        } finally {
          lease.release();
        }
      });
    },
  };
}
