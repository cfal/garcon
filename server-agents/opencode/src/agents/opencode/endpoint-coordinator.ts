import { AgentIntegrationError, type AgentLogger } from '@garcon/server-agent-interface';
import {
  createOpenCodeRequestScope,
  isOpenCodeNotFoundResult,
  openCodeResultErrorMessage,
  throwOpenCodeResultError,
  withOpenCodeRequestScope,
  type OpenCodeRequestScope,
} from './sdk-result.js';

interface OpenCodeEndpointInstance {
  readonly client: unknown;
}

interface OpenCodeClientLease {
  readonly client: any;
  release(): void;
}

interface OpenCodeEndpointCoordinatorOptions {
  readonly assertAvailable: () => void;
  readonly ensureUnlocked: () => Promise<OpenCodeEndpointInstance>;
  readonly logger: AgentLogger;
  readonly onActivity: () => void;
}

type ScopedSessionRequest = <T>(
  label: string,
  scope: OpenCodeRequestScope,
  operation: (signal: AbortSignal, scope: OpenCodeRequestScope) => Promise<T>,
  control?: { signal?: AbortSignal; timeoutMs?: number | null },
) => Promise<T>;

type OpenCodeRequest = <T>(
  label: string,
  operation: (signal: AbortSignal) => Promise<T>,
  control?: { signal?: AbortSignal; timeoutMs?: number | null },
) => Promise<T>;

export class OpenCodeEndpointCoordinator {
  readonly #options: OpenCodeEndpointCoordinatorOptions;
  #requestLeases = 0;
  #turnAdmissions = 0;
  readonly #protectedNativeWork = new Set<Promise<unknown>>();
  #transitionTail: Promise<void> = Promise.resolve();

  constructor(options: OpenCodeEndpointCoordinatorOptions) {
    this.#options = options;
  }

  get idle(): boolean {
    return this.#requestLeases === 0 && this.#turnAdmissions === 0;
  }

