import type { ApiProtocol } from '@garcon/common/api-providers';
import type { AgentLogger } from '@garcon/server-agent-interface';
import {
  AnthropicCompatibleChatRuntime,
  runAnthropicCompatibleSingleQuery,
  type AnthropicCompatibleChatRuntimeConfig,
} from './anthropic-compatible-chat-runtime.js';
import {
  OpenAiCompatibleChatRuntime,
  runOpenAiCompatibleSingleQuery,
  type OpenAiCompatibleChatRuntimeConfig,
} from './openai-compatible-chat-runtime.js';
import {
  OpenAiCompatibleResponsesRuntime,
  runOpenAiResponsesSingleQuery,
  type OpenAiCompatibleResponsesRuntimeConfig,
} from './openai-compatible-responses-runtime.js';
import type {
  DirectEndpointRuntime,
  DirectResumeRequest,
  DirectStartedSession,
  DirectStartRequest,
} from './runtime-types.js';
import type { DirectSessionPaths } from './session-paths.js';

export interface DirectCompatibleRuntime {
  startSession(request: DirectStartRequest): Promise<DirectStartedSession>;
  runTurn(request: DirectResumeRequest): Promise<void>;
  abort(agentSessionId: string): boolean;
  isRunning(agentSessionId: string): boolean;
  getRunningSessions(): Array<{ id: string; status?: string; startedAt?: string }>;
  startPurgeTimer(): void;
  shutdown?(): void;
}

export interface DirectEndpointRouterConfig<TRuntime extends DirectCompatibleRuntime> {
  readonly label: string;
  readonly protocol: ApiProtocol;
  readonly createRuntime: (endpoint: DirectEndpointRuntime) => TRuntime;
  readonly runSingleQuery: (
    prompt: string,
    endpoint: DirectEndpointRuntime,
    options: Record<string, unknown>,
  ) => Promise<string>;
}

export class DirectEndpointRouterRuntime<
  TRuntime extends DirectCompatibleRuntime,
> {
  readonly #runtimes = new Map<string, TRuntime>();
  readonly #sessionEndpointIds = new Map<string, string>();
  #purgeTimersStarted = false;

  constructor(private readonly config: DirectEndpointRouterConfig<TRuntime>) {}

  async startSession(request: DirectStartRequest): Promise<DirectStartedSession> {
    const runtime = this.#runtimeFor(request.endpoint);
    const started = await runtime.startSession(request);
    this.#sessionEndpointIds.set(
      started.agentSessionId,
      request.endpoint.selection.endpointId,
    );
    return started;
  }

  async runTurn(request: DirectResumeRequest): Promise<void> {
    let runtime = this.#runtimeForSession(request.agentSessionId);
    if (!runtime) {
      runtime = this.#runtimeFor(request.endpoint);
      this.#sessionEndpointIds.set(
        request.agentSessionId,
        request.endpoint.selection.endpointId,
      );
    }
    await runtime.runTurn(request);
  }

  abort(agentSessionId: string): boolean {
    return this.#runtimeForSession(agentSessionId)?.abort(agentSessionId) ?? false;
  }

  isRunning(agentSessionId: string): boolean {
    return this.#runtimeForSession(agentSessionId)?.isRunning(agentSessionId) ?? false;
  }

  getRunningSessions(): Array<{ id: string; status?: string; startedAt?: string }> {
    return Array.from(this.#runtimes.values()).flatMap(
      (runtime) => runtime.getRunningSessions(),
    );
  }

  runSingleQuery(
    prompt: string,
    endpoint: DirectEndpointRuntime,
    options: Record<string, unknown> = {},
  ): Promise<string> {
    this.#validateEndpoint(endpoint);
    return this.config.runSingleQuery(prompt, endpoint, options);
  }

  startPurgeTimer(): void {
    if (this.#purgeTimersStarted) return;
    this.#purgeTimersStarted = true;
    for (const runtime of this.#runtimes.values()) runtime.startPurgeTimer();
  }

  shutdown(): void {
    this.#purgeTimersStarted = false;
    for (const runtime of this.#runtimes.values()) runtime.shutdown?.();
    this.#runtimes.clear();
    this.#sessionEndpointIds.clear();
  }

  #runtimeForSession(agentSessionId: string): TRuntime | null {
    const endpointId = this.#sessionEndpointIds.get(agentSessionId);
    if (endpointId) {
      const runtime = this.#runtimes.get(endpointId);
      if (runtime) return runtime;
    }
    for (const runtime of this.#runtimes.values()) {
      if (runtime.isRunning(agentSessionId)) return runtime;
    }
    return null;
  }

  #runtimeFor(endpoint: DirectEndpointRuntime): TRuntime {
    this.#validateEndpoint(endpoint);
    const endpointId = endpoint.selection.endpointId;
    const existing = this.#runtimes.get(endpointId);
    if (existing) return existing;
    const runtime = this.config.createRuntime(endpoint);
    this.#runtimes.set(endpointId, runtime);
    if (this.#purgeTimersStarted) runtime.startPurgeTimer();
    return runtime;
  }

  #validateEndpoint(endpoint: DirectEndpointRuntime): void {
    if (endpoint.selection.protocol !== this.config.protocol) {
      throw new Error(
        `${this.config.label} does not support ${endpoint.selection.protocol} endpoints`,
      );
    }
  }

}

