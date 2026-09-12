import { isRecord } from '@garcon/common/json';
import { snapshotEstablishedSession, type AgentEstablishedSession, type AgentIntegration, type AgentNativeFork, type AgentNativeForkOutcome } from '@garcon/server-agent-interface';
import type {
  ProviderNativeForkDiscardRequest,
  ProviderNativeForkRequest,
  ProviderNativeForkService,
} from '../execution-nodes/provider-native-fork.js';
import { assertNativeChatOwner, parseNativeChatReference } from './local-native-chat-reference.js';
import { LocalProviderConfigurationService } from './local-provider-configuration.js';

export class LocalProviderNativeForkService implements ProviderNativeForkService {
  readonly #configuration: LocalProviderConfigurationService;

  constructor(
    private readonly integration: Pick<AgentIntegration, 'descriptor' | 'settings' | 'endpoints' | 'sessionConfiguration'>,
    private readonly forking: AgentNativeFork,
  ) {
    this.#configuration = new LocalProviderConfigurationService(integration);
  }

  async fork(input: ProviderNativeForkRequest, signal: AbortSignal): Promise<AgentNativeForkOutcome> {
    signal.throwIfAborted();
    const request = structuredClone(input);
    assertNativeChatOwner(this.integration, request.source);
    const sourceInput = { ...request.source, settings: structuredClone(request.source.settings ?? this.integration.settings.defaults()) };
    const configuration = await this.#configuration.resolve(request.configuration, signal);
    signal.throwIfAborted();
    const source = parseNativeChatReference(this.integration, sourceInput);
    signal.throwIfAborted();
    let result: AgentNativeForkOutcome;
    try {
      result = await this.forking.fork({
        ...configuration,
        chatId: request.chatId,
        projectPath: source.projectPath,
        source,
        providerMeta: request.providerMeta,
        admission: { signal, markStarted: async () => { signal.throwIfAborted(); } },
      });
    } catch (error) {
      signal.throwIfAborted();
      throw error;
    }
    let artifact: AgentEstablishedSession | undefined;
    let cleanupFailure: { error: unknown } | null = null;
    try {
      if (result !== null && (typeof result === 'object' || typeof result === 'function')
        && 'session' in result) {
        try { artifact = structuredClone(result.session); }
        catch (error) {
          cleanupFailure = { error: new Error('Native fork cleanup is unconfirmed because its artifact could not be captured', { cause: error }) };
          throw error;
        }
      }
      if (!isRecord(result)) throw new TypeError('Invalid native fork outcome');
      const kind = result.kind;
      const prototype = Object.getPrototypeOf(result);
      const ownKeys = Reflect.ownKeys(result);
      if ((prototype !== Object.prototype && prototype !== null)
        || !Object.hasOwn(result, 'kind')) throw new TypeError('Invalid native fork outcome');
      if (kind === 'unmaterialized' && ownKeys.length === 1) {
        signal.throwIfAborted();
        return { kind: 'unmaterialized' };
      }
      if (kind !== 'materialized' || ownKeys.length !== 2
        || !Object.hasOwn(result, 'session')) throw new TypeError('Invalid native fork outcome');
      const session = snapshotEstablishedSession(artifact);
      this.#assertSessionOwner(session);
      // Cancellation cannot hide an artifact that the controller still needs to discard.
      return { kind: 'materialized', session };
    } catch (error) {
      try {
        if (artifact !== undefined) await this.forking.discard(artifact, new AbortController().signal);
      } catch (cleanupError) {
        cleanupFailure = { error: cleanupError };
      }
      const primary = signal.aborted ? signal.reason : error;
      if (cleanupFailure) {
        throw new AggregateError([primary, cleanupFailure.error],
          primary instanceof Error ? primary.message : 'Native fork and cleanup failed');
      }
      throw primary;
    }
  }

  async discard(request: ProviderNativeForkDiscardRequest, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const session = snapshotEstablishedSession(request.session);
    this.#assertSessionOwner(session);
    await this.forking.discard(session, signal);
    signal.throwIfAborted();
  }

  #assertSessionOwner(session: AgentEstablishedSession): void {
    if (session.nativeSession !== null && session.nativeSession.ownerId !== this.integration.descriptor.id) {
      throw new Error('Native session owner mismatch');
    }
  }
}