  async runTransition<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#transitionTail;
    let release!: () => void;
    this.#transitionTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async withClientLease<T>(
    operation: (client: any) => Promise<T>,
    admissionSignal?: AbortSignal,
  ): Promise<T> {
    const pendingLease = this.runTransition(async (): Promise<OpenCodeClientLease> => {
      admissionSignal?.throwIfAborted();
      this.#options.assertAvailable();
      const client = (await this.#options.ensureUnlocked()).client;
      admissionSignal?.throwIfAborted();
      this.#requestLeases += 1;
      this.#options.onActivity();
      let released = false;
      return {
        client,
        release: () => {
          if (released) return;
          released = true;
          this.#requestLeases -= 1;
          this.#options.onActivity();
        },
      };
    });
    let lease: OpenCodeClientLease;
    try {
      lease = admissionSignal
        ? await waitForPromiseOrAbort(pendingLease, admissionSignal)
        : await pendingLease;
      admissionSignal?.throwIfAborted();
    } catch (error) {
      void pendingLease.then((lateLease) => lateLease.release(), () => undefined);
      throw error;
    }
    try {
      return await operation(lease.client);
    } finally {
      lease.release();
    }
  }

  requestStarted(): void {
    this.#requestLeases += 1;
    this.#options.onActivity();
  }

  requestFinished(): void {
    this.#requestLeases -= 1;
    this.#options.onActivity();
  }

  turnAdmissionStarted(): void {
    this.#turnAdmissions += 1;
    this.#options.onActivity();
  }

  turnAdmissionFinished(): void {
    this.#turnAdmissions -= 1;
    this.#options.onActivity();
  }

  runProtectedNativeFork<T>(operation: () => Promise<T>): Promise<T> {
    return this.#trackProtectedNativeWork(operation);
  }

  runProtectedNativeCleanup<T>(operation: () => Promise<T>): Promise<T> {
    return this.#trackProtectedNativeWork(operation);
  }

  #trackProtectedNativeWork<T>(operation: () => Promise<T>): Promise<T> {
    const pending = operation();
    this.#protectedNativeWork.add(pending);
    void pending.then(
      () => this.#protectedNativeWork.delete(pending),
      () => this.#protectedNativeWork.delete(pending),
    );
    return pending;
  }

  async waitForProtectedNativeWork(
    timeoutMs: number,
    retainedDeletionCount: () => number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let pendingOperations = 0;
    while (this.#protectedNativeWork.size > 0) {
      const remainingMs = Math.max(0, deadline - Date.now());
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const completed = await Promise.race([
        Promise.allSettled([...this.#protectedNativeWork]).then(() => true),
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => resolve(false), remainingMs);
          timeout.unref?.();
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      if (!completed) {
        pendingOperations = this.#protectedNativeWork.size;
        break;
      }
    }
    const retainedDeletions = retainedDeletionCount();
    if (pendingOperations > 0 || retainedDeletions > 0) {
      this.#options.logger.warn('OpenCode shutdown abandoned native session cleanup', {
        pendingOperations,
        retainedDeletions,
        timeoutMs,
      });
    }
  }

  async forkSession(
    sourceSessionId: string,
    options: { projectPath?: string | null; messageId?: string; signal?: AbortSignal },
    runScopedRequest: ScopedSessionRequest,
    discardCancelledFork: (
      client: any,
      forkedSessionId: string,
      scope: OpenCodeRequestScope,
    ) => Promise<void>,
  ): Promise<string> {
    const sessionID = sourceSessionId.trim();
    if (!sessionID) throw new Error('Cannot fork OpenCode session: missing source session id');
    const scope = createOpenCodeRequestScope(options.projectPath);
    const forkedSessionId = await this.withClientLease(async (client) => {
      options.signal?.throwIfAborted();
      let result: any;
      try {
        result = await runScopedRequest(
          'OpenCode session fork',
          scope,
          (signal, requestScope) => client.session.fork(
            withOpenCodeRequestScope({
              sessionID,
              ...(options.messageId ? { messageID: options.messageId } : {}),
            }, requestScope),
            { signal },
          ),
          { timeoutMs: null },
        );
      } catch (error) {
        options.signal?.throwIfAborted();
        throw error;
      }
      const forkedSessionId = typeof result?.data?.id === 'string' ? result.data.id.trim() : '';
      if (options.signal?.aborted) {
        if (forkedSessionId) await discardCancelledFork(client, forkedSessionId, scope);
        options.signal.throwIfAborted();
      }
      // A source session the provider cannot return has no native fork position;
      // the typed source-level refusal keeps the handoff-fork consent flow
      // reachable instead of dead-ending the request in an untyped failure.
      if (isOpenCodeNotFoundResult(result)) {
        throw new AgentIntegrationError(
          'TRANSCRIPT_UNAVAILABLE',
          'The OpenCode source session is unavailable',
          true,
          { nativeForkReason: 'source-missing' },
        );
      }
      if (result?.error) {
        throw new AgentIntegrationError(
          'TRANSCRIPT_UNAVAILABLE',
          openCodeResultErrorMessage(result, 'OpenCode session fork failed'),
          true,
        );
      }
      if (!forkedSessionId) throw new Error('OpenCode session fork did not return a session id');
      return forkedSessionId;
    }, options.signal);
    this.#options.logger.info('OpenCode session forked', { sourceSessionId: sessionID, forkedSessionId });
    return forkedSessionId;
  }

  async moveSession(
    agentSessionId: string,
    directory: string,
    signal: AbortSignal,
    runRequest: OpenCodeRequest,
  ): Promise<void> {
    const sessionID = agentSessionId.trim();
    const destination = directory.trim();
    if (!sessionID) throw new Error('Cannot move OpenCode session: missing session id');
    if (!destination) throw new Error('Cannot move OpenCode session: missing destination directory');
    signal.throwIfAborted();

    await this.withClientLease(async (client) => {
      if (typeof client.experimental?.controlPlane?.moveSession !== 'function') {
        throw new AgentIntegrationError(
          'OPERATION_UNSUPPORTED',
          'This OpenCode version does not support project path updates',
          false,
        );
      }
      const result = await runRequest(
        'OpenCode session move',
        (requestSignal) => client.experimental.controlPlane.moveSession({
          sessionID,
          destination: { directory: destination },
        }, { signal: requestSignal }),
        { signal },
      );
      throwOpenCodeResultError(result, 'OpenCode session move failed');
    });
  }
}

function waitForPromiseOrAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      settle();
    };
    const onAbort = () => finish(() => reject(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
    if (signal.aborted) onAbort();
  });
}
