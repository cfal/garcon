import { receiptForCarriedContext } from '@garcon/common/transcript-seed';
import {
  AgentIntegrationError,
  type AgentEstablishedSession,
  type AgentGoalControlRequest,
  type AgentHost,
} from '@garcon/server-agent-interface';
import {
  type AgentRuntimeExecution,
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
import { codexOperation } from './app-server/operation-routes.js';
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
  constructor(
    private readonly host: AgentHost,
    private readonly runtime: CodexAppServerRuntime,
    private readonly nativeSessions: PathNativeSessionCodec,
    private readonly config: CodexConfig,
  ) {}

  async start(request: AgentRuntimeStartRequest, publish: AgentRuntimePublisher) {
    const configuration = await this.#runtimeConfiguration(request);
    const runtimeRequest = prepareStartRequest(request, configuration, publish);
    // A blocking runtime can settle the first turn inside startSession.
    const holder: { session: AgentEstablishedSession | null } = { session: null };
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
  }

  async resume(request: AgentRuntimeResumeRequest, publish: AgentRuntimePublisher): Promise<void> {
    return this.#resume(request, publish, (runtimeRequest) => this.runtime.runTurn(runtimeRequest));
  }

  async submitGoalControl(
    request: CodexGoalControlRuntimeRequest,
    publish: AgentRuntimePublisher,
  ): Promise<boolean> {
    const runtimeRequest = prepareResumeRequest(
      request,
      await this.#runtimeConfiguration(request),
      this.nativeSessions,
      publish,
    );
    return this.runtime.submitGoalControl(runtimeRequest, request.beforeDelivery);
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

  async #resume(
    request: AgentRuntimeResumeRequest,
    publish: AgentRuntimePublisher,
    action: (runtimeRequest: CodexResumeRequest) => Promise<void>,
  ): Promise<void> {
    await action(prepareResumeRequest(
      request,
      await this.#runtimeConfiguration(request),
      this.nativeSessions,
      publish,
    ));
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
    executionAdmission: {
      signal: request.admission.signal,
      markStarted: () => request.admission.markStarted(),
    },
  };
}

function prepareStartRequest(
  request: AgentRuntimeStartRequest,
  configuration: CodexRuntimeConfiguration,
  publish: AgentRuntimePublisher,
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
    operation: codexOperation(request, publish),
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
  publish: AgentRuntimePublisher,
): CodexResumeRequest {
  const goal = parseCodexGoalCommand(request.prompt);
  return {
    ...executionFields(request),
    operation: codexOperation(request, publish),
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
