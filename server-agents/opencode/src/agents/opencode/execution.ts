import { receiptForCarriedContext } from '@garcon/common/transcript-seed';
import { createArtificialNativePath } from '@garcon/server-agent-common/chats/artificial-native-path';
import {
  runtimeOperation,
  type AgentRuntimeExecution,
  type AgentRuntimePublisher,
  type AgentRuntimeExecutionContext,
} from '@garcon/server-agent-common/execution/runtime-events';
import type { PathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import type { AgentEstablishedSession } from '@garcon/server-agent-interface';
import type { OpenCodeRuntime } from './opencode.js';

export class OpenCodeExecution implements AgentRuntimeExecution {
  constructor(
    private readonly runtime: OpenCodeRuntime,
    private readonly nativeSessions: PathNativeSessionCodec,
  ) {}

  async start(
    request: Parameters<AgentRuntimeExecution['start']>[0],
    publish: AgentRuntimePublisher,
  ) {
    const seed = request.carriedContext?.prefix ?? '';
    let established: AgentEstablishedSession | null = null;
    const establish = (agentSessionId: string) => {
      if (established) return established;
      established = {
        agentSessionId,
        nativeSession: this.nativeSessions.encode({
          path: createArtificialNativePath('opencode', agentSessionId),
          agentSessionId,
          modelEndpointId: null,
        }),
        nativeSeedReceipt: receiptForCarriedContext(request.carriedContext, agentSessionId),
      };
      publish({ type: 'session', session: established });
      return established;
    };
    const agentSessionId = await this.runtime.startSession({
      ...executionFields(request),
      command: `${seed}${request.prompt}`,
      images: request.attachments,
      operation: runtimeOperation(request.runId, publish),
      onSessionActivated: (sessionId) => void establish(sessionId),
    });
    return established ?? establish(agentSessionId);
  }

  async resume(
    request: Parameters<AgentRuntimeExecution['resume']>[0],
    publish: AgentRuntimePublisher,
  ): Promise<void> {
    await this.runtime.runTurn({
      ...executionFields(request),
      command: request.prompt,
      images: request.attachments,
      agentSessionId: request.agentSessionId,
      operation: runtimeOperation(request.runId, publish),
    });
  }

  async compact(
    request: Parameters<AgentRuntimeExecution['resume']>[0],
    publish: AgentRuntimePublisher,
  ): Promise<void> {
    await this.runtime.compact({
      ...executionFields(request),
      agentSessionId: request.agentSessionId,
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

  async applySessionConfiguration(
    agentSessionId: string,
    configuration: Parameters<import('@garcon/server-agent-interface').AgentSessionConfigurationUpdates['apply']>[1],
  ): Promise<void> {
    this.runtime.updateSessionSettings(agentSessionId, {
      model: configuration.model,
      permissionMode: configuration.permissionMode,
      thinkingMode: configuration.thinkingMode,
    });
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
