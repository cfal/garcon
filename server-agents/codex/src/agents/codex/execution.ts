import { receiptForCarriedContext } from '@garcon/common/transcript-seed';
import {
  AgentIntegrationError,
  type AgentStartedSession,
  type AgentGoalControlRequest,
  type AgentHost,
} from '@garcon/server-agent-interface';
import {
  runtimeRows,
  type AgentRuntimeExecution,
  type AgentRuntimeEvent,
  type AgentRuntimePublisher,
  type AgentRuntimeExecutionContext,
  type AgentRuntimeResumeRequest,
  type AgentRuntimeStartRequest,
} from '@garcon/server-agent-common/execution/runtime-events';
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

type CodexGoalControlRuntimeRequest = Omit<AgentGoalControlRequest, 'sink'>;

interface CodexOperation {
  readonly chatId: string;
  readonly runId: string;
  readonly publish: AgentRuntimePublisher;
}

export class CodexExecution implements AgentRuntimeExecution {
  // Keyed by the operation the app-server names its events with. Nothing is resolved from what
  // the chat or session is doing now, so an event from a replaced operation reaches that
  // operation's own publisher and its closed sink refuses it.
  readonly #operations = new Map<string, CodexOperation>();

  constructor(
    private readonly host: AgentHost,
    private readonly runtime: CodexAppServerRuntime,
    private readonly nativeSessions: PathNativeSessionCodec,
    private readonly config: CodexConfig,
  ) {
    // The app-server multiplexes every chat over one process-wide stream, so each event is
    // matched to the operation Codex names it with and to nothing else.
    runtime.onMessages((chatId, messages, metadata) => {
      this.#deliver(chatId, metadata, (operation) => ({
        type: 'messages',
        rows: runtimeRows(messages),
        runId: operation.runId,
      }));
    });
    runtime.onFinished((chatId, exitCode, metadata) => {
      this.#deliver(chatId, metadata, (operation) => ({
        type: 'run-ended',
        runId: operation.runId,
        outcome: 'finished',
        exitCode,
      }));
    });
    runtime.onFailed((chatId, message, metadata) => {
      this.#deliver(chatId, metadata, (operation) => ({
        type: 'run-ended',
        runId: operation.runId,
        outcome: 'failed',
        error: { code: 'PROVIDER_FAILURE', message },
      }));
    });
  }

  async start(request: AgentRuntimeStartRequest, publish: AgentRuntimePublisher) {
    this.#capture(request.chatId, request.runId, publish);
    try {
      const configuration = await this.#runtimeConfiguration(request);
      const runtimeRequest = prepareStartRequest(request, configuration);
      // The session event must precede any turn event: a blocking runtime can
      // settle the first turn inside startSession, and the settled audit needs
      // the session identity to read provider evidence.
      const holder: { session: AgentStartedSession | null } = { session: null };
      const emitStarted = (started: { agentSessionId: string; nativePath: string | null }) => {
        if (holder.session) return holder.session;
        holder.session = {
          agentSessionId: started.agentSessionId,
          nativeSession: this.nativeSessions.encode({
            path: started.nativePath,
            agentSessionId: started.agentSessionId,
            modelEndpointId: request.endpoint?.endpointId ?? null,
          }),
          nativeSeedReceipt: receiptForCarriedContext(
            request.carriedContext,
            started.agentSessionId,
            runtimeRequest.codexGoalCommand ? 'provider-context' : 'user-prefix',
          ),
        };
        publish({ type: 'session', session: holder.session });
        return holder.session;
      };
      const started = await this.runtime.startSession({
        ...runtimeRequest,
        onSessionActivated: (session) => void emitStarted(session),
      });
      const early = holder.session;
      return early && early.agentSessionId === started.agentSessionId
        // The materialized path supersedes the activation-time path for core's
        // durable record without re-emitting the session event.
        ? {
            ...early,
            nativeSession: this.nativeSessions.encode({
              path: started.nativePath,
              agentSessionId: started.agentSessionId,
              modelEndpointId: request.endpoint?.endpointId ?? null,
            }),
          }
        : emitStarted(started);
    } catch (error) {
      throw error;
    }
  }

  async resume(request: AgentRuntimeResumeRequest, publish: AgentRuntimePublisher): Promise<void> {
    return this.#resume(request, publish, (runtimeRequest) => this.runtime.runTurn(runtimeRequest));
  }

  async submitGoalControl(
    request: CodexGoalControlRuntimeRequest,
    publish: AgentRuntimePublisher,
  ): Promise<boolean> {
    const predecessor = this.#operations.get(request.chatId) ?? null;
    const runtimeRequest = prepareResumeRequest(
      request,
      await this.#runtimeConfiguration(request),
      this.nativeSessions,
    );
    return this.runtime.submitGoalControl(
      runtimeRequest,
      (handoff) => request.beforeDelivery({
        validate: () => handoff.validate(),
        commit: () => {
          // The successor continues the operation its predecessor owned, so it keeps that
          // publisher and only its ephemeral run id changes.
          this.#capture(request.chatId, request.runId, predecessor?.publish ?? publish);
          handoff.commit();
        },
      }),
    );
  }

  async compact(request: AgentRuntimeResumeRequest, publish: AgentRuntimePublisher): Promise<void> {
    return this.#resume(request, publish, (runtimeRequest) => this.runtime.compact(runtimeRequest));
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
    configuration: Parameters<import('@garcon/server-agent-interface').AgentSessionConfigurationUpdates['apply']>[1],
  ): Promise<void> {
    this.runtime.updateSessionSettings(agentSessionId, {
      permissionMode: configuration.permissionMode,
    });
  }

  async respondToPermission(
    permissionRequestId: string,
    decision: Parameters<import('@garcon/server-agent-interface').AgentPermissionDecisions['respond']>[1],
  ): Promise<void> {
    await this.runtime.resolvePermission(permissionRequestId, decision);
  }


  async #resume(
    request: AgentRuntimeResumeRequest,
    publish: AgentRuntimePublisher,
    action: (runtimeRequest: CodexResumeRequest) => Promise<void>,
  ): Promise<void> {
    this.#capture(request.chatId, request.runId, publish);
    try {
      await action(prepareResumeRequest(
        request,
        await this.#runtimeConfiguration(request),
        this.nativeSessions,
      ));
    } catch (error) {
      throw error;
    }
  }

  #capture(chatId: string, runId: string, publish: AgentRuntimePublisher): void {
    this.#operations.set(runId, { chatId, runId, publish });
  }

  // Publishing at a sink the transcript has closed is how a superseded operation is refused, so
  // the rejection is contained here rather than tearing down a stream every chat shares.
  #deliver(
    chatId: string,
    metadata: { readonly turnId?: string; readonly clientRequestId?: string } | undefined,
    build: (operation: CodexOperation) => AgentRuntimeEvent,
  ): void {
    const named = metadata?.turnId ?? metadata?.clientRequestId ?? null;
    const operation = named ? this.#operations.get(named) : undefined;
    if (!operation || operation.chatId !== chatId) {
      this.host.logger.warn('Dropped a Codex provider event with no owning operation', {
        chatId,
        turnId: named,
        eventType: build({ chatId, runId: named ?? '', publish: () => {} }).type,
      });
      return;
    }
    const event = build(operation);
    try {
      operation.publish(event);
    } catch (error) {
      this.host.logger.warn('Dropped a Codex provider event at an unavailable sink', {
        chatId,
        turnId: operation.runId,
        eventType: event.type,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #runtimeConfiguration(
    request: AgentRuntimeExecutionContext,
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

function executionFields(
  request: AgentRuntimeExecutionContext,
) {
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

function prepareStartRequest(
  request: AgentRuntimeStartRequest,
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
  const carriedContext = request.carriedContext?.prefix ?? null;
  return {
    ...executionFields(request),
    command: goal?.objective ?? (carriedContext ? `${carriedContext}${request.prompt}` : request.prompt),
    images: request.attachments,
    ...configuration,
    ...(goal ? { codexGoalCommand: goal } : {}),
    ...(goal && carriedContext ? { codexSeedContext: carriedContext } : {}),
  };
}

function prepareResumeRequest(
  request: AgentRuntimeResumeRequest,
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
