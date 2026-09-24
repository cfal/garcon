import { AsyncLocalStorage } from 'node:async_hooks';
import type { NodeCallOptions } from '@garcon/server-agent-interface';
import { GIT_MAX_RESULT_BYTES, GIT_OPERATION_TIMEOUT_MS } from '../../common/git-execution.js';
import { GitServiceError } from '../../common/git-error.js';
import { resolveRealWithinBase } from '../lib/path-boundary.js';
import type { GitCommandOptions } from './types.js';

interface GitOperation {
  readonly signal: AbortSignal;
  readonly deadline: number;
  root: string;
  readonly pending: Set<Promise<unknown>>;
  closed: boolean;
  outputTruncated: boolean;
  mutationDispatched: boolean;
}

const operations = new AsyncLocalStorage<GitOperation>();

export async function withGitOperation<T>(root: string, options: (NodeCallOptions & { mutation?: boolean }) | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? GIT_OPERATION_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  const signal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const current: GitOperation = { root, signal, deadline: performance.now() + timeoutMs, pending: new Set(), closed: false, outputTruncated: false, mutationDispatched: false };
  try {
    const result = await operations.run(current, async () => {
      signal.throwIfAborted();
      try { return await operation(signal); }
      catch (error) {
        if (options?.mutation && current.mutationDispatched && (signal.aborted || isGitCancellation(error))) {
          throw new GitServiceError('GIT_MUTATION_OUTCOME_UNKNOWN', 'Git mutation was interrupted after dispatch. Inspect the repository before trying again.');
        }
        throw error;
      }
      finally { await settleGitProcesses(); }
    });
    if (!options?.mutation) signal.throwIfAborted();
    return result;
  } finally { clearTimeout(timer); }
}

export function isGitCancellation(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'
    || 'aborted' in error && error.aborted === true || 'timedOut' in error && error.timedOut === true
    || error instanceof GitServiceError && error.code === 'GIT_TIMEOUT');
}

export function gitOperationSignal(): AbortSignal | undefined { return operations.getStore()?.signal; }

export function markGitMutationDispatched(): void {
  const current = operations.getStore();
  if (current) current.mutationDispatched = true;
}

// Parallel native commands must settle before their repository lock can be released.
export async function settleGitProcesses(): Promise<void> {
  const current = operations.getStore();
  if (!current) return;
  current.closed = true;
  while (current.pending.size) await Promise.allSettled([...current.pending]);
}

export function trackGitProcess<T>(operation: () => Promise<T>): Promise<T> {
  const current = operations.getStore();
  const result = operation();
  if (current) {
    current.pending.add(result);
    void result.then(() => current.pending.delete(result), () => current.pending.delete(result));
  }
  return result;
}

export function gitOperationOptions(options: GitCommandOptions): GitCommandOptions {
  const current = operations.getStore();
  if (!current) return options;
  if (current.closed || current.signal.aborted) throw new GitServiceError('GIT_TIMEOUT', 'Git operation expired or was cancelled');
  return {
    ...options,
    signal: options.signal ? AbortSignal.any([options.signal, current.signal]) : current.signal,
    timeoutMs: Math.max(1, Math.min(options.timeoutMs ?? GIT_OPERATION_TIMEOUT_MS, current.deadline - performance.now())),
    maxStdoutBytes: Math.min(options.maxStdoutBytes ?? (options.disableOptionalLocks ? GIT_MAX_RESULT_BYTES : 32_768), GIT_MAX_RESULT_BYTES),
    truncateStdout: options.truncateStdout ?? !options.disableOptionalLocks,
    env: { ...options.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  };
}

export async function assertGitWorkingPath(filePath: string): Promise<void> {
  const current = operations.getStore();
  current?.signal.throwIfAborted();
  if (current) await resolveRealWithinBase(current.root, filePath);
}

export function restrictGitWorkingRoot(root: string): void {
  const current = operations.getStore();
  if (current) current.root = root;
}

export function markGitOutputTruncated(): void {
  const current = operations.getStore();
  if (current) current.outputTruncated = true;
}

export function gitOutputTruncated(): boolean { return operations.getStore()?.outputTruncated === true; }
