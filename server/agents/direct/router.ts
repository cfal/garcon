import {
  DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
  DIRECT_ANTHROPIC_COMPATIBLE_AGENT_LABEL,
  DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
  DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_LABEL,
  DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
  DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_LABEL,
  type AgentId,
} from '../../../common/agents.js';
import type { ApiProtocol } from '../../../common/api-providers.js';
import { endpointSupportsAgent } from '../../../common/model-routing.js';
import { AnthropicCompatibleChatRuntime, type AnthropicCompatibleChatRuntimeConfig, runAnthropicCompatibleSingleQuery } from './anthropic-compatible-chat-runtime.js';
import type { ApiProviderReader } from '../../api-providers/read-model.js';
import type { StoredApiProvider, StoredApiProviderEndpoint } from '../../api-providers/store.js';
import { OpenAiCompatibleChatRuntime, type OpenAiCompatibleChatRuntimeConfig, runOpenAiCompatibleSingleQuery } from './openai-compatible-chat-runtime.js';
import {
  OpenAiCompatibleResponsesRuntime,
  type OpenAiCompatibleResponsesRuntimeConfig,
  runOpenAiResponsesSingleQuery,
} from './openai-compatible-responses-runtime.js';
import type { AgentEventMetadata, ResumeTurnRequest, StartSessionRequest, StartedAgentSession } from '../session-types.js';
import type { AgentRuntime } from '../types.js';
import type { DirectSessionPaths } from './session-paths.js';

type DirectEventCallbacks = {
  messages: Set<(chatId: string, messages: unknown[], metadata?: AgentEventMetadata) => void>;
  processing: Set<(chatId: string, isProcessing: boolean) => void>;
  sessionCreated: Set<(chatId: string) => void>;
  finished: Set<(chatId: string, exitCode: number, metadata?: AgentEventMetadata) => void>;
  failed: Set<(chatId: string, errorMessage: string, metadata?: AgentEventMetadata) => void>;
};

export type DirectCompatibleRuntime = {
  startSession(request: StartSessionRequest): Promise<StartedAgentSession>;
  runTurn(request: ResumeTurnRequest): Promise<void>;
  abort(agentSessionId: string): boolean;
  isRunning(agentSessionId: string): boolean;
  getRunningSessions(): Array<{ id: string; status?: string; startedAt?: string }>;
  getModels?(): Promise<Array<{ value: string; label: string; supportsImages?: boolean }>>;
  startPurgeTimer(): void;
  shutdown?(): void;
  onMessages(cb: (chatId: string, messages: unknown[], metadata?: AgentEventMetadata) => void): void;
  onProcessing(cb: (chatId: string, isProcessing: boolean) => void): void;
  onSessionCreated(cb: (chatId: string) => void): void;
  onFinished(cb: (chatId: string, exitCode: number, metadata?: AgentEventMetadata) => void): void;
  onFailed(cb: (chatId: string, errorMessage: string, metadata?: AgentEventMetadata) => void): void;
};

interface DirectEndpointRouterConfig<TRuntime extends DirectCompatibleRuntime> {
  agentId: AgentId;
  label: string;
  protocol: ApiProtocol;
  noEndpointMessage: string;
  apiProviders: ApiProviderReader;
  createRuntime(endpoint: StoredApiProviderEndpoint, apiProvider: StoredApiProvider): TRuntime;
  runSingleQuery(
    prompt: string,
    endpoint: StoredApiProviderEndpoint,
    apiProvider: StoredApiProvider,
    options: Record<string, unknown>,
  ): Promise<string>;
}

