import { receiptForCarriedContext } from '@garcon/common/transcript-seed';
import {
  runtimeRows,
  type AgentRuntimeExecutionContext,
  type AgentRuntimeExecution,
  type AgentRuntimePublisher,
} from '@garcon/server-agent-common/execution/runtime-events';
import { AgentRunTracker } from '@garcon/server-agent-common/execution/run-tracker';
import type { PathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import type { FactoryCliRuntime } from './factory-cli.js';

export class FactoryExecution implements AgentRuntimeExecution {
  readonly #runs = new AgentRunTracker();

  constructor(
    private readonly runtime: FactoryCliRuntime,
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
      const result = await this.runtime.startSession({
        ...executionFields(request),
        command: `${seed}${request.prompt}`,
        images: request.attachments.map(toFactoryImage),
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
        command: request.prompt,
        agentSessionId: request.agentSessionId,
        images: request.attachments.map(toFactoryImage),
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

function toFactoryImage(
  attachment: Parameters<AgentRuntimeExecution['start']>[0]['attachments'][number],
) {
  return {
    data: attachment.data,
    ...(attachment.name ? { name: attachment.name } : {}),
    mimeType: attachment.mimeType,
  };
}
