import {
  DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID,
  DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_LABEL,
  DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_HARNESS_ID,
  DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_HARNESS_LABEL,
  DIRECT_OPENAI_RESPONSES_COMPATIBLE_HARNESS_ID,
  DIRECT_OPENAI_RESPONSES_COMPATIBLE_HARNESS_LABEL,
  endpointSupportsHarness,
  type ApiProtocol,
  type HarnessId,
} from '../../../common/providers.js';
import { getWorkspaceDir } from '../../config.js';
import { AnthropicCompatibleChatProvider, type AnthropicCompatibleChatProviderConfig, runAnthropicCompatibleSingleQuery } from '../../providers/anthropic-compatible-chat-provider.js';
import type { ApiProviderStore, StoredApiProvider, StoredApiProviderEndpoint } from '../../providers/api-provider-store.js';
import { OpenAiCompatibleChatProvider, type OpenAiCompatibleChatProviderConfig, runOpenAiCompatibleSingleQuery } from '../../providers/openai-compatible-chat-provider.js';
import {
  OpenAiCompatibleResponsesProvider,
  type OpenAiCompatibleResponsesProviderConfig,
  runOpenAiResponsesSingleQuery,
} from '../../providers/openai-compatible-responses-provider.js';
import type { ProviderEventMetadata, ResumeTurnRequest, StartSessionRequest, StartedProviderSession } from '../../providers/types.js';
import type { HarnessRuntime } from '../types.js';

type DirectEventCallbacks = {
  messages: Set<(chatId: string, messages: unknown[], metadata?: ProviderEventMetadata) => void>;
  processing: Set<(chatId: string, isProcessing: boolean) => void>;
  sessionCreated: Set<(chatId: string) => void>;
  finished: Set<(chatId: string, exitCode: number, metadata?: ProviderEventMetadata) => void>;
  failed: Set<(chatId: string, errorMessage: string) => void>;
};

export type DirectCompatibleProvider = {
  startSession(request: StartSessionRequest): Promise<StartedProviderSession>;
  runTurn(request: ResumeTurnRequest): Promise<void>;
  abort(providerSessionId: string): boolean;
  isRunning(providerSessionId: string): boolean;
  getRunningSessions(): Array<{ id: string; status?: string; startedAt?: string }>;
  getModels?(): Promise<Array<{ value: string; label: string; supportsImages?: boolean }>>;
  startPurgeTimer(): ReturnType<typeof setInterval>;
  onMessages(cb: (chatId: string, messages: unknown[], metadata?: ProviderEventMetadata) => void): void;
  onProcessing(cb: (chatId: string, isProcessing: boolean) => void): void;
  onSessionCreated(cb: (chatId: string) => void): void;
  onFinished(cb: (chatId: string, exitCode: number, metadata?: ProviderEventMetadata) => void): void;
  onFailed(cb: (chatId: string, errorMessage: string) => void): void;
};

interface DirectEndpointRouterConfig<TProvider extends DirectCompatibleProvider> {
  harnessId: HarnessId;
  label: string;
  protocol: ApiProtocol;
  noEndpointMessage: string;
  apiProviderStore: ApiProviderStore;
  createProvider(endpoint: StoredApiProviderEndpoint, apiProvider: StoredApiProvider): TProvider;
  runSingleQuery(
    prompt: string,
    endpoint: StoredApiProviderEndpoint,
    apiProvider: StoredApiProvider,
    options: Record<string, unknown>,
  ): Promise<string>;
}

