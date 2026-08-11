import crypto from 'node:crypto';
import { receiptForCarriedContext } from '@garcon/common/transcript-seed';
import type { ClaudeThinkingMode } from '@garcon/common/chat-modes';
import {
  AgentIntegrationError,
  type AgentExecutionContextV4,
  type AgentHost,
  type AgentLogger,
  type AgentProjectPathUpdatePreparation,
} from '@garcon/server-agent-interface';
import {
  AgentProjectionProducerEventChannel,
  type AgentProjectionRuntimeExecution,
} from '@garcon/server-agent-common/execution/projection-events';
import { AgentOperationTracker } from '@garcon/server-agent-common/execution/operation-tracker';
import { resolveAgentEndpoint } from '@garcon/server-agent-common/execution/resolve-endpoint';
import type { PathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import {
  buildClaudeEndpointRuntime,
  buildClaudeHostEnvironment,
} from './endpoint-runtime.js';
import {
  createClaudeNativePath,
  prepareClaudeNativeSessionRelocation,
} from './native-path.js';
import { claudeEventMetadata } from './runtime-types.js';
import type { ClaudeCliRuntime } from './claude-cli.js';
import type { ClaudeConfig } from '../../config.js';

export class ClaudeExecution implements AgentProjectionRuntimeExecution {
  readonly #events = new AgentProjectionProducerEventChannel();
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

  async start(request: Parameters<AgentProjectionRuntimeExecution['start']>[0]) {
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
        command: `${request.carriedContext?.prefix ?? ''}${request.prompt}`,
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
        nativeSeedReceipt: receiptForCarriedContext(request.carriedContext, agentSessionId),
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

  async resume(request: Parameters<AgentProjectionRuntimeExecution['resume']>[0]): Promise<void> {
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
    configuration: Parameters<NonNullable<AgentProjectionRuntimeExecution['applySessionConfiguration']>>[1],
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
    decision: Parameters<NonNullable<AgentProjectionRuntimeExecution['respondToPermission']>>[1],
  ): Promise<void> {
    this.runtime.resolveInternalToolApproval(permissionRequestId, decision);
  }

  async prepareProjectPathUpdate(
    request: Parameters<NonNullable<AgentProjectionRuntimeExecution['prepareProjectPathUpdate']>>[0],
  ): Promise<AgentProjectPathUpdatePreparation | void> {
    request.signal.throwIfAborted();
    const agentSessionId = request.chat.agentSessionId;
    if (!agentSessionId) return;

    const native = this.nativeSessions.decode(request.chat.nativeSession);
    await this.runtime.prepareClaudeProjectPathUpdate({
      chatId: request.chat.chatId,
      agentSessionId,
      previousProjectPath: request.chat.projectPath,
      nextProjectPath: request.nextProjectPath,
      nativePath: native.path,
    });
    request.signal.throwIfAborted();

    const relocation = await prepareClaudeNativeSessionRelocation({
      previousProjectPath: request.chat.projectPath,
      nextProjectPath: request.nextProjectPath,
      agentSessionId,
      nativePath: native.path,
      configHomeDir: this.config.configHomeDir() ?? undefined,
      logger: this.logger,
    });

    return {
      nativeSession: this.nativeSessions.encode({
        path: relocation.nativePath,
        agentSessionId,
        modelEndpointId: native.modelEndpointId,
      }),
      commit: relocation.commit,
      rollback: relocation.rollback,
    };
  }

  subscribeProjectionEvents(
    listener: Parameters<AgentProjectionProducerEventChannel['subscribe']>[0],
  ): () => void {
    return this.#events.subscribe(listener);
  }

  async #endpointEnvironment(request: AgentExecutionContextV4) {
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

function executionFields(request: AgentExecutionContextV4) {
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
