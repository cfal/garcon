// Builds provider adapter instances from existing provider implementations.
// Wraps each concrete provider in the ProviderAdapter interface so the
// registry can operate without per-provider branching.

import crypto from 'crypto';
import { createClaudeNativePath, runSingleQuery as runSingleQueryClaude } from './claude-cli.js';
import { runSingleQuery as runSingleQueryCodex } from './codex-app-server/run-single-query.js';
import { runSingleQuery as runSingleQueryAmp } from './amp-cli.js';
import { runSingleQuery as runSingleQueryCursor } from './cursor-cli.js';
import { runSingleQuery as runSingleQueryFactory } from './factory-cli.js';
import { runSingleQuery as runSingleQueryPi } from './pi-cli.js';
import type { ProviderAdapter } from './provider-adapter.js';
import type { ClaudeStartSessionRequest, ResumeTurnRequest, StartSessionRequest, StartedProviderSession } from './types.js';
import { OpenAiCompatibleChatProvider, type OpenAiCompatibleChatProviderConfig, runOpenAiCompatibleSingleQuery } from './openai-compatible-chat-provider.js';
import {
  OpenAiCompatibleResponsesProvider,
  type OpenAiCompatibleResponsesProviderConfig,
  runOpenAiResponsesSingleQuery,
} from './openai-compatible-responses-provider.js';
import { AnthropicCompatibleChatProvider, type AnthropicCompatibleChatProviderConfig, runAnthropicCompatibleSingleQuery } from './anthropic-compatible-chat-provider.js';
import type { ApiProviderStore, StoredApiProvider, StoredApiProviderEndpoint } from './api-provider-store.js';
import { getWorkspaceDir } from '../config.js';
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
} from '../../common/providers.js';

// Claude adapter wrapping the ClaudeProvider interface.

export function createClaudeAdapter(claude: ClaudeProviderInstance): ProviderAdapter {
  return {
    id: 'claude',
    label: 'Claude',
    async startSession(request: StartSessionRequest): Promise<StartedProviderSession> {
      const providerSessionId = crypto.randomUUID();
      const nativePath = await createClaudeNativePath(request.projectPath, providerSessionId);
      const claudeRequest: ClaudeStartSessionRequest = { ...request, providerSessionId };
      claude.startClaudeCliSession(claudeRequest).catch((error: Error) => {
        console.error(`providers: claude start failed for chat ${request.chatId}:`, error.message);
      });
      return { providerSessionId, nativePath };
    },
    async runTurn(request: ResumeTurnRequest): Promise<void> {
      await claude.runClaudeTurn(request);
    },
    abort(id: string): boolean {
      return claude.abortClaudeInternalSession(id);
    },
    isRunning(id: string): boolean {
      return claude.isClaudeInternalSessionRunning(id);
    },
    getRunningSessions() {
      return claude.getRunningClaudeInternalSessions();
    },
    runSingleQuery: runSingleQueryClaude,
    resolvePermission(permissionRequestId, decision) {
      claude.resolveInternalToolApproval(permissionRequestId, decision);
    },
    startPurgeTimer() {
      return claude.startPurgeTimer();
    },
    onMessages(cb) { claude.onMessages(cb); },
    onProcessing(cb) { claude.onProcessing(cb); },
    onSessionCreated(cb) { claude.onSessionCreated(cb); },
    onFinished(cb) { claude.onFinished(cb); },
    onFailed(cb) { claude.onFailed(cb); },
  };
}

// Codex adapter

export function createCodexAdapter(codex: CodexProviderInstance): ProviderAdapter {
  return {
    id: 'codex',
    label: 'Codex',
    async startSession(request: StartSessionRequest): Promise<StartedProviderSession> {
      return codex.startSession(request);
    },
    async runTurn(request: ResumeTurnRequest): Promise<void> {
      await codex.runTurn(request);
    },
    abort(id: string): boolean {
      return codex.abort(id);
    },
    isRunning(id: string): boolean {
      return codex.isRunning(id);
    },
    getRunningSessions() {
      return codex.getRunningSessions();
    },
    runSingleQuery: runSingleQueryCodex,
    loadMessages: codex.loadMessages ? (session) => codex.loadMessages!(session) : undefined,
    getPreview: codex.getPreview ? (session) => codex.getPreview!(session) : undefined,
    forkSession: codex.forkSession ? (request) => codex.forkSession!(request) : undefined,
    resolvePermission: codex.resolvePermission ? (permissionRequestId, decision) => codex.resolvePermission!(permissionRequestId, decision) : undefined,
    startPurgeTimer() {
      return codex.startPurgeTimer();
    },
    shutdown() {
      codex.shutdown?.();
    },
    onMessages(cb) { codex.onMessages(cb); },
    onProcessing(cb) { codex.onProcessing(cb); },
    onSessionCreated(cb) { codex.onSessionCreated(cb); },
    onFinished(cb) { codex.onFinished(cb); },
    onFailed(cb) { codex.onFailed(cb); },
  };
}

