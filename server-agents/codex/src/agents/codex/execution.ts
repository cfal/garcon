import { renderTranscriptSeed } from '@garcon/common/transcript-seed';
import {
  AgentIntegrationError,
  type AgentExecution,
  type AgentExecutionContext,
  type AgentHost,
} from '@garcon/server-agent-interface';
import { AgentExecutionEventChannel } from '@garcon/server-agent-common/execution/event-channel';
import { AgentOperationTracker } from '@garcon/server-agent-common/execution/operation-tracker';
import { resolveAgentEndpoint } from '@garcon/server-agent-common/execution/resolve-endpoint';
import type { PathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import type { CodexConfig } from '../../config.js';
import {
  buildCodexAppServerEndpointRuntime,
  buildCodexHostEnvironment,
} from './app-server/endpoint-runtime.js';
import type { CodexAppServerRuntime } from './app-server/runtime.js';
import { parseCodexGoalCommand, type CodexGoalCommand } from './goal-command.js';
import type {
  CodexProviderConfig,
  CodexResumeRequest,
  CodexStartRequest,
} from './runtime-types.js';

interface CodexRuntimeConfiguration {
  readonly envOverrides: Record<string, string>;
  readonly codexConfig?: CodexProviderConfig;
}

export class CodexExecution implements AgentExecution {
  readonly #events = new AgentExecutionEventChannel();
  readonly #operations = new AgentOperationTracker();

  constructor(
    private readonly host: AgentHost,
    private readonly runtime: CodexAppServerRuntime,
    private readonly nativeSessions: PathNativeSessionCodec,
    private readonly config: CodexConfig,
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
      const configuration = await this.#runtimeConfiguration(request);
      const runtimeRequest = prepareStartRequest(request, configuration);
      const started = await this.runtime.startSession(runtimeRequest);
      const session = {
        agentSessionId: started.agentSessionId,
        nativeSession: this.nativeSessions.encode({
          path: started.nativePath,
          agentSessionId: started.agentSessionId,
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
    return this.#resume(request, (runtimeRequest) => this.runtime.runTurn(runtimeRequest));
  }

  async submitActiveInput(
    request: Parameters<NonNullable<AgentExecution['submitActiveInput']>>[0],
  ): Promise<boolean> {
    const predecessor = this.#operations.current(request.chatId);
    const runtimeRequest = prepareResumeRequest(
      request,
      await this.#runtimeConfiguration(request),
      this.nativeSessions,
    );
    return this.runtime.submitActiveInput(
      runtimeRequest,
      (handoff) => request.beforeDelivery(this.#operations.handoff(
        request.chatId,
        predecessor,
        request.operation,
        handoff,
      )),
    );
  }

  async compact(
    request: Parameters<NonNullable<AgentExecution['compact']>>[0],
  ): Promise<void> {
    return this.#resume(request, (runtimeRequest) => this.runtime.compact(runtimeRequest));
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
      status: session.status,
      startedAt: session.startedAt,
    }));
  }

  async applySessionConfiguration(
    agentSessionId: string,
    configuration: Parameters<NonNullable<AgentExecution['applySessionConfiguration']>>[1],
  ): Promise<void> {
    this.runtime.updateSessionSettings(agentSessionId, {
      permissionMode: configuration.permissionMode,
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

  async #resume(
    request: Parameters<AgentExecution['resume']>[0],
    action: (runtimeRequest: CodexResumeRequest) => Promise<void>,
  ): Promise<void> {
    this.#operations.register(request.chatId, request.operation);
    try {
      await action(prepareResumeRequest(
        request,
        await this.#runtimeConfiguration(request),
        this.nativeSessions,
      ));
    } catch (error) {
      this.#operations.finish(request.chatId, request.operation);
      throw error;
    }
  }

  async #runtimeConfiguration(
    request: AgentExecutionContext,
  ): Promise<CodexRuntimeConfiguration> {
    const endpoint = await resolveAgentEndpoint(
      this.host,
      request.endpoint,
      request.admission.signal,
    );
    if (!endpoint) {
      return { envOverrides: buildCodexHostEnvironment(this.config) };
    }
    const runtime = buildCodexAppServerEndpointRuntime(endpoint);
    if (!runtime) {
      throw new AgentIntegrationError(
        'INVALID_ENDPOINT',
        'Codex requires an OpenAI-compatible endpoint',
        false,
      );
    }
    return {
      envOverrides: buildCodexHostEnvironment(this.config),
      codexConfig: runtime.codexConfig,
    };
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
    clientMessageId: request.operation.clientMessageId ?? undefined,
    turnId: request.operation.turnId,
    executionAdmission: {
      signal: request.admission.signal,
      markStarted: () => request.admission.markStarted(),
    },
    onAbortable: () => request.admission.markAbortable(),
  };
}

function prepareStartRequest(
  request: Parameters<AgentExecution['start']>[0],
  configuration: CodexRuntimeConfiguration,
): CodexStartRequest {
  const goal = parseCodexGoalCommand(request.prompt);
  if (goal && goal.kind !== 'set') {
    throw new AgentIntegrationError(
      'INVALID_SETTINGS',
      'Start a Codex session with /goal <objective> before using goal controls.',
      false,
    );
  }
  const carryOver = request.carryOver.length > 0
    ? renderTranscriptSeed([...request.carryOver])
    : null;
  return {
    ...executionFields(request),
    command: goal?.objective ?? (carryOver ? `${carryOver}\n\n${request.prompt}` : request.prompt),
    images: request.attachments,
    ...configuration,
    ...(goal ? { codexGoalCommand: goal } : {}),
    ...(goal && carryOver ? { codexSeedContext: carryOver } : {}),
  };
}

function prepareResumeRequest(
  request: Parameters<AgentExecution['resume']>[0],
  configuration: CodexRuntimeConfiguration,
  nativeSessions: PathNativeSessionCodec,
): CodexResumeRequest {
  const goal = parseCodexGoalCommand(request.prompt);
  return {
    ...executionFields(request),
    agentSessionId: request.agentSessionId,
    command: goalObjective(goal) ?? request.prompt,
    images: request.attachments,
    nativePath: nativeSessions.decode(request.nativeSession).path,
    ...configuration,
    ...(goal ? { codexGoalCommand: goal } : {}),
  };
}

function goalObjective(goal: CodexGoalCommand | null): string | null {
  return goal && 'objective' in goal && typeof goal.objective === 'string'
    ? goal.objective
    : null;
}
