import { receiptForCarriedContext } from '@garcon/common/transcript-seed';
import {
  runtimeRows,
  type AgentRuntimeExecution,
  type AgentRuntimePublisher,
  type AgentRuntimeExecutionContext,
} from '@garcon/server-agent-common/execution/runtime-events';
import { AgentRunTracker } from '@garcon/server-agent-common/execution/run-tracker';
import type { PathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import type { AcpAgentRuntime } from '../shared/acp-agent-runtime.js';

export class CursorExecution implements AgentRuntimeExecution {
  readonly #runs = new AgentRunTracker();

  constructor(
    private readonly runtime: AcpAgentRuntime,
    private readonly nativeSessions: PathNativeSessionCodec,
  ) {
    runtime.onMessages((chatId, messages, metadata) => {
      const run = this.#runs.correlate(chatId, metadata);
      if (!run) return;
      run.publish({ type: 'messages', rows: runtimeRows(messages), runId: run.runId });
    });
    runtime.onFinished((chatId, exitCode, metadata) => {
      const run = this.#runs.correlate(chatId, metadata);
      if (!run) return;
      run.publish({ type: 'run-ended', runId: run.runId, outcome: 'finished', exitCode });
      this.#runs.finish(chatId, run.runId);
    });
    runtime.onFailed((chatId, message, metadata) => {
      const run = this.#runs.correlate(chatId, metadata);
      if (!run) return;
      run.publish({
        type: 'run-ended',
        runId: run.runId,
        outcome: 'failed',
        error: { code: 'PROVIDER_FAILURE', message },
      });
      this.#runs.finish(chatId, run.runId);
    });
  }

  async start(
    request: Parameters<AgentRuntimeExecution['start']>[0],
    publish: AgentRuntimePublisher,
  ) {
    // A fresh session supersedes whatever produced this chat before, so the routes that
    // belonged to it retire here rather than lingering for the life of the process.
    this.#runs.release(request.chatId);
    this.#runs.register(request.chatId, request.runId, publish);
    const seed = request.carriedContext?.prefix ?? '';
    try {
      const result = await this.runtime.startSession({
        ...executionFields(request),
        command: `${seed}${request.prompt}`,
        images: request.attachments,
      });
      const session = {
        agentSessionId: result.agentSessionId,
        nativeSession: this.nativeSessions.encode({
          path: result.nativePath,
          agentSessionId: result.agentSessionId,
          modelEndpointId: null,
        }),
        nativeSeedReceipt: receiptForCarriedContext(request.carriedContext, result.agentSessionId),
      };
      return session;
    } catch (error) {
      this.#runs.finish(request.chatId, request.runId);
      throw error;
    }
  }

  async resume(
    request: Parameters<AgentRuntimeExecution['resume']>[0],
    publish: AgentRuntimePublisher,
  ): Promise<void> {
    this.#runs.register(request.chatId, request.runId, publish);
    try {
      await this.runtime.runTurn({
        ...executionFields(request),
        agentSessionId: request.agentSessionId,
        command: request.prompt,
        images: request.attachments,
        nativePath: this.nativeSessions.decode(request.nativeSession).path,
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

  async respondToPermission(
    permissionRequestId: string,
    decision: Parameters<import('@garcon/server-agent-interface').AgentPermissionDecisions['respond']>[1],
  ): Promise<void> {
    this.runtime.resolvePermission(permissionRequestId, decision);
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
