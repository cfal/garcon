import type { ApiProtocol } from '@garcon/common/api-providers';
import crypto from 'node:crypto';
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
import type { DirectSessionStore } from './session-store.js';

export interface DirectCompatibleRuntime {
  startSession(request: DirectStartRequest): Promise<DirectStartedSession>;
  runTurn(request: DirectResumeRequest): Promise<void>;
  abort(agentSessionId: string): boolean;
  isRunning(agentSessionId: string): boolean;
  forgetSession(agentSessionId: string): void;
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
  readonly #sessionRuntimeKeys = new Map<string, string>();
  #purgeTimersStarted = false;

  constructor(private readonly config: DirectEndpointRouterConfig<TRuntime>) {}

  async startSession(request: DirectStartRequest): Promise<DirectStartedSession> {
    const runtime = this.#runtimeFor(request.endpoint);
    const started = await runtime.startSession(request);
    this.#sessionRuntimeKeys.set(
      started.agentSessionId,
      directEndpointFingerprint(request.endpoint),
    );
    return started;
  }

  async runTurn(request: DirectResumeRequest): Promise<void> {
    const runtimeKey = directEndpointFingerprint(request.endpoint);
    const previousRuntimeKey = this.#sessionRuntimeKeys.get(request.agentSessionId);
    if (previousRuntimeKey && previousRuntimeKey !== runtimeKey) {
      this.#runtimes.get(previousRuntimeKey)?.forgetSession(request.agentSessionId);
    }
    const runtime = this.#runtimeFor(request.endpoint);
    this.#sessionRuntimeKeys.set(
      request.agentSessionId,
      runtimeKey,
    );
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
    this.#sessionRuntimeKeys.clear();
  }

  #runtimeForSession(agentSessionId: string): TRuntime | null {
    const runtimeKey = this.#sessionRuntimeKeys.get(agentSessionId);
    if (runtimeKey) {
      const runtime = this.#runtimes.get(runtimeKey);
      if (runtime) return runtime;
    }
    for (const runtime of this.#runtimes.values()) {
      if (runtime.isRunning(agentSessionId)) return runtime;
    }
    return null;
  }

  #runtimeFor(endpoint: DirectEndpointRuntime): TRuntime {
    this.#validateEndpoint(endpoint);
    const runtimeKey = directEndpointFingerprint(endpoint);
    const existing = this.#runtimes.get(runtimeKey);
    if (existing) return existing;
    const runtime = this.config.createRuntime(endpoint);
    this.#runtimes.set(runtimeKey, runtime);
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
  readonly runtimeLabel: string;
  readonly sessions: DirectSessionStore;
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

export function buildDirectOpenAiConfig(args: DirectRuntimeFamilyOptions & {
  readonly endpoint: DirectEndpointRuntime;
}): OpenAiCompatibleChatRuntimeConfig {
  return {
    runtimeLabel: args.runtimeLabel,
    defaultModel: args.endpoint.selection.model,
    sessions: args.sessions,
    getApiKey: () => args.endpoint.credential ?? '',
    getBaseUrl: () => args.endpoint.selection.baseUrl,
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
    runtimeLabel: args.runtimeLabel,
    defaultModel: args.endpoint.selection.model,
    sessions: args.sessions,
    getApiKey: () => args.endpoint.credential ?? '',
    getBaseUrl: () => args.endpoint.selection.baseUrl,
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
    runtimeLabel: args.runtimeLabel,
    defaultModel: args.endpoint.selection.model,
    sessions: args.sessions,
    getApiKey: () => args.endpoint.credential ?? '',
    getBaseUrl: () => args.endpoint.selection.baseUrl,
  };
}

export function directEndpointFingerprint(endpoint: DirectEndpointRuntime): string {
  const headers = Object.entries(endpoint.selection.headers ?? {})
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const route = {
    endpointId: endpoint.selection.endpointId,
    protocol: endpoint.selection.protocol,
    baseUrl: endpoint.selection.baseUrl.replace(/\/+$/, ''),
    headersDigest: digest(JSON.stringify(headers)),
    credentialDigest: digest(endpoint.credential ?? ''),
  };
  return digest(JSON.stringify(route));
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}