// OpenCode adapter

export function createOpenCodeAdapter(opencode: OpenCodeProviderInstance): ProviderAdapter {
  return {
    id: 'opencode',
    label: 'OpenCode',
    async startSession(request: StartSessionRequest): Promise<StartedProviderSession> {
      const providerSessionId = await opencode.startSession(request);
      const nativePath = `opencode:${providerSessionId}`;
      return { providerSessionId, nativePath };
    },
    async runTurn(request: ResumeTurnRequest): Promise<void> {
      await opencode.runTurn(request);
    },
    abort(id: string): boolean {
      return opencode.abort(id);
    },
    isRunning(id: string): boolean {
      return opencode.isRunning(id);
    },
    getRunningSessions() {
      return opencode.getRunningSessions();
    },
    async getModels() {
      return opencode.getModels();
    },
    runSingleQuery: opencode.runSingleQuery.bind(opencode),
    startPurgeTimer() {
      return opencode.startPurgeTimer();
    },
    shutdown() {
      opencode.shutdown?.();
    },
    onMessages(cb) { opencode.onMessages(cb); },
    onProcessing(cb) { opencode.onProcessing(cb); },
    onSessionCreated(cb) { opencode.onSessionCreated(cb); },
    onFinished(cb) { opencode.onFinished(cb); },
    onFailed(cb) { opencode.onFailed(cb); },
  };
}

// Amp adapter

export function createAmpAdapter(amp: ExternalCliProviderInstance): ProviderAdapter {
  return {
    id: 'amp',
    label: 'Amp',
    async startSession(request: StartSessionRequest): Promise<StartedProviderSession> {
      return amp.startSession(request);
    },
    async runTurn(request: ResumeTurnRequest): Promise<void> {
      await amp.runTurn(request);
    },
    abort(id: string): boolean {
      return amp.abort(id);
    },
    isRunning(id: string): boolean {
      return amp.isRunning(id);
    },
    getRunningSessions() {
      return amp.getRunningSessions();
    },
    runSingleQuery: runSingleQueryAmp,
    startPurgeTimer() {
      return amp.startPurgeTimer();
    },
    onMessages(cb) { amp.onMessages(cb); },
    onProcessing(cb) { amp.onProcessing(cb); },
    onSessionCreated(cb) { amp.onSessionCreated(cb); },
    onFinished(cb) { amp.onFinished(cb); },
    onFailed(cb) { amp.onFailed(cb); },
  };
}

// Cursor adapter

export function createCursorAdapter(cursor: ExternalCliProviderInstance): ProviderAdapter {
  return {
    id: 'cursor',
    label: 'Cursor',
    async startSession(request: StartSessionRequest): Promise<StartedProviderSession> {
      return cursor.startSession(request);
    },
    async runTurn(request: ResumeTurnRequest): Promise<void> {
      await cursor.runTurn(request);
    },
    abort(id: string): boolean {
      return cursor.abort(id);
    },
    isRunning(id: string): boolean {
      return cursor.isRunning(id);
    },
    getRunningSessions() {
      return cursor.getRunningSessions();
    },
    async getModels() {
      return cursor.getModels?.() ?? [];
    },
    runSingleQuery: runSingleQueryCursor,
    startPurgeTimer() {
      return cursor.startPurgeTimer();
    },
    onMessages(cb) { cursor.onMessages(cb); },
    onProcessing(cb) { cursor.onProcessing(cb); },
    onSessionCreated(cb) { cursor.onSessionCreated(cb); },
    onFinished(cb) { cursor.onFinished(cb); },
    onFailed(cb) { cursor.onFailed(cb); },
  };
}

// Factory adapter

export function createFactoryAdapter(factory: ExternalCliProviderInstance): ProviderAdapter {
  return {
    id: 'factory',
    label: 'Factory',
    async startSession(request: StartSessionRequest): Promise<StartedProviderSession> {
      return factory.startSession(request);
    },
    async runTurn(request: ResumeTurnRequest): Promise<void> {
      await factory.runTurn(request);
    },
    abort(id: string): boolean {
      return factory.abort(id);
    },
    isRunning(id: string): boolean {
      return factory.isRunning(id);
    },
    getRunningSessions() {
      return factory.getRunningSessions();
    },
    async getModels() {
      return factory.getModels?.() ?? [];
    },
    runSingleQuery: runSingleQueryFactory,
    startPurgeTimer() {
      return factory.startPurgeTimer();
    },
    onMessages(cb) { factory.onMessages(cb); },
    onProcessing(cb) { factory.onProcessing(cb); },
    onSessionCreated(cb) { factory.onSessionCreated(cb); },
    onFinished(cb) { factory.onFinished(cb); },
    onFailed(cb) { factory.onFailed(cb); },
  };
}

