import { renderTranscriptSeed } from '@garcon/common/transcript-seed';
import {
  AgentIntegrationError,
  type AgentExecution,
  type AgentExecutionContext,
} from '@garcon/server-agent-interface';
import { createArtificialNativePath } from '@garcon/server-agent-common/chats/artificial-native-path';
import { AgentExecutionEventChannel } from '@garcon/server-agent-common/execution/event-channel';
import { AgentOperationTracker } from '@garcon/server-agent-common/execution/operation-tracker';
import type { PathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import type { OpenCodeRuntime } from './opencode.js';

export class OpenCodeExecution implements AgentExecution {
  readonly #events = new AgentExecutionEventChannel();
  readonly #operations = new AgentOperationTracker();

  constructor(
    private readonly runtime: OpenCodeRuntime,
    private readonly nativeSessions: PathNativeSessionCodec,
  ) {
    runtime.onMessages((chatId, messages, metadata) => {
      const operation = this.#operations.current(chatId, metadata);
      if (operation) this.#events.emit({ type: 'messages', chatId, messages, operation });
    });
    runtime.onProcessing((chatId, processing) => {
      const operation = this.#operations.current(chatId);
      if (operation) this.#events.emit({ type: 'processing', chatId, processing, operation });
    });
    runtime.onFinished((chatId, exitCode, metadata) => {
      const operation = this.#operations.current(chatId, metadata);
      if (!operation) return;
      this.#events.emit({ type: 'finished', chatId, exitCode, operation });
      this.#operations.finish(chatId, operation);
    });
    runtime.onFailed((chatId, message, metadata) => {
      const operation = this.#operations.current(chatId, metadata);
      if (!operation) return;
      this.#events.emit({
        type: 'failed',
        chatId,
        error: new AgentIntegrationError('PROVIDER_FAILURE', message, false),
        operation,
      });
      this.#operations.finish(chatId, operation);
    });
  }

  async start(request: Parameters<AgentExecution['start']>[0]) {
    this.#operations.register(request.chatId, request.operation);
    const seed = request.carryOver.length > 0
      ? `${renderTranscriptSeed([...request.carryOver])}\n\n`
      : '';
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
      };
      this.#events.emit({
        type: 'session-created',
        chatId: request.chatId,
        session,
        operation: request.operation,
      });
      return session;
    } catch (error) {
      this.#operations.finish(request.chatId, request.operation);
      throw error;
    }
  }

  async resume(request: Parameters<AgentExecution['resume']>[0]): Promise<void> {
    this.#operations.register(request.chatId, request.operation);
    try {
      await this.runtime.runTurn({
        ...executionFields(request),
        command: request.prompt,
        images: request.attachments,
        agentSessionId: request.agentSessionId,
      });
    } catch (error) {
      this.#operations.finish(request.chatId, request.operation);
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
    configuration: Parameters<NonNullable<AgentExecution['applySessionConfiguration']>>[1],
  ): Promise<void> {
    this.runtime.updateSessionSettings(agentSessionId, {
      model: configuration.model,
      permissionMode: configuration.permissionMode,
      thinkingMode: configuration.thinkingMode,
    });
  }

  async respondToPermission(
    permissionRequestId: string,
    decision: Parameters<NonNullable<AgentExecution['respondToPermission']>>[1],
  ): Promise<void> {
    await this.runtime.resolvePermission(permissionRequestId, decision);
  }

  subscribe(listener: Parameters<AgentExecution['subscribe']>[0]): () => void {
    return this.#events.subscribe(listener);
  }
}

function executionFields(request: AgentExecutionContext) {
  return {
    chatId: request.chatId,
    projectPath: request.projectPath,
    model: request.model,
    permissionMode: request.permissionMode,
    thinkingMode: request.thinkingMode,
    clientRequestId: request.operation.clientRequestId ?? undefined,
    turnId: request.operation.turnId,
    executionAdmission: {
      signal: request.admission.signal,
      markStarted: () => request.admission.markStarted(),
    },
    onAbortable: () => request.admission.markAbortable(),
  };
}
