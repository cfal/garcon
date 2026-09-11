import {
  AgentIntegrationError,
} from '@garcon/server-agent-interface';
import {
  runtimeOperation,
  type AgentRuntimeExecution,
  type AgentRuntimePublisher,
  type AgentRuntimeExecutionContext,
} from '../execution/runtime-events.js';
import type { AgentEstablishedSession } from '@garcon/server-agent-interface';
import { receiptForCarriedContext } from '@garcon/common/transcript-seed';
import type { DirectEndpointRouterRuntime, DirectCompatibleRuntime } from './router.js';

export class DirectExecution<TRuntime extends DirectCompatibleRuntime>
implements AgentRuntimeExecution {
  constructor(
    private readonly runtime: DirectEndpointRouterRuntime<TRuntime>,
  ) {}

  async start(
    request: Parameters<AgentRuntimeExecution['start']>[0],
    publish: AgentRuntimePublisher,
  ) {
    const endpoint = this.#endpoint(request);
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
      ? `${request.carriedContext.prefix}${request.prompt}`
      : request.prompt;
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
    const endpoint = this.#endpoint(request);
    await this.runtime.runTurn({
      ...executionFields(request),
      agentSessionId: request.agentSessionId,
      nativeSession: request.nativeSession,
      command: request.prompt,
      images: request.attachments,
      endpoint,
      operation: runtimeOperation(request.runId, publish),
    });
  }

  async abort(agentSessionId: string, publish: AgentRuntimePublisher): Promise<boolean> {
    return this.runtime.abort(agentSessionId, publish);
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

  #endpoint(request: AgentRuntimeExecutionContext) {
    request.admission.signal.throwIfAborted();
    const endpoint = request.endpoint;
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
