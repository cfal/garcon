import crypto from 'node:crypto';
import { renderTranscriptSeed } from '@garcon/common/transcript-seed';
import type { ClaudeThinkingMode } from '@garcon/common/chat-modes';
import {
  AgentIntegrationError,
  type AgentExecution,
  type AgentExecutionContext,
  type AgentHost,
  type AgentLogger,
} from '@garcon/server-agent-interface';
import { AgentExecutionEventChannel } from '@garcon/server-agent-common/execution/event-channel';
import { AgentOperationTracker } from '@garcon/server-agent-common/execution/operation-tracker';
import { resolveAgentEndpoint } from '@garcon/server-agent-common/execution/resolve-endpoint';
import type { PathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import {
  buildClaudeEndpointRuntime,
  buildClaudeHostEnvironment,
} from './endpoint-runtime.js';
import { createClaudeNativePath } from './native-path.js';
import { claudeEventMetadata } from './runtime-types.js';
import type { ClaudeCliRuntime } from './claude-cli.js';
import type { ClaudeConfig } from '../../config.js';

export class ClaudeExecution implements AgentExecution {
  readonly #events = new AgentExecutionEventChannel();
  readonly #operations = new AgentOperationTracker();

  constructor(
    private readonly host: AgentHost,
    private readonly runtime: ClaudeCliRuntime,
    private readonly nativeSessions: PathNativeSessionCodec,
    private readonly logger: AgentLogger,
    private readonly config: ClaudeConfig,
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
    try {
      request.admission.signal.throwIfAborted();
      const envOverrides = await this.#endpointEnvironment(request);
      const agentSessionId = crypto.randomUUID();
      const nativePath = await createClaudeNativePath(request.projectPath, agentSessionId, {
        configHomeDir: envOverrides?.CLAUDE_CONFIG_DIR,
        logger: this.logger,
      });
      request.admission.signal.throwIfAborted();
      const runtimeRequest = {
        ...executionFields(request),
        agentSessionId,
        command: request.carryOver.length > 0
          ? `${renderTranscriptSeed([...request.carryOver])}\n\n${request.prompt}`
          : request.prompt,
        images: request.attachments,
        envOverrides,
      };
      void this.runtime.startClaudeCliSession(runtimeRequest).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error('Claude session start failed', {
          chatId: request.chatId,
          error: message,
        });
        this.runtime.failClaudeInternalSession(
          agentSessionId,
          request.chatId,
          message,
          claudeEventMetadata(runtimeRequest, 'chat-start'),
        );
      });
      const session = {
        agentSessionId,
        nativeSession: this.nativeSessions.encode({
          path: nativePath,
          agentSessionId,
          modelEndpointId: request.endpoint?.endpointId ?? null,
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
      await this.runtime.runClaudeTurn({
        ...executionFields(request),
        agentSessionId: request.agentSessionId,
        command: request.prompt,
        images: request.attachments,
        nativePath: this.nativeSessions.decode(request.nativeSession).path,
        envOverrides: await this.#endpointEnvironment(request),
      });
    } catch (error) {
      this.#operations.finish(request.chatId, request.operation);
      throw error;
    }
  }

  async abort(agentSessionId: string): Promise<boolean> {
    return this.runtime.abortClaudeInternalSession(agentSessionId);
  }

  isRunning(agentSessionId: string): boolean {
    return this.runtime.isClaudeInternalSessionRunning(agentSessionId);
  }

  runningSessions() {
    return this.runtime.getRunningClaudeInternalSessions().map((session) => ({
      agentSessionId: session.id,
      status: session.status,
      startedAt: session.startedAt,
    }));
  }

  async applySessionConfiguration(
    agentSessionId: string,
    configuration: Parameters<NonNullable<AgentExecution['applySessionConfiguration']>>[1],
  ): Promise<void> {
    this.runtime.setInternalPermissionMode(agentSessionId, configuration.permissionMode);
    this.runtime.setInternalThinkingMode(agentSessionId, configuration.thinkingMode);
    this.runtime.setInternalClaudeThinkingMode(
      agentSessionId,
      claudeThinkingMode(configuration.settings.values.claudeThinkingMode),
    );
  }

  async respondToPermission(
    permissionRequestId: string,
    decision: Parameters<NonNullable<AgentExecution['respondToPermission']>>[1],
  ): Promise<void> {
    this.runtime.resolveInternalToolApproval(permissionRequestId, decision);
  }

  async prepareProjectPathUpdate(
    request: Parameters<NonNullable<AgentExecution['prepareProjectPathUpdate']>>[0],
  ): Promise<void> {
    request.signal.throwIfAborted();
    const native = this.nativeSessions.decode(request.chat.nativeSession);
    await this.runtime.prepareClaudeProjectPathUpdate({
      chatId: request.chat.chatId,
      agentSessionId: request.chat.agentSessionId,
      previousProjectPath: request.chat.projectPath,
      nextProjectPath: request.nextProjectPath,
      nativePath: native.path,
    });
  }

  subscribe(listener: Parameters<AgentExecution['subscribe']>[0]): () => void {
    return this.#events.subscribe(listener);
  }

  async #endpointEnvironment(request: AgentExecutionContext) {
    const endpoint = await resolveAgentEndpoint(
      this.host,
      request.endpoint,
      request.admission.signal,
    );
    const environment = buildClaudeHostEnvironment(this.config);
    if (!endpoint) return environment;
    const runtime = buildClaudeEndpointRuntime(endpoint);
    if (!runtime) {
      throw new AgentIntegrationError(
        'INVALID_ENDPOINT',
        'Claude requires an Anthropic Messages endpoint',
        false,
      );
    }
    return { ...environment, ...runtime.envOverrides };
  }
}

function executionFields(request: AgentExecutionContext) {
  return {
    chatId: request.chatId,
    projectPath: request.projectPath,
    model: request.model,
    permissionMode: request.permissionMode,
    thinkingMode: request.thinkingMode,
    claudeThinkingMode: claudeThinkingMode(request.settings.values.claudeThinkingMode),
    clientRequestId: request.operation.clientRequestId ?? undefined,
    clientMessageId: request.operation.clientMessageId ?? undefined,
    turnId: request.operation.turnId,
    executionAdmission: {
      signal: request.admission.signal,
      markStarted: () => request.admission.markStarted(),
    },
    onAbortable: () => request.admission.markAbortable(),
  };
}

function claudeThinkingMode(value: unknown): ClaudeThinkingMode {
  return value === 'on' || value === 'off' ? value : 'auto';
}
