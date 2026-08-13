import { receiptForCarriedContext } from '@garcon/common/transcript-seed';
import {
  AgentIntegrationError,
  type AgentStartedSession,
  type AgentGoalControlRequest,
  type AgentHost,
} from '@garcon/server-agent-interface';
import {
  AgentRuntimeEventChannel,
  runtimeRows,
  type AgentRuntimeExecution,
  type AgentRuntimeExecutionContext,
  type AgentRuntimeResumeRequest,
  type AgentRuntimeStartRequest,
} from '@garcon/server-agent-common/execution/runtime-events';
import { AgentRunTracker } from '@garcon/server-agent-common/execution/run-tracker';
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

export class CodexExecution implements AgentRuntimeExecution {
  readonly #events = new AgentRuntimeEventChannel();
  readonly #runs = new AgentRunTracker();

  constructor(
    private readonly host: AgentHost,
    private readonly runtime: CodexAppServerRuntime,
    private readonly nativeSessions: PathNativeSessionCodec,
    private readonly config: CodexConfig,
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

  async start(request: AgentRuntimeStartRequest) {
    this.#runs.register(request.chatId, request.runId);
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
        this.#events.emit({
          type: 'session',
          chatId: request.chatId,
          session: holder.session,
        });
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
      this.#runs.finish(request.chatId, request.runId);
      throw error;
    }
  }

  async resume(request: AgentRuntimeResumeRequest): Promise<void> {
    return this.#resume(request, (runtimeRequest) => this.runtime.runTurn(runtimeRequest));
  }

  async submitGoalControl(
    request: CodexGoalControlRuntimeRequest,
  ): Promise<boolean> {
    const predecessor = this.#runs.current(request.chatId);
    const runtimeRequest = prepareResumeRequest(
      request,
      await this.#runtimeConfiguration(request),
      this.nativeSessions,
    );
    return this.runtime.submitGoalControl(
      runtimeRequest,
      (handoff) => request.beforeDelivery(this.#runs.handoff(
        request.chatId,
        predecessor,
        request.runId,
        handoff,
      )),
    );
  }

  async compact(request: AgentRuntimeResumeRequest): Promise<void> {
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

  subscribeRuntimeEvents(
    listener: Parameters<AgentRuntimeEventChannel['subscribe']>[0],
  ): () => void {
    return this.#events.subscribe(listener);
  }

  async #resume(
    request: AgentRuntimeResumeRequest,
    action: (runtimeRequest: CodexResumeRequest) => Promise<void>,
  ): Promise<void> {
    this.#runs.register(request.chatId, request.runId);
    try {
      await action(prepareResumeRequest(
        request,
        await this.#runtimeConfiguration(request),
        this.nativeSessions,
      ));
    } catch (error) {
      this.#runs.finish(request.chatId, request.runId);
      throw error;
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
