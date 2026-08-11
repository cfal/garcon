import { receiptForCarriedContext } from '@garcon/common/transcript-seed';
import {
  AgentIntegrationError,
  type AgentExecutionContextV4,
  type AgentHost,
} from '@garcon/server-agent-interface';
import {
  AgentProjectionProducerEventChannel,
  projectionProducerMessages,
  type AgentProjectionRuntimeExecution,
} from '../execution/projection-events.js';
import { AgentOperationTracker } from '../execution/operation-tracker.js';
import { resolveAgentEndpoint } from '../execution/resolve-endpoint.js';
import type { PathNativeSessionCodec } from '../native-session/path-native-session.js';
import type { DirectEndpointRouterRuntime, DirectCompatibleRuntime } from './router.js';

export class DirectExecution<TRuntime extends DirectCompatibleRuntime>
implements AgentProjectionRuntimeExecution {
  readonly #events = new AgentProjectionProducerEventChannel();
  readonly #operations = new AgentOperationTracker();

  constructor(
    private readonly host: AgentHost,
    private readonly runtime: DirectEndpointRouterRuntime<TRuntime>,
    private readonly nativeSessions: PathNativeSessionCodec,
  ) {
    runtime.onMessages((chatId, messages, metadata) => {
      const operation = this.#operations.current(chatId, metadata);
      if (operation) this.#events.emit({
        type: 'messages',
        chatId,
        messages: projectionProducerMessages(this.host.agentId, messages),
        operation,
      });
    });
    runtime.onProcessing((chatId, processing) => {
      const operation = this.#operations.current(chatId);
      if (operation) this.#events.emit({ type: 'processing', chatId, processing, operation });
    });
    runtime.onFinished((chatId, exitCode, metadata) => {
      const operation = this.#operations.current(chatId, metadata);
      if (!operation) return;
      this.#events.emit({ type: 'finished', chatId, exitCode, operation });
      this.#operations.finish(chatId, operation);
    });
    runtime.onFailed((chatId, message, metadata) => {
      const operation = this.#operations.current(chatId, metadata);
      if (!operation) return;
      this.#events.emit({
        type: 'failed',
        chatId,
        error: new AgentIntegrationError('PROVIDER_FAILURE', message, false),
        operation,
      });
      this.#operations.finish(chatId, operation);
    });
  }

  async start(request: Parameters<AgentProjectionRuntimeExecution['start']>[0]) {
    const endpoint = await this.#endpoint(request);
    this.#operations.register(request.chatId, request.operation);
    const seed = request.carriedContext?.prefix ?? '';
    try {
      const result = await this.runtime.startSession({
        ...executionFields(request),
        command: `${seed}${request.prompt}`,
        images: request.attachments,
        endpoint,
      });
      const session = {
        agentSessionId: result.agentSessionId,
        nativeSession: this.nativeSessions.encode({
          path: result.nativePath,
          agentSessionId: result.agentSessionId,
          modelEndpointId: endpoint.selection.endpointId,
        }),
        nativeSeedReceipt: receiptForCarriedContext(request.carriedContext, result.agentSessionId),
      };
      this.#events.emit({
        type: 'session-created',
        chatId: request.chatId,
        session,
        operation: request.operation,
      });
      return session;
    } catch (error) {
      this.#operations.finish(request.chatId, request.operation);
      throw error;
    }
  }

  async resume(request: Parameters<AgentProjectionRuntimeExecution['resume']>[0]): Promise<void> {
    const endpoint = await this.#endpoint(request);
    const nativeSession = this.nativeSessions.decode(request.nativeSession);
    if (
      nativeSession.modelEndpointId
      && nativeSession.modelEndpointId !== endpoint.selection.endpointId
    ) {
      throw new AgentIntegrationError(
        'INVALID_ENDPOINT',
        'Direct sessions cannot change API provider endpoints after they start',
        false,
      );
    }
    this.#operations.register(request.chatId, request.operation);
    try {
      await this.runtime.runTurn({
        ...executionFields(request),
        agentSessionId: request.agentSessionId,
        command: request.prompt,
        images: request.attachments,
        nativePath: nativeSession.path,
        endpoint,
      });
    } catch (error) {
      this.#operations.finish(request.chatId, request.operation);
      throw error;
    }
  }

  async abort(agentSessionId: string): Promise<boolean> {
    return this.runtime.abort(agentSessionId);
  }

  isRunning(agentSessionId: string): boolean {
    return this.runtime.isRunning(agentSessionId);
  }

  runningSessions() {
    return this.runtime.getRunningSessions().map((session) => ({
      agentSessionId: session.id,
      status: session.status ?? null,
      startedAt: session.startedAt ?? null,
    }));
  }

  async prepareProjectPathUpdate(
    request: Parameters<NonNullable<AgentProjectionRuntimeExecution['prepareProjectPathUpdate']>>[0],
  ): Promise<void> {
    request.signal.throwIfAborted();
  }

  subscribeProjectionEvents(
    listener: Parameters<AgentProjectionProducerEventChannel['subscribe']>[0],
  ): () => void {
    return this.#events.subscribe(listener);
  }

  async #endpoint(request: AgentExecutionContextV4) {
    const endpoint = await resolveAgentEndpoint(
      this.host,
      request.endpoint,
      request.admission.signal,
    );
    if (!endpoint) {
      throw new AgentIntegrationError(
        'INVALID_ENDPOINT',
        'A compatible API provider endpoint is required',
        false,
      );
    }
    return endpoint;
  }
}

function executionFields(request: AgentExecutionContextV4) {
  return {
    chatId: request.chatId,
    projectPath: request.projectPath,
    model: request.model,
    permissionMode: request.permissionMode,
    thinkingMode: request.thinkingMode,
    clientRequestId: request.operation.clientRequestId ?? undefined,
    clientMessageId: request.operation.clientMessageId ?? undefined,
    turnId: request.operation.turnId,
    executionAdmission: {
      signal: request.admission.signal,
      markStarted: () => request.admission.markStarted(),
    },
    onAbortable: () => request.admission.markAbortable(),
  };
}
