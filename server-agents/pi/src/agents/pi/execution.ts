import { receiptForCarriedContext } from '@garcon/common/transcript-seed';
import {
  AgentRuntimeEventChannel,
  runtimeRows,
  type AgentRuntimeExecution,
  type AgentRuntimeExecutionContext,
} from '@garcon/server-agent-common/execution/runtime-events';
import { AgentRunTracker } from '@garcon/server-agent-common/execution/run-tracker';
import type { PathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import type { LazyPiRuntime } from './lazy-runtime.js';

export class PiExecution implements AgentRuntimeExecution {
  readonly #events = new AgentRuntimeEventChannel();
  readonly #runs = new AgentRunTracker();

  constructor(
    private readonly runtime: LazyPiRuntime,
    private readonly nativeSessions: PathNativeSessionCodec,
  ) {
    runtime.onMessages((chatId, messages, metadata) => {
      this.#events.emit({
        type: 'messages',
        chatId,
        rows: runtimeRows(messages),
        runId: this.#runs.correlate(chatId, metadata),
      });
    });
    runtime.onFinished((chatId, exitCode, metadata) => {
      const runId = this.#runs.correlate(chatId, metadata);
      if (!runId) return;
      this.#events.emit({ type: 'run-ended', chatId, runId, outcome: 'finished', exitCode });
      this.#runs.finish(chatId, runId);
    });
    runtime.onFailed((chatId, message, metadata) => {
      const runId = this.#runs.correlate(chatId, metadata);
      if (!runId) return;
      this.#events.emit({
        type: 'run-ended',
        chatId,
        runId,
        outcome: 'failed',
        error: { code: 'PROVIDER_FAILURE', message },
      });
      this.#runs.finish(chatId, runId);
    });
  }

  async start(request: Parameters<AgentRuntimeExecution['start']>[0]) {
    this.#runs.register(request.chatId, request.runId);
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

  async resume(request: Parameters<AgentRuntimeExecution['resume']>[0]): Promise<void> {
    this.#runs.register(request.chatId, request.runId);
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

  async prepareProjectPathUpdate(
    request: Parameters<import('@garcon/server-agent-interface').AgentProjectPathUpdates['prepare']>[0],
  ): Promise<void> {
    request.signal.throwIfAborted();
  }

  subscribeRuntimeEvents(
    listener: Parameters<AgentRuntimeEventChannel['subscribe']>[0],
  ): () => void {
    return this.#events.subscribe(listener);
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