// Pi adapter

export function createPiAdapter(pi: ExternalCliProviderInstance): ProviderAdapter {
  return {
    id: 'pi',
    label: 'Pi',
    async startSession(request: StartSessionRequest): Promise<StartedProviderSession> {
      return pi.startSession(request);
    },
    async runTurn(request: ResumeTurnRequest): Promise<void> {
      await pi.runTurn(request);
    },
    abort(id: string): boolean {
      return pi.abort(id);
    },
    isRunning(id: string): boolean {
      return pi.isRunning(id);
    },
    getRunningSessions() {
      return pi.getRunningSessions();
    },
    async getModels() {
      return pi.getModels?.() ?? [];
    },
    runSingleQuery: runSingleQueryPi,
    startPurgeTimer() {
      return pi.startPurgeTimer();
    },
    onMessages(cb) { pi.onMessages(cb); },
    onProcessing(cb) { pi.onProcessing(cb); },
    onSessionCreated(cb) { pi.onSessionCreated(cb); },
    onFinished(cb) { pi.onFinished(cb); },
    onFailed(cb) { pi.onFailed(cb); },
  };
}

// Direct compatible harness adapters for endpoint-backed API providers.

type DirectEventCallbacks = {
  messages: Set<(chatId: string, messages: unknown[]) => void>;
  processing: Set<(chatId: string, isProcessing: boolean) => void>;
  sessionCreated: Set<(chatId: string) => void>;
  finished: Set<(chatId: string, exitCode: number) => void>;
  failed: Set<(chatId: string, errorMessage: string) => void>;
};