export class DirectEndpointRouterRuntime<TProvider extends DirectCompatibleProvider> implements HarnessRuntime {
  #providers = new Map<string, TProvider>();
  #sessionEndpointIds = new Map<string, string>();
  #purgeTimers = new Map<string, ReturnType<typeof setInterval>>();
  #purgeTimersStarted = false;
  #callbacks: DirectEventCallbacks = {
    messages: new Set(),
    processing: new Set(),
    sessionCreated: new Set(),
    finished: new Set(),
    failed: new Set(),
  };

  constructor(private readonly config: DirectEndpointRouterConfig<TProvider>) {}

  async startSession(request: StartSessionRequest): Promise<StartedProviderSession> {
    const { apiProvider, endpoint } = this.#resolveEndpoint(request.modelEndpointId);
    const provider = this.#providerFor(endpoint, apiProvider);
    const started = await provider.startSession(request);
    this.#sessionEndpointIds.set(started.providerSessionId, endpoint.id);
    return started;
  }

  async runTurn(request: ResumeTurnRequest): Promise<void> {
    let provider = this.#providerForSession(request.providerSessionId);
    if (!provider && request.modelEndpointId) {
      const { apiProvider, endpoint } = this.#resolveEndpoint(request.modelEndpointId);
      provider = this.#providerFor(endpoint, apiProvider);
      this.#sessionEndpointIds.set(request.providerSessionId, endpoint.id);
    }
    if (!provider) {
      throw new Error(`Unknown ${this.config.label} session: ${request.providerSessionId}`);
    }
    await provider.runTurn(request);
  }

  abort(providerSessionId: string): boolean {
    return this.#providerForSession(providerSessionId)?.abort(providerSessionId) ?? false;
  }

  isRunning(providerSessionId: string): boolean {
    return this.#providerForSession(providerSessionId)?.isRunning(providerSessionId) ?? false;
  }

  getRunningSessions(): Array<{ id: string; status?: string; startedAt?: string }> {
    return Array.from(this.#providers.values()).flatMap((provider) => provider.getRunningSessions());
  }

  async getModels(): Promise<Array<{ value: string; label: string; supportsImages?: boolean }>> {
    const models: Array<{ value: string; label: string; supportsImages?: boolean }> = [];
    for (const apiProvider of this.config.apiProviderStore.list()) {
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

  startPurgeTimer(): ReturnType<typeof setInterval> {
    this.#purgeTimersStarted = true;
    for (const [endpointId, provider] of this.#providers.entries()) {
      if (!this.#purgeTimers.has(endpointId)) {
        this.#purgeTimers.set(endpointId, provider.startPurgeTimer());
      }
    }
    return setInterval(() => {
      for (const [endpointId, provider] of this.#providers.entries()) {
        if (!this.#purgeTimers.has(endpointId)) {
          this.#purgeTimers.set(endpointId, provider.startPurgeTimer());
        }
      }
    }, 5 * 60 * 1000);
  }

  shutdown(): void {
    for (const timer of this.#purgeTimers.values()) clearInterval(timer);
    this.#purgeTimers.clear();
  }

  onMessages(cb: (chatId: string, messages: unknown[], metadata?: ProviderEventMetadata) => void): void {
    this.#callbacks.messages.add(cb);
  }

  onProcessing(cb: (chatId: string, isProcessing: boolean) => void): void {
    this.#callbacks.processing.add(cb);
  }

  onSessionCreated(cb: (chatId: string) => void): void {
    this.#callbacks.sessionCreated.add(cb);
  }

  onFinished(cb: (chatId: string, exitCode: number, metadata?: ProviderEventMetadata) => void): void {
    this.#callbacks.finished.add(cb);
  }

  onFailed(cb: (chatId: string, errorMessage: string) => void): void {
    this.#callbacks.failed.add(cb);
  }

  #providerForSession(providerSessionId: string): TProvider | null {
    const endpointId = this.#sessionEndpointIds.get(providerSessionId);
    if (endpointId) {
      const provider = this.#providers.get(endpointId);
      if (provider) return provider;
    }
    for (const provider of this.#providers.values()) {
      if (provider.isRunning(providerSessionId)) return provider;
    }
    return null;
  }

  #providerFor(endpoint: StoredApiProviderEndpoint, apiProvider: StoredApiProvider): TProvider {
    const existing = this.#providers.get(endpoint.id);
    if (existing) return existing;

    const provider = this.config.createProvider(endpoint, apiProvider);
    this.#attachForwarders(provider);
    this.#providers.set(endpoint.id, provider);

    if (this.#purgeTimersStarted) {
      this.#purgeTimers.set(endpoint.id, provider.startPurgeTimer());
    }
    return provider;
  }

  #attachForwarders(provider: TProvider): void {
    provider.onMessages((chatId, messages, metadata) => {
      for (const cb of this.#callbacks.messages) cb(chatId, messages, metadata);
    });
    provider.onProcessing((chatId, isProcessing) => {
      for (const cb of this.#callbacks.processing) cb(chatId, isProcessing);
    });
    provider.onSessionCreated((chatId) => {
      for (const cb of this.#callbacks.sessionCreated) cb(chatId);
    });
    provider.onFinished((chatId, exitCode, metadata) => {
      for (const cb of this.#callbacks.finished) cb(chatId, exitCode, metadata);
    });
    provider.onFailed((chatId, errorMessage) => {
      for (const cb of this.#callbacks.failed) cb(chatId, errorMessage);
    });
  }

  #resolveEndpoint(endpointId?: string | null): { apiProvider: StoredApiProvider; endpoint: StoredApiProviderEndpoint } {
    if (endpointId) {
      const resolved = this.config.apiProviderStore.getEndpoint(endpointId);
      if (resolved && this.#isDirectEndpoint(resolved.endpoint)) {
        return resolved;
      }
    }

    for (const apiProvider of this.config.apiProviderStore.list()) {
      const endpoint = apiProvider.endpoints.find((entry) => this.#isDirectEndpoint(entry));
      if (endpoint) return { apiProvider, endpoint };
    }

    throw new Error(this.config.noEndpointMessage);
  }

  #isDirectEndpoint(endpoint: StoredApiProviderEndpoint): boolean {
    return endpoint.protocol === this.config.protocol
      && endpointSupportsHarness(this.config.harnessId, endpoint);
  }
}

export function createDirectOpenAiChatRuntime(apiProviderStore: ApiProviderStore): DirectEndpointRouterRuntime<OpenAiCompatibleChatProvider> {
  return new DirectEndpointRouterRuntime<OpenAiCompatibleChatProvider>({
    harnessId: DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_HARNESS_ID,
    label: DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_HARNESS_LABEL,
    protocol: 'openai-compatible',
    noEndpointMessage: `No OpenAI-compatible Chat Completions endpoint is configured for ${DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_HARNESS_LABEL}.`,
    apiProviderStore,
    createProvider(endpoint) {
      return new OpenAiCompatibleChatProvider(buildDirectOpenAiConfig({
        providerId: DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_HARNESS_ID,
        providerLabel: DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_HARNESS_LABEL,
        endpoint,
      }));
    },
    runSingleQuery(prompt, endpoint, apiProvider, options) {
      return runOpenAiCompatibleSingleQuery(buildDirectOpenAiConfig({
        providerId: DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_HARNESS_ID,
        providerLabel: apiProvider.label,
        endpoint,
      }), prompt, options);
    },
  });
}

export function createDirectOpenAiResponsesRuntime(apiProviderStore: ApiProviderStore): DirectEndpointRouterRuntime<OpenAiCompatibleResponsesProvider> {
  return new DirectEndpointRouterRuntime<OpenAiCompatibleResponsesProvider>({
    harnessId: DIRECT_OPENAI_RESPONSES_COMPATIBLE_HARNESS_ID,
    label: DIRECT_OPENAI_RESPONSES_COMPATIBLE_HARNESS_LABEL,
    protocol: 'openai-compatible',
    noEndpointMessage: `No OpenAI-compatible Responses endpoint is configured for ${DIRECT_OPENAI_RESPONSES_COMPATIBLE_HARNESS_LABEL}.`,
    apiProviderStore,
    createProvider(endpoint) {
      return new OpenAiCompatibleResponsesProvider(buildDirectOpenAiResponsesConfig({
        providerId: DIRECT_OPENAI_RESPONSES_COMPATIBLE_HARNESS_ID,
        providerLabel: DIRECT_OPENAI_RESPONSES_COMPATIBLE_HARNESS_LABEL,
        endpoint,
      }));
    },
    runSingleQuery(prompt, endpoint, apiProvider, options) {
      return runOpenAiResponsesSingleQuery(buildDirectOpenAiResponsesConfig({
        providerId: DIRECT_OPENAI_RESPONSES_COMPATIBLE_HARNESS_ID,
        providerLabel: apiProvider.label,
        endpoint,
      }), prompt, options);
    },
  });
}

export function createDirectAnthropicRuntime(apiProviderStore: ApiProviderStore): DirectEndpointRouterRuntime<AnthropicCompatibleChatProvider> {
  return new DirectEndpointRouterRuntime<AnthropicCompatibleChatProvider>({
    harnessId: DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID,
    label: DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_LABEL,
    protocol: 'anthropic-messages',
    noEndpointMessage: `No Anthropic-compatible endpoint is configured for ${DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_LABEL}.`,
    apiProviderStore,
    createProvider(endpoint) {
      return new AnthropicCompatibleChatProvider(buildDirectAnthropicConfig({
        providerId: DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID,
        providerLabel: DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_LABEL,
        endpoint,
      }));
    },
    runSingleQuery(prompt, endpoint, apiProvider, options) {
      return runAnthropicCompatibleSingleQuery(buildDirectAnthropicConfig({
        providerId: DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID,
        providerLabel: apiProvider.label,
        endpoint,
      }), prompt, options);
    },
  });
}

export function directOpenAiSessionDir(endpointId: string): string {
  return `${getWorkspaceDir()}/openai-compatible-sessions/${endpointId}`;
}

export function directOpenAiSessionFilePath(endpointId: string, sessionId: string): string {
  return `${directOpenAiSessionDir(endpointId)}/${sessionId}.jsonl`;
}

export function directOpenAiResponsesSessionDir(endpointId: string): string {
  return `${getWorkspaceDir()}/openai-compatible-responses-sessions/${endpointId}`;
}

export function directOpenAiResponsesSessionFilePath(endpointId: string, sessionId: string): string {
  return `${directOpenAiResponsesSessionDir(endpointId)}/${sessionId}.jsonl`;
}

export function directAnthropicSessionDir(endpointId: string): string {
  return `${getWorkspaceDir()}/anthropic-compatible-sessions/${endpointId}`;
}

export function directAnthropicSessionFilePath(endpointId: string, sessionId: string): string {
  return `${directAnthropicSessionDir(endpointId)}/${sessionId}.jsonl`;
}

export function buildDirectOpenAiConfig(args: {
  providerId: string;
  providerLabel: string;
  endpoint: StoredApiProviderEndpoint;
}): OpenAiCompatibleChatProviderConfig {
  return {
    providerId: args.providerId,
    providerLabel: args.providerLabel,
    defaultModel: args.endpoint.defaultModel,
    fallbackModels: args.endpoint.models,
    getApiKey: () => args.endpoint.apiKey,
    getBaseUrl: () => args.endpoint.baseUrl,
    getSessionDir: () => directOpenAiSessionDir(args.endpoint.id),
    getSessionFilePath: (sessionId) => directOpenAiSessionFilePath(args.endpoint.id, sessionId),
    buildHeaders: (apiKey) => ({
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      'Content-Type': 'application/json',
      ...(args.endpoint.headers ?? {}),
    }),
  };
}

export function buildDirectOpenAiResponsesConfig(args: {
  providerId: string;
  providerLabel: string;
  endpoint: StoredApiProviderEndpoint;
}): OpenAiCompatibleResponsesProviderConfig {
  return {
    providerId: args.providerId,
    providerLabel: args.providerLabel,
    defaultModel: args.endpoint.defaultModel,
    fallbackModels: args.endpoint.models,
    getApiKey: () => args.endpoint.apiKey,
    getBaseUrl: () => args.endpoint.baseUrl,
    getSessionDir: () => directOpenAiResponsesSessionDir(args.endpoint.id),
    getSessionFilePath: (sessionId) => directOpenAiResponsesSessionFilePath(args.endpoint.id, sessionId),
    buildHeaders: (apiKey) => ({
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      'Content-Type': 'application/json',
      ...(args.endpoint.headers ?? {}),
    }),
  };
}

export function buildDirectAnthropicConfig(args: {
  providerId: string;
  providerLabel: string;
  endpoint: StoredApiProviderEndpoint;
}): AnthropicCompatibleChatProviderConfig {
  return {
    providerId: args.providerId,
    providerLabel: args.providerLabel,
    defaultModel: args.endpoint.defaultModel,
    fallbackModels: args.endpoint.models,
    getApiKey: () => args.endpoint.apiKey,
    getBaseUrl: () => args.endpoint.baseUrl,
    getSessionDir: () => directAnthropicSessionDir(args.endpoint.id),
    getSessionFilePath: (sessionId) => directAnthropicSessionFilePath(args.endpoint.id, sessionId),
  };
}
