import { receiptForCarriedContext } from '@garcon/common/transcript-seed';
import {
  runtimeOperation,
  type AgentRuntimeExecutionContext,
  type AgentRuntimeExecution,
  type AgentRuntimePublisher,
} from '@garcon/server-agent-common/execution/runtime-events';
import type { PathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import type { AgentEstablishedSession } from '@garcon/server-agent-interface';
import type { FactoryCliRuntime } from './factory-cli.js';

export class FactoryExecution implements AgentRuntimeExecution {
  constructor(
    private readonly runtime: FactoryCliRuntime,
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
      images: request.attachments.map(toFactoryImage),
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
      command: request.prompt,
      agentSessionId: request.agentSessionId,
      images: request.attachments.map(toFactoryImage),
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

function toFactoryImage(
  attachment: Parameters<AgentRuntimeExecution['start']>[0]['attachments'][number],
) {
  return {
    data: attachment.data,
    ...(attachment.name ? { name: attachment.name } : {}),
    mimeType: attachment.mimeType,
  };
}
