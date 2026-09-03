import { receiptForCarriedContext } from '@garcon/common/transcript-seed';
import {
  runtimeOperation,
  type AgentRuntimeExecution,
  type AgentRuntimePublisher,
} from '@garcon/server-agent-common/execution/runtime-events';
import type { PathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import type { AgentEstablishedSession } from '@garcon/server-agent-interface';
import type { AmpCliRuntime } from './amp-cli.js';

export class AmpExecution implements AgentRuntimeExecution {
  constructor(
    private readonly runtime: AmpCliRuntime,
    private readonly nativeSessions: PathNativeSessionCodec,
  ) {}

  async start(
    request: Parameters<AgentRuntimeExecution['start']>[0],
    publish: AgentRuntimePublisher,
  ) {
    request.admission.signal.throwIfAborted();
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
      chatId: request.chatId,
      projectPath: request.projectPath,
      model: request.model,
      permissionMode: request.permissionMode,
      attachments: request.attachments,
      command: `${seed}${request.providerPrefix}${request.prompt}`,
      operation: runtimeOperation(request.runId, publish),
      onSessionActivated: (session) => void establish(session),
      executionAdmission: {
        signal: request.admission.signal,
        markStarted: () => request.admission.markStarted(),
      },
    });
    return established ?? establish(result);
  }

  async resume(
    request: Parameters<AgentRuntimeExecution['resume']>[0],
    publish: AgentRuntimePublisher,
  ): Promise<void> {
    await this.runtime.runTurn({
      chatId: request.chatId,
      projectPath: request.projectPath,
      model: request.model,
      permissionMode: request.permissionMode,
      attachments: request.attachments,
      command: `${request.providerPrefix}${request.prompt}`,
      agentSessionId: request.agentSessionId,
      operation: runtimeOperation(request.runId, publish),
      executionAdmission: {
        signal: request.admission.signal,
        markStarted: () => request.admission.markStarted(),
      },
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
