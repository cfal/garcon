import { receiptForCarriedContext } from '@garcon/common/transcript-seed';
import {
  runtimeOperation,
  type AgentRuntimeExecution,
  type AgentRuntimePublisher,
  type AgentRuntimeExecutionContext,
} from '@garcon/server-agent-common/execution/runtime-events';
import type { PathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import type { AcpAgentRuntime } from '../shared/acp-agent-runtime.js';

export class CursorExecution implements AgentRuntimeExecution {
  constructor(
    private readonly runtime: AcpAgentRuntime,
    private readonly nativeSessions: PathNativeSessionCodec,
  ) {}

  async start(
    request: Parameters<AgentRuntimeExecution['start']>[0],
    publish: AgentRuntimePublisher,
  ) {
    const seed = request.carriedContext?.prefix ?? '';
    const result = await this.runtime.startSession({
      ...executionFields(request),
      command: `${seed}${request.prompt}`,
      images: request.attachments,
      operation: runtimeOperation(request.runId, publish),
    });
    return {
      agentSessionId: result.agentSessionId,
      nativeSession: this.nativeSessions.encode({
        path: result.nativePath,
        agentSessionId: result.agentSessionId,
        modelEndpointId: null,
      }),
      nativeSeedReceipt: receiptForCarriedContext(request.carriedContext, result.agentSessionId),
    };
  }

  async resume(
    request: Parameters<AgentRuntimeExecution['resume']>[0],
    publish: AgentRuntimePublisher,
  ): Promise<void> {
    await this.runtime.runTurn({
      ...executionFields(request),
      agentSessionId: request.agentSessionId,
      command: request.prompt,
      images: request.attachments,
      nativePath: this.nativeSessions.decode(request.nativeSession).path,
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

  async prepareProjectPathUpdate(
    request: Parameters<import('@garcon/server-agent-interface').AgentProjectPathUpdates['prepare']>[0],
  ): Promise<void> {
    await this.runtime.prepareProjectPathUpdate({
      chatId: request.chat.chatId,
      agentSessionId: request.chat.agentSessionId,
      previousProjectPath: request.chat.projectPath,
      nextProjectPath: request.nextProjectPath,
      nativePath: this.nativeSessions.decode(request.chat.nativeSession).path,
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
    clientRequestId: request.runId,
    turnId: request.runId,
    executionAdmission: {
      signal: request.admission.signal,
      markStarted: () => request.admission.markStarted(),
    },
  };
}
