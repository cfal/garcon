import { AgentIntegrationError, type AgentLogger } from '@garcon/server-agent-interface';
import {
  createOpenCodeRequestScope,
  isOpenCodeNotFoundResult,
  openCodeResultErrorMessage,
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

  async forkSession(
    sourceSessionId: string,
    options: { projectPath?: string | null; messageId?: string },
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
    ));
    // A source session the provider cannot return has no native fork position;
    // the typed refusal keeps the handoff-fork consent flow reachable instead
    // of dead-ending the request in an untyped failure.
    if (isOpenCodeNotFoundResult(result)) {
      throw new AgentIntegrationError(
        'TRANSCRIPT_UNAVAILABLE',
        'The OpenCode source session has no provider-native fork position',
        true,
        { nativeForkReason: 'not-settled' },
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
}
