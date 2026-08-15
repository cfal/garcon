import crypto from 'node:crypto';
import { receiptForCarriedContext } from '@garcon/common/transcript-seed';
import type { ClaudeThinkingMode } from '@garcon/common/chat-modes';
import {
  AgentIntegrationError,
  type AgentHost,
  type AgentLogger,
  type AgentProjectPathUpdatePreparation,
} from '@garcon/server-agent-interface';
import {
  runtimeOperation,
  type AgentRuntimeExecution,
  type AgentRuntimePublisher,
  type AgentRuntimeExecutionContext,
} from '@garcon/server-agent-common/execution/runtime-events';
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

export class ClaudeExecution implements AgentRuntimeExecution {
  constructor(
    private readonly host: AgentHost,
    private readonly runtime: ClaudeCliRuntime,
    private readonly nativeSessions: PathNativeSessionCodec,
    private readonly logger: AgentLogger,
    private readonly config: ClaudeConfig,
  ) {}

  async start(
    request: Parameters<AgentRuntimeExecution['start']>[0],
    publish: AgentRuntimePublisher,
  ) {
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
      operation: runtimeOperation(request.runId, publish),
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
        runtimeRequest.operation,
      );
    });
    return {
      agentSessionId,
      nativeSession: this.nativeSessions.encode({
        path: nativePath,
        agentSessionId,
        modelEndpointId: request.endpoint?.endpointId ?? null,
      }),
      nativeSeedReceipt: receiptForCarriedContext(request.carriedContext, agentSessionId),
    };
  }

  async resume(
    request: Parameters<AgentRuntimeExecution['resume']>[0],
    publish: AgentRuntimePublisher,
  ): Promise<void> {
    await this.runtime.runClaudeTurn({
      ...executionFields(request),
      agentSessionId: request.agentSessionId,
      command: request.prompt,
      images: request.attachments,
      nativePath: this.nativeSessions.decode(request.nativeSession).path,
      envOverrides: await this.#endpointEnvironment(request),
      operation: runtimeOperation(request.runId, publish),
    });
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
    configuration: Parameters<import('@garcon/server-agent-interface').AgentSessionConfigurationUpdates['apply']>[1],
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
    decision: Parameters<import('@garcon/server-agent-interface').AgentPermissionDecisions['respond']>[1],
  ): Promise<void> {
    this.runtime.resolveInternalToolApproval(permissionRequestId, decision);
  }

  async prepareProjectPathUpdate(
    request: Parameters<import('@garcon/server-agent-interface').AgentProjectPathUpdates['prepare']>[0],
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


  async #endpointEnvironment(request: AgentRuntimeExecutionContext) {
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

function executionFields(request: AgentRuntimeExecutionContext) {
  return {
    chatId: request.chatId,
    projectPath: request.projectPath,
    model: request.model,
    permissionMode: request.permissionMode,
    thinkingMode: request.thinkingMode,
    claudeThinkingMode: claudeThinkingMode(request.settings.values.claudeThinkingMode),
    clientRequestId: request.runId,
    turnId: request.runId,
    executionAdmission: {
      signal: request.admission.signal,
      markStarted: () => request.admission.markStarted(),
    },
  };
}

function claudeThinkingMode(value: unknown): ClaudeThinkingMode {
  return value === 'on' || value === 'off' ? value : 'auto';
}
