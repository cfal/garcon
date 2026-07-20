import { AgentTranscriptIndexError, type AgentLogger } from '@garcon/server-agent-interface';
import {
  createOpenCodeRequestScope,
  throwOpenCodeResultError,
  withOpenCodeRequestScope,
  type OpenCodeRequestScope,
} from './sdk-result.js';

interface OpenCodeEndpointInstance {
  readonly client: unknown;
  readonly baseUrl?: string;
}

interface OpenCodeEndpointCoordinatorOptions {
  readonly assertAvailable: () => void;
  readonly ensureUnlocked: () => Promise<OpenCodeEndpointInstance>;
  readonly closeInstance: () => void;
  readonly hasRunningSessions: () => boolean;
  readonly logger: AgentLogger;
}

type ScopedSessionRequest = <T>(
  label: string,
  scope: OpenCodeRequestScope,
  operation: (signal: AbortSignal, scope: OpenCodeRequestScope) => Promise<T>,
) => Promise<T>;

export class OpenCodeEndpointCoordinator {
  readonly #options: OpenCodeEndpointCoordinatorOptions;
  #requestLeases = 0;
  #turnAdmissions = 0;
  #refreshPromise: Promise<string> | null = null;
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

  async withClientLease<T>(operation: (client: any) => Promise<T>): Promise<T> {
    let client: any;
    await this.runTransition(async () => {
      this.#options.assertAvailable();
      client = (await this.#options.ensureUnlocked()).client;
      this.#requestLeases += 1;
    });
    try {
      return await operation(client);
    } finally {
      this.#requestLeases -= 1;
    }
  }

  requestStarted(): void {
    this.#requestLeases += 1;
  }

  requestFinished(): void {
    this.#requestLeases -= 1;
  }

  turnAdmissionStarted(): void {
    this.#turnAdmissions += 1;
  }

  turnAdmissionFinished(): void {
    this.#turnAdmissions -= 1;
  }

  async getTranscriptEndpoint(signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const instance = await this.runTransition(() => this.#options.ensureUnlocked());
    signal.throwIfAborted();
    if (!instance.baseUrl) throw new Error('OpenCode server did not expose a base URL');
    return instance.baseUrl;
  }

  refreshTranscriptEndpoint(failedBaseUrl: string, signal: AbortSignal): Promise<string> {
    if (this.#refreshPromise) return this.#refreshPromise;
    const refresh = this.runTransition(async () => {
      signal.throwIfAborted();
      const current = await this.#options.ensureUnlocked();
      const baseUrl = current.baseUrl;
      if (!baseUrl) throw new Error('OpenCode server did not expose a base URL');
      if (baseUrl !== failedBaseUrl) return baseUrl;
      if (await endpointHealthy(baseUrl, signal)) return baseUrl;
      if (this.#options.hasRunningSessions() || !this.idle) {
        throw new AgentTranscriptIndexError({
          kind: 'agent-transcript-index-failure',
          code: 'SOURCE_ENDPOINT_IN_USE',
          retryable: true,
          refreshSource: true,
        });
      }
      this.#options.closeInstance();
      const replacement = await this.#options.ensureUnlocked();
      signal.throwIfAborted();
      if (!replacement.baseUrl) throw new Error('OpenCode server did not expose a base URL');
      return replacement.baseUrl;
    }).finally(() => {
      if (this.#refreshPromise === refresh) this.#refreshPromise = null;
    });
    this.#refreshPromise = refresh;
    return refresh;
  }

  async forkSession(
    sourceSessionId: string,
    projectPath: string | null | undefined,
    runScopedRequest: ScopedSessionRequest,
  ): Promise<string> {
    const sessionID = sourceSessionId.trim();
    if (!sessionID) throw new Error('Cannot fork OpenCode session: missing source session id');
    const scope = createOpenCodeRequestScope(projectPath);
    const result: any = await this.withClientLease((client) => runScopedRequest(
      'OpenCode session fork',
      scope,
      (signal, requestScope) => client.session.fork(
        withOpenCodeRequestScope({ sessionID }, requestScope),
        { signal },
      ),
    ));
    throwOpenCodeResultError(result, 'OpenCode session fork failed');
    const forkedSessionId = typeof result?.data?.id === 'string' ? result.data.id.trim() : '';
    if (!forkedSessionId) throw new Error('OpenCode session fork did not return a session id');
    this.#options.logger.info('OpenCode session forked', { sourceSessionId: sessionID, forkedSessionId });
    return forkedSessionId;
  }
}

async function endpointHealthy(baseUrl: string, signal: AbortSignal): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  timeout.unref?.();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  try {
    await fetch(baseUrl, { signal: controller.signal });
    return true;
  } catch {
    signal.throwIfAborted();
    return false;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
}
