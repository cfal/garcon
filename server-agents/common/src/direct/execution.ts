import {
  AgentIntegrationError,
  type AgentHost,
} from '@garcon/server-agent-interface';
import {
  runtimeOperation,
  type AgentRuntimeExecution,
  type AgentRuntimePublisher,
  type AgentRuntimeExecutionContext,
} from '../execution/runtime-events.js';
import { resolveAgentEndpoint } from '../execution/resolve-endpoint.js';
import type { DirectEndpointRouterRuntime, DirectCompatibleRuntime } from './router.js';

export class DirectExecution<TRuntime extends DirectCompatibleRuntime>
implements AgentRuntimeExecution {
  constructor(
    private readonly host: AgentHost,
    private readonly runtime: DirectEndpointRouterRuntime<TRuntime>,
  ) {}

  async start(
    request: Parameters<AgentRuntimeExecution['start']>[0],
    publish: AgentRuntimePublisher,
  ) {
    const endpoint = await this.#endpoint(request);
    const result = await this.runtime.startSession({
      ...executionFields(request),
      command: request.prompt,
      images: request.attachments,
      endpoint,
      operation: runtimeOperation(request.runId, publish),
    });
    return {
      agentSessionId: result.agentSessionId,
      nativeSession: null,
      nativeSeedReceipt: null,
    };
  }

  async resume(
    request: Parameters<AgentRuntimeExecution['resume']>[0],
    publish: AgentRuntimePublisher,
  ): Promise<void> {
    const endpoint = await this.#endpoint(request);
    await this.runtime.runTurn({
      ...executionFields(request),
      agentSessionId: request.agentSessionId,
      command: request.prompt,
      images: request.attachments,
      endpoint,
      operation: runtimeOperation(request.runId, publish),
    });
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
