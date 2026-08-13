import {
  AgentIntegrationError,
  type AgentHost,
} from '@garcon/server-agent-interface';
import {
  AgentRuntimeEventChannel,
  runtimeRows,
  type AgentRuntimeExecution,
  type AgentRuntimeExecutionContext,
} from '../execution/runtime-events.js';
import { AgentRunTracker } from '../execution/run-tracker.js';
import { resolveAgentEndpoint } from '../execution/resolve-endpoint.js';
import type { DirectEndpointRouterRuntime, DirectCompatibleRuntime } from './router.js';

export class DirectExecution<TRuntime extends DirectCompatibleRuntime>
implements AgentRuntimeExecution {
  readonly #events = new AgentRuntimeEventChannel();
  readonly #runs = new AgentRunTracker();

  constructor(
    private readonly host: AgentHost,
    private readonly runtime: DirectEndpointRouterRuntime<TRuntime>,
  ) {
    runtime.onMessages((chatId, messages, metadata) => {
      this.#events.emit({
        type: 'messages',
        chatId,
        rows: runtimeRows(messages),
        runId: this.#runs.correlate(chatId, metadata),
      });
    });
    runtime.onFinished((chatId, exitCode, metadata) => {
      const runId = this.#runs.correlate(chatId, metadata);
      if (!runId) return;
      this.#events.emit({ type: 'run-ended', chatId, runId, outcome: 'finished', exitCode });
      this.#runs.finish(chatId, runId);
    });
    runtime.onFailed((chatId, message, metadata) => {
      const runId = this.#runs.correlate(chatId, metadata);
      if (!runId) return;
      this.#events.emit({
        type: 'run-ended',
        chatId,
        runId,
        outcome: 'failed',
        error: { code: 'PROVIDER_FAILURE', message },
      });
      this.#runs.finish(chatId, runId);
    });
  }

  async start(request: Parameters<AgentRuntimeExecution['start']>[0]) {
    const endpoint = await this.#endpoint(request);
    this.#runs.register(request.chatId, request.runId);
    try {
      const result = await this.runtime.startSession({
        ...executionFields(request),
        command: request.prompt,
        images: request.attachments,
        endpoint,
      });
      const session = {
        agentSessionId: result.agentSessionId,
        nativeSession: null,
        nativeSeedReceipt: null,
      };
      return session;
    } catch (error) {
      this.#runs.finish(request.chatId, request.runId);
      throw error;
    }
  }

  async resume(request: Parameters<AgentRuntimeExecution['resume']>[0]): Promise<void> {
    const endpoint = await this.#endpoint(request);
    this.#runs.register(request.chatId, request.runId);
    try {
      await this.runtime.runTurn({
        ...executionFields(request),
        agentSessionId: request.agentSessionId,
        command: request.prompt,
        images: request.attachments,
        endpoint,
      });
    } catch (error) {
      this.#runs.finish(request.chatId, request.runId);
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
    request: Parameters<import('@garcon/server-agent-interface').AgentProjectPathUpdates['prepare']>[0],
  ): Promise<void> {
    request.signal.throwIfAborted();
  }

  subscribeRuntimeEvents(
    listener: Parameters<AgentRuntimeEventChannel['subscribe']>[0],
  ): () => void {
    return this.#events.subscribe(listener);
  }

  async #endpoint(request: AgentRuntimeExecutionContext) {
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

function executionFields(
  request: AgentRuntimeExecutionContext,
  priorContext = request.priorContext,
) {
  return {
    chatId: request.chatId,
    projectPath: request.projectPath,
    model: request.model,
    permissionMode: request.permissionMode,
    thinkingMode: request.thinkingMode,
    clientRequestId: request.runId,
    turnId: request.runId,
    executionAdmission: {
      signal: request.admission.signal,
      markStarted: () => request.admission.markStarted(),
    },
    priorContext,
  };
}