export class DirectEndpointRouterRuntime<TRuntime extends DirectCompatibleRuntime> implements AgentRuntime {
  #runtimes = new Map<string, TRuntime>();
  #sessionEndpointIds = new Map<string, string>();
  #purgeTimersStarted = false;
  #runtimeDiscoveryTimer: ReturnType<typeof setInterval> | null = null;
  #callbacks: DirectEventCallbacks = {
    messages: new Set(),
    processing: new Set(),
    sessionCreated: new Set(),
    finished: new Set(),
    failed: new Set(),
  };

  constructor(private readonly config: DirectEndpointRouterConfig<TRuntime>) {}

  async startSession(request: StartSessionRequest): Promise<StartedAgentSession> {
    const { apiProvider, endpoint } = this.#resolveEndpoint(request.modelEndpointId);
    const runtime = this.#runtimeFor(endpoint, apiProvider);
    const started = await runtime.startSession(request);
    this.#sessionEndpointIds.set(started.agentSessionId, endpoint.id);
    return started;
  }

  async runTurn(request: ResumeTurnRequest): Promise<void> {
    let runtime = this.#runtimeForSession(request.agentSessionId);
    if (!runtime && request.modelEndpointId) {
      const { apiProvider, endpoint } = this.#resolveEndpoint(request.modelEndpointId);
      runtime = this.#runtimeFor(endpoint, apiProvider);
      this.#sessionEndpointIds.set(request.agentSessionId, endpoint.id);
    }
    if (!runtime) {
      throw new Error(`Unknown ${this.config.label} session: ${request.agentSessionId}`);
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
    return Array.from(this.#runtimes.values()).flatMap((runtime) => runtime.getRunningSessions());
  }

  async getModels(): Promise<Array<{ value: string; label: string; supportsImages?: boolean }>> {
    const models: Array<{ value: string; label: string; supportsImages?: boolean }> = [];
    for (const apiProvider of this.config.apiProviders.list()) {
      for (const endpoint of apiProvider.endpoints) {
        if (!this.#isDirectEndpoint(endpoint)) continue;
        for (const model of endpoint.models) {
          models.push({
            value: model.value,
            label: `${apiProvider.label}: ${model.label}`,
            supportsImages: model.supportsImages ?? endpoint.supportsImages,
          });
        }
      }
    }
    return models;
  }

  runSingleQuery(prompt: string, options: Record<string, unknown> = {}): Promise<string> {
    const endpointId = typeof options.modelEndpointId === 'string' ? options.modelEndpointId : undefined;
    const { apiProvider, endpoint } = this.#resolveEndpoint(endpointId);
    return this.config.runSingleQuery(prompt, endpoint, apiProvider, options);
  }

  startPurgeTimer(): void {
    if (this.#runtimeDiscoveryTimer) return;
    this.#purgeTimersStarted = true;
    for (const runtime of this.#runtimes.values()) {
      runtime.startPurgeTimer();
    }
    this.#runtimeDiscoveryTimer = setInterval(() => {
      for (const runtime of this.#runtimes.values()) {
        runtime.startPurgeTimer();
      }
    }, 5 * 60 * 1000);
  }

  shutdown(): void {
    if (this.#runtimeDiscoveryTimer) {
      clearInterval(this.#runtimeDiscoveryTimer);
      this.#runtimeDiscoveryTimer = null;
    }
    for (const runtime of this.#runtimes.values()) {
      runtime.shutdown?.();
    }
  }

  onMessages(cb: (chatId: string, messages: unknown[], metadata?: AgentEventMetadata) => void): void {
    this.#callbacks.messages.add(cb);
  }

  onProcessing(cb: (chatId: string, isProcessing: boolean) => void): void {
    this.#callbacks.processing.add(cb);
  }

  onSessionCreated(cb: (chatId: string) => void): void {
    this.#callbacks.sessionCreated.add(cb);
  }

  onFinished(cb: (chatId: string, exitCode: number, metadata?: AgentEventMetadata) => void): void {
    this.#callbacks.finished.add(cb);
  }

  onFailed(cb: (chatId: string, errorMessage: string, metadata?: AgentEventMetadata) => void): void {
    this.#callbacks.failed.add(cb);
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

  #runtimeFor(endpoint: StoredApiProviderEndpoint, apiProvider: StoredApiProvider): TRuntime {
    const existing = this.#runtimes.get(endpoint.id);
    if (existing) return existing;

    const runtime = this.config.createRuntime(endpoint, apiProvider);
    this.#attachForwarders(runtime);
    this.#runtimes.set(endpoint.id, runtime);

    if (this.#purgeTimersStarted) {
      runtime.startPurgeTimer();
    }
    return runtime;
  }

  #attachForwarders(runtime: TRuntime): void {
    runtime.onMessages((chatId, messages, metadata) => {
      for (const cb of this.#callbacks.messages) cb(chatId, messages, metadata);
    });
    runtime.onProcessing((chatId, isProcessing) => {
      for (const cb of this.#callbacks.processing) cb(chatId, isProcessing);
    });
    runtime.onSessionCreated((chatId) => {
      for (const cb of this.#callbacks.sessionCreated) cb(chatId);
    });
    runtime.onFinished((chatId, exitCode, metadata) => {
      for (const cb of this.#callbacks.finished) cb(chatId, exitCode, metadata);
    });
    runtime.onFailed((chatId, errorMessage, metadata) => {
      for (const cb of this.#callbacks.failed) cb(chatId, errorMessage, metadata);
    });
  }

  #resolveEndpoint(endpointId?: string | null): { apiProvider: StoredApiProvider; endpoint: StoredApiProviderEndpoint } {
    if (endpointId) {
      const resolved = this.config.apiProviders.getEndpoint(endpointId);
      if (resolved && this.#isDirectEndpoint(resolved.endpoint)) {
        return resolved;
      }
    }

    for (const apiProvider of this.config.apiProviders.list()) {
      const endpoint = apiProvider.endpoints.find((entry) => this.#isDirectEndpoint(entry));
      if (endpoint) return { apiProvider, endpoint };
    }

    throw new Error(this.config.noEndpointMessage);
  }

  #isDirectEndpoint(endpoint: StoredApiProviderEndpoint): boolean {
    return endpoint.protocol === this.config.protocol
      && endpointSupportsAgent(this.config.agentId, endpoint);
  }
}

export function createDirectOpenAiChatRuntime(
  apiProviders: ApiProviderReader,
  sessionPaths: DirectSessionPaths,
): DirectEndpointRouterRuntime<OpenAiCompatibleChatRuntime> {
  return new DirectEndpointRouterRuntime<OpenAiCompatibleChatRuntime>({
    agentId: DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
    label: DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_LABEL,
    protocol: 'openai-compatible',
    noEndpointMessage: `No OpenAI-compatible Chat Completions endpoint is configured for ${DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_LABEL}.`,
    apiProviders,
    createRuntime(endpoint) {
      return new OpenAiCompatibleChatRuntime(buildDirectOpenAiConfig({
        runtimeId: DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
        runtimeLabel: DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_LABEL,
        endpoint,
        sessionPaths,
      }));
    },
    runSingleQuery(prompt, endpoint, apiProvider, options) {
      return runOpenAiCompatibleSingleQuery(buildDirectOpenAiConfig({
        runtimeId: DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
        runtimeLabel: apiProvider.label,
        endpoint,
        sessionPaths,
      }), prompt, options);
    },
  });
}

export function createDirectOpenAiResponsesRuntime(
  apiProviders: ApiProviderReader,
  sessionPaths: DirectSessionPaths,
): DirectEndpointRouterRuntime<OpenAiCompatibleResponsesRuntime> {
  return new DirectEndpointRouterRuntime<OpenAiCompatibleResponsesRuntime>({
    agentId: DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
    label: DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_LABEL,
    protocol: 'openai-compatible',
    noEndpointMessage: `No OpenAI-compatible Responses endpoint is configured for ${DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_LABEL}.`,
    apiProviders,
    createRuntime(endpoint) {
      return new OpenAiCompatibleResponsesRuntime(buildDirectOpenAiResponsesConfig({
        runtimeId: DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
        runtimeLabel: DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_LABEL,
        endpoint,
        sessionPaths,
      }));
    },
    runSingleQuery(prompt, endpoint, apiProvider, options) {
      return runOpenAiResponsesSingleQuery(buildDirectOpenAiResponsesConfig({
        runtimeId: DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
        runtimeLabel: apiProvider.label,
        endpoint,
        sessionPaths,
      }), prompt, options);
    },
  });
}

export function createDirectAnthropicRuntime(
  apiProviders: ApiProviderReader,
  sessionPaths: DirectSessionPaths,
): DirectEndpointRouterRuntime<AnthropicCompatibleChatRuntime> {
  return new DirectEndpointRouterRuntime<AnthropicCompatibleChatRuntime>({
    agentId: DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
    label: DIRECT_ANTHROPIC_COMPATIBLE_AGENT_LABEL,
    protocol: 'anthropic-messages',
    noEndpointMessage: `No Anthropic-compatible endpoint is configured for ${DIRECT_ANTHROPIC_COMPATIBLE_AGENT_LABEL}.`,
    apiProviders,
    createRuntime(endpoint) {
      return new AnthropicCompatibleChatRuntime(buildDirectAnthropicConfig({
        runtimeId: DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
        runtimeLabel: DIRECT_ANTHROPIC_COMPATIBLE_AGENT_LABEL,
        endpoint,
        sessionPaths,
      }));
    },
    runSingleQuery(prompt, endpoint, apiProvider, options) {
      return runAnthropicCompatibleSingleQuery(buildDirectAnthropicConfig({
        runtimeId: DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
        runtimeLabel: apiProvider.label,
        endpoint,
        sessionPaths,
      }), prompt, options);
    },
  });
}

export function buildDirectOpenAiConfig(args: {
  runtimeId: string;
  runtimeLabel: string;
  endpoint: StoredApiProviderEndpoint;
  sessionPaths: DirectSessionPaths;
}): OpenAiCompatibleChatRuntimeConfig {
  return {
    runtimeId: args.runtimeId,
    runtimeLabel: args.runtimeLabel,
    defaultModel: args.endpoint.defaultModel,
    fallbackModels: args.endpoint.models,
    getApiKey: () => args.endpoint.apiKey,
    getBaseUrl: () => args.endpoint.baseUrl,
    getSessionDir: () => args.sessionPaths.sessionDir(args.endpoint.id),
    getSessionFilePath: (sessionId) => args.sessionPaths.sessionFilePath(args.endpoint.id, sessionId),
    buildHeaders: (apiKey) => ({
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      'Content-Type': 'application/json',
      ...(args.endpoint.headers ?? {}),
    }),
  };
}

export function buildDirectOpenAiResponsesConfig(args: {
  runtimeId: string;
  runtimeLabel: string;
  endpoint: StoredApiProviderEndpoint;
  sessionPaths: DirectSessionPaths;
}): OpenAiCompatibleResponsesRuntimeConfig {
  return {
    runtimeId: args.runtimeId,
    runtimeLabel: args.runtimeLabel,
    defaultModel: args.endpoint.defaultModel,
    fallbackModels: args.endpoint.models,
    getApiKey: () => args.endpoint.apiKey,
    getBaseUrl: () => args.endpoint.baseUrl,
    getSessionDir: () => args.sessionPaths.sessionDir(args.endpoint.id),
    getSessionFilePath: (sessionId) => args.sessionPaths.sessionFilePath(args.endpoint.id, sessionId),
    buildHeaders: (apiKey) => ({
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      'Content-Type': 'application/json',
      ...(args.endpoint.headers ?? {}),
    }),
  };
}

export function buildDirectAnthropicConfig(args: {
  runtimeId: string;
  runtimeLabel: string;
  endpoint: StoredApiProviderEndpoint;
  sessionPaths: DirectSessionPaths;
}): AnthropicCompatibleChatRuntimeConfig {
  return {
    runtimeId: args.runtimeId,
    runtimeLabel: args.runtimeLabel,
    defaultModel: args.endpoint.defaultModel,
    fallbackModels: args.endpoint.models,
    getApiKey: () => args.endpoint.apiKey,
    getBaseUrl: () => args.endpoint.baseUrl,
    getSessionDir: () => args.sessionPaths.sessionDir(args.endpoint.id),
    getSessionFilePath: (sessionId) => args.sessionPaths.sessionFilePath(args.endpoint.id, sessionId),
  };
}
