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
import type { AgentEstablishedSession } from '@garcon/server-agent-interface';
import { receiptForCarriedContext } from '@garcon/common/transcript-seed';
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
    let established: AgentEstablishedSession | null = null;
    const establish = (result: {
      readonly agentSessionId: string;
      readonly nativeSession: AgentEstablishedSession['nativeSession'];
    }) => {
      if (established) return established;
      established = {
        agentSessionId: result.agentSessionId,
        nativeSession: result.nativeSession,
        nativeSeedReceipt: receiptForCarriedContext(
          request.carriedContext,
          result.agentSessionId,
          'user-prefix',
        ),
      };
      publish({ type: 'session', session: established });
      return established;
    };
    const command = request.carriedContext
      ? `${request.carriedContext.prefix}${request.providerPrefix}${request.prompt}`
      : `${request.providerPrefix}${request.prompt}`;
    const result = await this.runtime.startSession({
      ...executionFields(request),
      command,
      images: request.attachments,
      endpoint,
      operation: runtimeOperation(request.runId, publish),
      onSessionActivated: (session) => void establish(session),
    });
    return established ?? establish(result);
  }

  async resume(
    request: Parameters<AgentRuntimeExecution['resume']>[0],
    publish: AgentRuntimePublisher,
  ): Promise<void> {
    const endpoint = await this.#endpoint(request);
    await this.runtime.runTurn({
      ...executionFields(request),
      agentSessionId: request.agentSessionId,
      nativeSession: request.nativeSession,
      command: `${request.providerPrefix}${request.prompt}`,
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

function executionFields(request: AgentRuntimeExecutionContext) {
  return {
    chatId: request.chatId,
    projectPath: request.projectPath,
    model: request.model,
    permissionMode: request.permissionMode,
    thinkingMode: request.thinkingMode,
    executionAdmission: {
      signal: request.admission.signal,
      markStarted: () => request.admission.markStarted(),
    },
  };
}