export interface DirectRuntimeFamilyOptions {
  readonly runtimeId: string;
  readonly runtimeLabel: string;
  readonly sessionPaths: DirectSessionPaths;
  readonly logger?: AgentLogger;
}

export function createDirectOpenAiChatRuntime(
  options: DirectRuntimeFamilyOptions,
): DirectEndpointRouterRuntime<OpenAiCompatibleChatRuntime> {
  return new DirectEndpointRouterRuntime({
    label: options.runtimeLabel,
    protocol: 'openai-compatible',
    createRuntime: (endpoint) => new OpenAiCompatibleChatRuntime(
      buildDirectOpenAiConfig({ ...options, endpoint }),
    ),
    runSingleQuery: (prompt, endpoint, query) => runOpenAiCompatibleSingleQuery(
      buildDirectOpenAiConfig({ ...options, endpoint }),
      prompt,
      query,
    ),
  });
}

export function createDirectOpenAiResponsesRuntime(
  options: DirectRuntimeFamilyOptions,
): DirectEndpointRouterRuntime<OpenAiCompatibleResponsesRuntime> {
  return new DirectEndpointRouterRuntime({
    label: options.runtimeLabel,
    protocol: 'openai-compatible',
    createRuntime: (endpoint) => new OpenAiCompatibleResponsesRuntime(
      buildDirectOpenAiResponsesConfig({ ...options, endpoint }),
    ),
    runSingleQuery: (prompt, endpoint, query) => runOpenAiResponsesSingleQuery(
      buildDirectOpenAiResponsesConfig({ ...options, endpoint }),
      prompt,
      query,
    ),
  });
}

export function createDirectAnthropicRuntime(
  options: DirectRuntimeFamilyOptions,
): DirectEndpointRouterRuntime<AnthropicCompatibleChatRuntime> {
  return new DirectEndpointRouterRuntime({
    label: options.runtimeLabel,
    protocol: 'anthropic-messages',
    createRuntime: (endpoint) => new AnthropicCompatibleChatRuntime(
      buildDirectAnthropicConfig({ ...options, endpoint }),
    ),
    runSingleQuery: (prompt, endpoint, query) => runAnthropicCompatibleSingleQuery(
      buildDirectAnthropicConfig({ ...options, endpoint }),
      prompt,
      query,
    ),
  });
}

function endpointModels(endpoint: DirectEndpointRuntime) {
  return [{
    value: endpoint.selection.model,
    label: endpoint.selection.model,
  }];
}

export function buildDirectOpenAiConfig(args: DirectRuntimeFamilyOptions & {
  readonly endpoint: DirectEndpointRuntime;
}): OpenAiCompatibleChatRuntimeConfig {
  return {
    runtimeId: args.runtimeId,
    runtimeLabel: args.runtimeLabel,
    defaultModel: args.endpoint.selection.model,
    fallbackModels: endpointModels(args.endpoint),
    getApiKey: () => args.endpoint.credential ?? '',
    getBaseUrl: () => args.endpoint.selection.baseUrl,
    getSessionDir: () => args.sessionPaths.sessionDir(args.endpoint.selection.endpointId),
    getSessionFilePath: (sessionId) => args.sessionPaths.sessionFilePath(
      args.endpoint.selection.endpointId,
      sessionId,
    ),
    logger: args.logger,
    buildHeaders: (apiKey) => ({
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      'Content-Type': 'application/json',
    }),
  };
}

export function buildDirectOpenAiResponsesConfig(args: DirectRuntimeFamilyOptions & {
  readonly endpoint: DirectEndpointRuntime;
}): OpenAiCompatibleResponsesRuntimeConfig {
  return {
    runtimeId: args.runtimeId,
    runtimeLabel: args.runtimeLabel,
    defaultModel: args.endpoint.selection.model,
    fallbackModels: endpointModels(args.endpoint),
    getApiKey: () => args.endpoint.credential ?? '',
    getBaseUrl: () => args.endpoint.selection.baseUrl,
    getSessionDir: () => args.sessionPaths.sessionDir(args.endpoint.selection.endpointId),
    getSessionFilePath: (sessionId) => args.sessionPaths.sessionFilePath(
      args.endpoint.selection.endpointId,
      sessionId,
    ),
    buildHeaders: (apiKey) => ({
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      'Content-Type': 'application/json',
    }),
  };
}

export function buildDirectAnthropicConfig(args: DirectRuntimeFamilyOptions & {
  readonly endpoint: DirectEndpointRuntime;
}): AnthropicCompatibleChatRuntimeConfig {
  return {
    runtimeId: args.runtimeId,
    runtimeLabel: args.runtimeLabel,
    defaultModel: args.endpoint.selection.model,
    fallbackModels: endpointModels(args.endpoint),
    getApiKey: () => args.endpoint.credential ?? '',
    getBaseUrl: () => args.endpoint.selection.baseUrl,
    getSessionDir: () => args.sessionPaths.sessionDir(args.endpoint.selection.endpointId),
    getSessionFilePath: (sessionId) => args.sessionPaths.sessionFilePath(
      args.endpoint.selection.endpointId,
      sessionId,
    ),
  };
}
