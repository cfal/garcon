import { receiptForCarriedContext } from '@garcon/common/transcript-seed';
import { createArtificialNativePath } from '@garcon/server-agent-common/chats/artificial-native-path';
import {
  runtimeRows,
  type AgentRuntimeExecution,
  type AgentRuntimePublisher,
  type AgentRuntimeExecutionContext,
} from '@garcon/server-agent-common/execution/runtime-events';
import { AgentRunTracker } from '@garcon/server-agent-common/execution/run-tracker';
import type { PathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import type { OpenCodeRuntime } from './opencode.js';

export class OpenCodeExecution implements AgentRuntimeExecution {
  readonly #runs = new AgentRunTracker();

  constructor(
    private readonly runtime: OpenCodeRuntime,
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
    this.#runs.register(request.chatId, request.runId, publish);
    const seed = request.carriedContext?.prefix ?? '';
    try {
      const agentSessionId = await this.runtime.startSession({
        ...executionFields(request),
        command: `${seed}${request.prompt}`,
        images: request.attachments,
      });
      const session = {
        agentSessionId,
        nativeSession: this.nativeSessions.encode({
          path: createArtificialNativePath('opencode', agentSessionId),
          agentSessionId,
          modelEndpointId: null,
        }),
        nativeSeedReceipt: receiptForCarriedContext(request.carriedContext, agentSessionId),
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
        command: request.prompt,
        images: request.attachments,
        agentSessionId: request.agentSessionId,
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
    await this.runtime.resolvePermission(permissionRequestId, decision);
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
