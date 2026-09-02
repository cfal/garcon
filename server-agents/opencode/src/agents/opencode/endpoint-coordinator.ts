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
      this.#options.onActivity();
    });
    try {
      return await operation(client);
    } finally {
      this.#requestLeases -= 1;
      this.#options.onActivity();
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

  async forkSession(
    sourceSessionId: string,
    options: { projectPath?: string | null; messageId?: string; signal?: AbortSignal },
    runScopedRequest: ScopedSessionRequest,
  ): Promise<string> {
    const sessionID = sourceSessionId.trim();
    if (!sessionID) throw new Error('Cannot fork OpenCode session: missing source session id');
    const scope = createOpenCodeRequestScope(options.projectPath);
    const result: any = await this.withClientLease((client) => runScopedRequest(
      'OpenCode session fork',
      scope,
      (signal, requestScope) => client.session.fork(
        withOpenCodeRequestScope({
          sessionID,
          ...(options.messageId ? { messageID: options.messageId } : {}),
        }, requestScope),
        { signal },
      ),
      { signal: options.signal, timeoutMs: null },
    ));
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
    const forkedSessionId = typeof result?.data?.id === 'string' ? result.data.id.trim() : '';
    if (!forkedSessionId) throw new Error('OpenCode session fork did not return a session id');
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