type DirectCompatibleProvider = {
  startSession(request: StartSessionRequest): Promise<StartedProviderSession>;
  runTurn(request: ResumeTurnRequest): Promise<void>;
  abort(providerSessionId: string): boolean;
  isRunning(providerSessionId: string): boolean;
  getRunningSessions(): Array<{ id: string; status?: string; startedAt?: string }>;
  getModels?(): Promise<Array<{ value: string; label: string; supportsImages?: boolean }>>;
  startPurgeTimer(): ReturnType<typeof setInterval>;
  onMessages(cb: (chatId: string, messages: unknown[]) => void): void;
  onProcessing(cb: (chatId: string, isProcessing: boolean) => void): void;
  onSessionCreated(cb: (chatId: string) => void): void;
  onFinished(cb: (chatId: string, exitCode: number) => void): void;
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

class DirectEndpointRouterAdapter<TProvider extends DirectCompatibleProvider> implements ProviderAdapter {
  readonly id: string;
  readonly label: string;

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

  constructor(private readonly config: DirectEndpointRouterConfig<TProvider>) {
    this.id = config.harnessId;
    this.label = config.label;
  }

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
      throw new Error(`Unknown ${this.label} session: ${request.providerSessionId}`);
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

  onMessages(cb: (chatId: string, messages: unknown[]) => void): void {
    this.#callbacks.messages.add(cb);
  }

  onProcessing(cb: (chatId: string, isProcessing: boolean) => void): void {
    this.#callbacks.processing.add(cb);
  }

  onSessionCreated(cb: (chatId: string) => void): void {
    this.#callbacks.sessionCreated.add(cb);
  }

  onFinished(cb: (chatId: string, exitCode: number) => void): void {
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
    provider.onMessages((chatId, messages) => {
      for (const cb of this.#callbacks.messages) cb(chatId, messages);
    });
    provider.onProcessing((chatId, isProcessing) => {
      for (const cb of this.#callbacks.processing) cb(chatId, isProcessing);
    });
    provider.onSessionCreated((chatId) => {
      for (const cb of this.#callbacks.sessionCreated) cb(chatId);
    });
    provider.onFinished((chatId, exitCode) => {
      for (const cb of this.#callbacks.finished) cb(chatId, exitCode);
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

export function createDirectOpenAiCompatibleRouterAdapter(apiProviderStore: ApiProviderStore): ProviderAdapter {
  return new DirectEndpointRouterAdapter({
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

export function createDirectOpenAiResponsesCompatibleRouterAdapter(apiProviderStore: ApiProviderStore): ProviderAdapter {
  return new DirectEndpointRouterAdapter({
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

export function createDirectAnthropicCompatibleRouterAdapter(apiProviderStore: ApiProviderStore): ProviderAdapter {
  return new DirectEndpointRouterAdapter({
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

// Provider instance interfaces matching the existing concrete types.

export interface ClaudeProviderInstance {
  startClaudeCliSession(request: ClaudeStartSessionRequest): Promise<string>;
  runClaudeTurn(request: ResumeTurnRequest): Promise<void>;
  isClaudeInternalSessionRunning(providerSessionId: string): boolean;
  abortClaudeInternalSession(providerSessionId: string): boolean;
  getRunningClaudeInternalSessions(): Array<{ id: string; status: string; startedAt: string }>;
  resolveInternalToolApproval(permissionRequestId: string, decision: { allow: boolean; alwaysAllow?: boolean }): void;
  setInternalPermissionMode(providerSessionId: string, mode: import('../../common/chat-modes.js').PermissionMode): void;
  setInternalThinkingMode(providerSessionId: string, mode: import('../../common/chat-modes.js').ThinkingMode): void;
  setInternalClaudeThinkingMode(providerSessionId: string, mode: import('../../common/chat-modes.js').ClaudeThinkingMode): void;
  startPurgeTimer(): ReturnType<typeof setInterval>;
  onMessages(cb: (chatId: string, messages: unknown[]) => void): void;
  onProcessing(cb: (chatId: string, isProcessing: boolean) => void): void;
  onSessionCreated(cb: (chatId: string) => void): void;
  onFinished(cb: (chatId: string, exitCode: number) => void): void;
  onFailed(cb: (chatId: string, errorMessage: string) => void): void;
}

export interface CodexProviderInstance {
  startSession(request: StartSessionRequest): Promise<StartedProviderSession>;
  runTurn(request: ResumeTurnRequest): Promise<void>;
  isRunning(providerSessionId: string): boolean;
  abort(providerSessionId: string): boolean;
  getRunningSessions(): Array<{ id: string; status: string; startedAt: string }>;
  loadMessages?(session: unknown): Promise<unknown[]>;
  getPreview?(session: unknown): Promise<unknown>;
  forkSession?(request: {
    sourceSession: unknown;
    sourceChatId: string;
    targetChatId: string;
    envOverrides?: StartSessionRequest['envOverrides'];
    codexConfig?: StartSessionRequest['codexConfig'];
  }): Promise<StartedProviderSession | null>;
  resolvePermission?(permissionRequestId: string, decision: { allow: boolean; alwaysAllow?: boolean }): Promise<void>;
  startPurgeTimer(): ReturnType<typeof setInterval>;
  shutdown?(): void;
  onMessages(cb: (chatId: string, messages: unknown[]) => void): void;
  onProcessing(cb: (chatId: string, isProcessing: boolean) => void): void;
  onSessionCreated(cb: (chatId: string) => void): void;
  onFinished(cb: (chatId: string, exitCode: number) => void): void;
  onFailed(cb: (chatId: string, errorMessage: string) => void): void;
}

export interface OpenCodeProviderInstance {
  isAvailable(): boolean;
  startSession(request: StartSessionRequest): Promise<string>;
  runTurn(request: ResumeTurnRequest): Promise<void>;
  isRunning(providerSessionId: string): boolean;
  abort(providerSessionId: string): boolean;
  getRunningSessions(): Array<{ id: string; status: string; startedAt: string }>;
  getClient(): Promise<unknown>;
  getModels(): Promise<Array<{ value: string; label: string; supportsImages?: boolean }>>;
  runSingleQuery(prompt: string, options?: Record<string, unknown>): Promise<string>;
  resolvePermission(permissionRequestId: string, decision: { allow: boolean; alwaysAllow?: boolean }): Promise<void>;
  evictChat(chatId: string): void;
  shutdown?(): void;
  startPurgeTimer(): ReturnType<typeof setInterval>;
  onMessages(cb: (chatId: string, messages: unknown[]) => void): void;
  onProcessing(cb: (chatId: string, isProcessing: boolean) => void): void;
  onSessionCreated(cb: (chatId: string) => void): void;
  onFinished(cb: (chatId: string, exitCode: number) => void): void;
  onFailed(cb: (chatId: string, errorMessage: string) => void): void;
}

export interface ExternalCliProviderInstance {
  startSession(request: StartSessionRequest): Promise<StartedProviderSession>;
  runTurn(request: ResumeTurnRequest): Promise<void>;
  isRunning(providerSessionId: string): boolean;
  abort(providerSessionId: string): boolean;
  getRunningSessions(): Array<{ id: string; status: string; startedAt: string }>;
  getModels?(): Promise<Array<{ value: string; label: string; supportsImages?: boolean }>>;
  startPurgeTimer(): ReturnType<typeof setInterval>;
  onMessages(cb: (chatId: string, messages: unknown[]) => void): void;
  onProcessing(cb: (chatId: string, isProcessing: boolean) => void): void;
  onSessionCreated(cb: (chatId: string) => void): void;
  onFinished(cb: (chatId: string, exitCode: number) => void): void;
  onFailed(cb: (chatId: string, errorMessage: string) => void): void;
}
