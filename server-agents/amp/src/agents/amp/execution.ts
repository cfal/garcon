import { receiptForCarriedContext } from '@garcon/common/transcript-seed';
import {
  runtimeOperation,
  type AgentRuntimeExecution,
  type AgentRuntimePublisher,
} from '@garcon/server-agent-common/execution/runtime-events';
import type { PathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
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
    const result = await this.runtime.startSession({
      chatId: request.chatId,
      projectPath: request.projectPath,
      model: request.model,
      permissionMode: request.permissionMode,
      thinkingMode: request.thinkingMode,
      command: `${seed}${request.prompt}`,
      clientRequestId: request.runId,
      turnId: request.runId,
      operation: runtimeOperation(request.runId, publish),
      executionAdmission: {
        signal: request.admission.signal,
        markStarted: () => request.admission.markStarted(),
      },
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
      chatId: request.chatId,
      projectPath: request.projectPath,
      model: request.model,
      permissionMode: request.permissionMode,
      thinkingMode: request.thinkingMode,
      command: request.prompt,
      agentSessionId: request.agentSessionId,
      clientRequestId: request.runId,
      turnId: request.runId,
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
