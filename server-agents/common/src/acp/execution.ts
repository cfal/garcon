import { receiptForCarriedContext } from '@garcon/common/transcript-seed';
import {
  runtimeOperation,
  type AgentRuntimeExecution,
  type AgentRuntimePublisher,
  type AgentRuntimeExecutionContext,
} from '../execution/runtime-events.js';
import type { PathNativeSessionCodec } from '../native-session/path-native-session.js';
import type { AgentEstablishedSession, AgentSessionConfigurationUpdates } from '@garcon/server-agent-interface';
import type { AcpAgentRuntime } from './agent-runtime.js';

// Adapts an ACP runtime to the producer-adapter execution port.
export class AcpExecution implements AgentRuntimeExecution {
  constructor(
    private readonly runtime: AcpAgentRuntime,
    private readonly nativeSessions: PathNativeSessionCodec,
  ) {}

  async start(
    request: Parameters<AgentRuntimeExecution['start']>[0],
    publish: AgentRuntimePublisher,
  ) {
    const seed = request.carriedContext?.prefix ?? '';
    let established: AgentEstablishedSession | null = null;
    const establish = (result: { readonly agentSessionId: string; readonly nativePath: string | null }) => {
      if (established) return established;
      established = {
        agentSessionId: result.agentSessionId,
        nativeSession: this.nativeSessions.encode({
          path: result.nativePath,
          agentSessionId: result.agentSessionId,
          modelEndpointId: null,
        }),
        nativeSeedReceipt: receiptForCarriedContext(request.carriedContext, result.agentSessionId),
      };
      publish({ type: 'session', session: established });
      return established;
    };
    const result = await this.runtime.startSession({
      ...executionFields(request),
      command: `${seed}${request.prompt}`,
      images: request.attachments,
      operation: runtimeOperation(request.runId, publish),
      onSessionActivated: (session) => void establish(session),
    });
    return established ?? establish(result);
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

  readonly applySessionConfiguration: AgentSessionConfigurationUpdates['apply'] = async (
    agentSessionId, configuration, previous,
  ) => {
    // Unrelated saves must preserve the permission mode explicitly requested for this turn.
    if (configuration.permissionMode !== previous.permissionMode) {
      this.runtime.updateSessionSettings(agentSessionId, { permissionMode: configuration.permissionMode });
    }
  };

  async prepareProjectPathUpdate(
    request: import('@garcon/server-agent-interface').AgentProjectPathUpdateRequest,
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
    executionAdmission: {
      signal: request.admission.signal,
      markStarted: () => request.admission.markStarted(),
    },
  };
}
