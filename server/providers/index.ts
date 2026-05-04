// Unified harness registry. Routes all operations through adapter instances
// keyed by harness ID. Also provides preview/message loading, harness auth,
// readiness, and API provider mutations.

import { getClaudeAuthStatus } from './claude-auth.js';
import { getCodexAuthStatus } from './codex-auth.js';
import { getOpenCodeAuthStatus } from './opencode-auth.js';
import { getAmpAuthStatus } from './amp-auth.js';
import { getFactoryAuthStatus } from './factory-auth.js';
import { getArtificialProviderSessionId } from '../chats/artificial-native-path.js';
import { getMaxSessions } from '../config.js';
import type { IChatRegistry } from '../chats/store.js';

import { getClaudePreviewFromNativePath, loadClaudeChatMessages } from './loaders/claude-history-loader.js';
import { getCodexPreviewFromNativePath, loadCodexChatMessages } from './loaders/codex-history-loader.js';
import { getOpenCodePreviewFromSessionId, loadOpenCodeChatMessages } from './loaders/opencode-history-loader.js';
import { getFactoryPreviewFromSessionId, loadFactoryChatMessagesBySessionId } from './loaders/factory-history-loader.js';
import { getOpenAiCompatiblePreviewFromSessionId, loadOpenAiCompatibleChatMessages } from './loaders/openai-compatible-history-loader.js';

import type { AgentCommandImage } from '../../common/ws-requests.js';
import type { AmpAgentMode, ClaudeThinkingMode, PermissionMode, ThinkingMode } from '../../common/chat-modes.js';
import type { ChatMessage } from '../../common/chat-types.js';
import { AMP_MODELS, CLAUDE_MODELS, CODEX_MODELS, FACTORY_MODELS } from '../../common/models.js';
import { apiProviderTemplate } from '../../common/api-provider-templates.js';
import type {
  ProviderChatEntry,
  StartSessionRequest,
  StartedProviderSession,
  RunProviderTurnOptions,
} from './types.js';
import { requireChatExecutionConfig } from './types.js';
import type { ProviderAdapter } from './provider-adapter.js';
import type { ApiProviderStore, CreateApiProviderInput, UpdateApiProviderInput } from './api-provider-store.js';
import type { ApiProviderEndpointResolver, ResolvedModelSelection } from './api-provider-endpoint-resolver.js';
import { assertSameApiProviderBoundary } from './api-provider-endpoint-resolver.js';
import { directOpenAiSessionFilePath } from './provider-adapters.js';
import {
  BUILTIN_HARNESS_CAPABILITIES,
  harnessesForProtocol,
  isVisibleHarnessId,
  labelForProtocol,
  type ApiProviderCatalogEntry,
  type ApiProviderModelDiscoveryRequest,
  type ApiProviderModelDiscoveryResponse,
  type ApiProviderTemplateId,
  type ApiProtocol,
  type HarnessCatalog,
  type HarnessCatalogEntry,
  type HarnessModelOption,
  type ModelDiscoveryKind,
} from '../../common/providers.js';

const AUTH_DISPATCHERS: Record<string, (opencode: any) => Promise<unknown>> = {
  claude: () => getClaudeAuthStatus(),
  codex: () => getCodexAuthStatus(),
  opencode: (oc) => getOpenCodeAuthStatus(oc),
  amp: () => getAmpAuthStatus(),
  factory: () => getFactoryAuthStatus(),
};

const DIRECT_SESSION_ID_RE = /^[a-z0-9-]{8,64}$/i;
const STATIC_HARNESS_MODELS: Record<string, { defaultModel: string; models: HarnessModelOption[] }> = {
  claude: { defaultModel: CLAUDE_MODELS.DEFAULT, models: CLAUDE_MODELS.OPTIONS },
  codex: { defaultModel: CODEX_MODELS.DEFAULT, models: CODEX_MODELS.OPTIONS },
  amp: { defaultModel: AMP_MODELS.DEFAULT, models: AMP_MODELS.OPTIONS },
  factory: { defaultModel: FACTORY_MODELS.DEFAULT, models: FACTORY_MODELS.OPTIONS },
};
const DIRECT_OPENAI_COMPATIBLE_HARNESS_ID = 'direct-openai-compatible';

function requireChatEntry(chatId: string, entry: ProviderChatEntry | null | undefined): ProviderChatEntry & {
  projectPath: string;
  model: string;
  permissionMode: PermissionMode;
  thinkingMode: ThinkingMode;
  claudeThinkingMode: ClaudeThinkingMode;
  ampAgentMode: AmpAgentMode;
} {
  const execution = requireChatExecutionConfig(chatId, entry);
  if (!entry) {
    throw new Error(`Session not initialized: ${chatId}`);
  }
  return {
    ...entry,
    ...execution,
  };
}

function redactApiProviderForCatalog(apiProvider: any): ApiProviderCatalogEntry {
  const { endpoints, ...rest } = apiProvider;
  return {
    ...rest,
    endpoints: endpoints.map((ep: any) => {
      const { apiKey: _, headers: _headers, ...epRest } = ep;
      return { ...epRest, hasApiKey: Boolean(ep.apiKey), apiKeyLabel: ep.apiKeyLabel ?? '' };
    }),
  };
}

function dedupeModels(models: HarnessModelOption[]): HarnessModelOption[] {
  const seen = new Set<string>();
  const result: HarnessModelOption[] = [];
  for (const model of models) {
    if (!model.value || seen.has(model.value)) continue;
    seen.add(model.value);
    result.push(model);
  }
  return result;
}

async function nativeModelsForHarness(id: string, adapter: ProviderAdapter): Promise<HarnessModelOption[]> {
  let fetched: HarnessModelOption[] = [];
  if (id !== DIRECT_OPENAI_COMPATIBLE_HARNESS_ID && adapter.getModels) {
    try {
      fetched = await adapter.getModels();
    } catch (error) {
      console.warn(`providers: failed to fetch ${id} models:`, error instanceof Error ? error.message : String(error));
    }
  }
  const fallback = STATIC_HARNESS_MODELS[id]?.models ?? [];
  return dedupeModels([...fetched, ...fallback]);
}

function defaultModelForHarness(id: string, nativeModels: HarnessModelOption[], endpointModels: HarnessModelOption[]): string {
  const fallbackDefault = STATIC_HARNESS_MODELS[id]?.defaultModel;
  if (fallbackDefault && nativeModels.some((model) => model.value === fallbackDefault)) {
    return fallbackDefault;
  }
  return nativeModels[0]?.value ?? endpointModels[0]?.value ?? fallbackDefault ?? '';
}

export interface ApiProviderInput {
  templateId: ApiProviderTemplateId;
  label: string;
  endpoint: {
    protocol: ApiProtocol;
    baseUrl: string;
    apiKey?: string;
    clearApiKey?: boolean;
    exposeTo: string[];
    defaultModel: string;
    models: Array<{ value: string; label: string; supportsImages?: boolean; isLocal?: boolean }>;
    supportsImages: boolean;
    modelDiscovery?: ModelDiscoveryKind;
  };
}

interface ApiProviderModelDiscoveryFlatInput {
  protocol: ApiProtocol;
  baseUrl: string;
  apiKey?: string;
  apiProviderId?: string | null;
  endpointId?: string | null;
  modelDiscovery: ModelDiscoveryKind;
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalObject(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  return requireObject(value, field);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, field);
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
  return value;
}

function normalizeTemplateId(value: unknown): ApiProviderTemplateId {
  if (value === 'openrouter' || value === 'zai' || value === 'ollama' || value === 'custom') return value;
  throw new Error('templateId must be openrouter, zai, ollama, or custom');
}

function normalizeApiProviderBaseUrl(value: unknown): string {
  const trimmed = requireString(value, 'endpoint.baseUrl');
  const normalized = trimmed.startsWith('http://') || trimmed.startsWith('https://')
    ? trimmed
    : `https://${trimmed}`;
  const parsed = new URL(normalized);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('endpoint.baseUrl must use http or https');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('endpoint.baseUrl must not include query or fragment components');
  }
  return normalized.replace(/\/+$/, '');
}

function normalizeOptionalLookupId(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a string`);
  }
  return value.trim();
}

function normalizeProtocol(value: unknown): ApiProtocol {
  if (value === 'anthropic-messages' || value === 'openai-chat-completions') return value;
  throw new Error('endpoint.protocol must be anthropic-messages or openai-chat-completions');
}

function normalizeApiProviderTargets(protocol: ApiProtocol, value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error('endpoint.exposeTo must be an array');
  }
  const allowed = new Set(harnessesForProtocol(protocol));
  const invalid = value.filter((target) => typeof target !== 'string' || !allowed.has(target as any));
  if (invalid.length > 0) {
    throw new Error(`endpoint.exposeTo must only include ${labelForProtocol(protocol)} harnesses`);
  }
  const targets = [...new Set(value)] as string[];
  if (targets.length === 0) {
    throw new Error(`endpoint.exposeTo must include at least one ${labelForProtocol(protocol)} harness`);
  }
  return targets;
}

function normalizeApiProviderModels(value: unknown, defaultModel: string): HarnessModelOption[] {
  if (!Array.isArray(value)) {
    return [{ value: defaultModel, label: defaultModel }];
  }
  const models: HarnessModelOption[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const model = entry as Record<string, unknown>;
    const modelValue = typeof model.value === 'string' ? model.value.trim() : '';
    const label = typeof model.label === 'string' ? model.label.trim() : '';
    if (!modelValue || !label) continue;
    const normalized: HarnessModelOption = { value: modelValue, label };
    if (typeof model.supportsImages === 'boolean') normalized.supportsImages = model.supportsImages;
    if (typeof model.isLocal === 'boolean') normalized.isLocal = model.isLocal;
    models.push(normalized);
  }
  if (models.length > 0) return models;
  return defaultModel ? [{ value: defaultModel, label: defaultModel }] : [];
}

function flattenApiProviderInput(input: ApiProviderInput): CreateApiProviderInput {
  const root = requireObject(input, 'API provider');
  const endpoint = requireObject(root.endpoint, 'endpoint');
  const protocol = normalizeProtocol(endpoint.protocol);
  const templateId = normalizeTemplateId(root.templateId);
  if (!apiProviderTemplate(protocol, templateId)) {
    throw new Error(`Unsupported template for ${labelForProtocol(protocol)} providers: ${templateId}`);
  }
  const defaultModel = requireString(endpoint.defaultModel, 'endpoint.defaultModel');
  return {
    templateId,
    label: requireString(root.label, 'label'),
    protocol,
    baseUrl: normalizeApiProviderBaseUrl(endpoint.baseUrl),
    apiKey: typeof endpoint.apiKey === 'string' ? endpoint.apiKey : undefined,
    exposeTo: normalizeApiProviderTargets(protocol, endpoint.exposeTo) as any[],
    defaultModel,
    models: normalizeApiProviderModels(endpoint.models, defaultModel),
    supportsImages: optionalBoolean(endpoint.supportsImages, 'endpoint.supportsImages') ?? false,
    modelDiscovery: normalizeModelDiscovery(protocol, endpoint.modelDiscovery),
  };
}

function flattenApiProviderPatch(input: Partial<ApiProviderInput>): UpdateApiProviderInput {
  const root = requireObject(input, 'API provider');
  const result: UpdateApiProviderInput = {};
  const label = optionalString(root.label, 'label');
  if (label !== undefined) result.label = label;
  const inputEndpoint = optionalObject(root.endpoint, 'endpoint');
  if (inputEndpoint) {
    const protocol = inputEndpoint.protocol === undefined ? undefined : normalizeProtocol(inputEndpoint.protocol);
    const endpoint: UpdateApiProviderInput['endpoint'] = {};
    if (inputEndpoint.baseUrl !== undefined) endpoint.baseUrl = normalizeApiProviderBaseUrl(inputEndpoint.baseUrl);
    if (inputEndpoint.apiKey !== undefined) {
      if (typeof inputEndpoint.apiKey !== 'string') throw new Error('endpoint.apiKey must be a string');
      endpoint.apiKey = inputEndpoint.apiKey;
    }
    const clearApiKey = optionalBoolean(inputEndpoint.clearApiKey, 'endpoint.clearApiKey');
    if (clearApiKey !== undefined) endpoint.clearApiKey = clearApiKey;
    if (inputEndpoint.exposeTo !== undefined) {
      if (!protocol) throw new Error('endpoint.protocol is required when endpoint.exposeTo is patched');
      endpoint.exposeTo = normalizeApiProviderTargets(protocol, inputEndpoint.exposeTo) as any[];
    }
    if (inputEndpoint.defaultModel !== undefined) endpoint.defaultModel = requireString(inputEndpoint.defaultModel, 'endpoint.defaultModel');
    if (inputEndpoint.models !== undefined) {
      const defaultModel = endpoint.defaultModel
        ?? (typeof inputEndpoint.defaultModel === 'string' ? inputEndpoint.defaultModel : '');
      endpoint.models = normalizeApiProviderModels(inputEndpoint.models, defaultModel);
    }
    const supportsImages = optionalBoolean(inputEndpoint.supportsImages, 'endpoint.supportsImages');
    if (supportsImages !== undefined) endpoint.supportsImages = supportsImages;
    if (inputEndpoint.modelDiscovery !== undefined) {
      if (!protocol) throw new Error('endpoint.protocol is required when endpoint.modelDiscovery is patched');
      endpoint.modelDiscovery = normalizeModelDiscovery(protocol, inputEndpoint.modelDiscovery);
    }
    if (Object.keys(endpoint).length > 0) result.endpoint = endpoint;
  }
  return result;
}

function normalizeModelDiscovery(protocol: ApiProtocol, value: unknown): ModelDiscoveryKind {
  if (value === 'none') return 'none';
  if (value === 'ollama-tags') return 'ollama-tags';
  if (value === 'openrouter-models') return 'openrouter-models';
  if (value === 'anthropic-models') return 'anthropic-models';
  if (protocol === 'openai-chat-completions') return 'openai-models';
  return 'none';
}

function defaultModelDiscoveryForProtocol(protocol: ApiProtocol): ModelDiscoveryKind {
  return protocol === 'anthropic-messages' ? 'anthropic-models' : 'openai-models';
}

function normalizeModelDiscoveryForFetch(protocol: ApiProtocol, value: unknown): ModelDiscoveryKind {
  const normalized = normalizeModelDiscovery(protocol, value);
  return normalized === 'none' ? defaultModelDiscoveryForProtocol(protocol) : normalized;
}

function flattenApiProviderModelDiscoveryInput(input: ApiProviderModelDiscoveryRequest): ApiProviderModelDiscoveryFlatInput {
  const root = requireObject(input, 'API provider model discovery');
  const protocol = normalizeProtocol(root.protocol);
  return {
    protocol,
    baseUrl: normalizeApiProviderBaseUrl(root.baseUrl),
    apiKey: typeof root.apiKey === 'string' && root.apiKey.length > 0 ? root.apiKey : undefined,
    apiProviderId: normalizeOptionalLookupId(root.apiProviderId, 'apiProviderId'),
    endpointId: normalizeOptionalLookupId(root.endpointId, 'endpointId'),
    modelDiscovery: normalizeModelDiscoveryForFetch(protocol, root.modelDiscovery),
  };
}

function bearerHeaders(apiKey: string | undefined): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function anthropicHeaders(apiKey: string | undefined): Record<string, string> {
  return {
    ...(apiKey ? { 'x-api-key': apiKey } : {}),
    'anthropic-version': '2023-06-01',
  };
}

function appendPath(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`;
}

function openAiModelListUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  const parsed = new URL(normalized);
  const path = parsed.pathname.replace(/\/+$/, '');
  if (!path || path === '/') {
    return appendPath(normalized, '/v1/models');
  }
  return appendPath(normalized, '/models');
}

function anthropicModelListUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  return normalized.endsWith('/v1')
    ? appendPath(normalized, '/models')
    : appendPath(normalized, '/v1/models');
}

function ollamaDiscoveryBase(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  return normalized.endsWith('/v1') ? normalized.slice(0, -3) : normalized;
}

async function testOllamaTags(input: ApiProviderModelDiscoveryFlatInput): Promise<ApiProviderModelDiscoveryResponse> {
  try {
    const response = await fetch(`${ollamaDiscoveryBase(input.baseUrl)}/api/tags`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return { success: false, error: `Ollama model discovery failed with HTTP ${response.status}.` };
    }
    const body = await response.json() as { models?: Array<{ name?: string }> };
    const models: HarnessModelOption[] = (body.models ?? [])
      .filter((model): model is { name: string } => typeof model.name === 'string' && model.name.length > 0)
      .map((model) => ({ value: model.name, label: `${model.name} (local)`, isLocal: true }));
    return { success: true, models: models.length > 0 ? dedupeModels(models) : undefined };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function testOpenAiModels(input: ApiProviderModelDiscoveryFlatInput): Promise<ApiProviderModelDiscoveryResponse> {
  try {
    const url = openAiModelListUrl(input.baseUrl);
    const response = await fetch(url, {
      headers: bearerHeaders(input.apiKey),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { success: false, error: `Model discovery failed with HTTP ${response.status}.` };

    const body = await response.json() as { data?: Array<{ id?: string; name?: string }> };
    const models: HarnessModelOption[] = (body.data ?? [])
      .filter((model): model is { id: string; name?: string } => typeof model.id === 'string' && model.id.length > 0)
      .map((model) => ({ value: model.id, label: model.name || model.id }));
    return { success: true, models: models.length > 0 ? dedupeModels(models) : undefined };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function testAnthropicModels(input: ApiProviderModelDiscoveryFlatInput): Promise<ApiProviderModelDiscoveryResponse> {
  try {
    const models: HarnessModelOption[] = [];
    let afterId: string | null = null;

    for (let page = 0; page < 5; page += 1) {
      const url = new URL(anthropicModelListUrl(input.baseUrl));
      url.searchParams.set('limit', '1000');
      if (afterId) url.searchParams.set('after_id', afterId);

      const response = await fetch(url.toString(), {
        headers: anthropicHeaders(input.apiKey),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return { success: false, error: `Model discovery failed with HTTP ${response.status}.` };

      const body = await response.json() as {
        data?: Array<{ id?: string; display_name?: string; name?: string }>;
        has_more?: boolean;
        last_id?: string | null;
      };
      for (const model of body.data ?? []) {
        if (typeof model.id !== 'string' || model.id.length === 0) continue;
        models.push({ value: model.id, label: model.display_name || model.name || model.id });
      }
      if (!body.has_more || !body.last_id || body.last_id === afterId) break;
      afterId = body.last_id;
    }

    return { success: true, models: models.length > 0 ? dedupeModels(models) : undefined };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function selectionRequestFields(selection: ResolvedModelSelection): {
  apiProviderId?: string | null;
  modelEndpointId?: string | null;
  modelProtocol?: ApiProtocol | null;
} {
  if (!selection.endpointId) return {};
  return {
    apiProviderId: selection.apiProviderId,
    modelEndpointId: selection.endpointId,
    modelProtocol: selection.protocol,
  };
}

export class ProviderRegistry {
  #registry: IChatRegistry;
  #adapters = new Map<string, ProviderAdapter>();
  #endpointResolver: ApiProviderEndpointResolver;
  #apiProviderStore: ApiProviderStore;
  #opencodeInstance: any;
  #authDispatchers = new Map<string, (opencode: any) => Promise<unknown>>();

  constructor(args: {
    registry: IChatRegistry;
    adapters: ProviderAdapter[];
    endpointResolver: ApiProviderEndpointResolver;
    apiProviderStore: ApiProviderStore;
    opencodeInstance?: any;
  }) {
    this.#registry = args.registry;
    this.#endpointResolver = args.endpointResolver;
    this.#apiProviderStore = args.apiProviderStore;
    this.#opencodeInstance = args.opencodeInstance;

    for (const adapter of args.adapters) {
      this.#adapters.set(adapter.id, adapter);
    }

    for (const [key, fn] of Object.entries(AUTH_DISPATCHERS)) {
      this.#authDispatchers.set(key, fn);
    }

    if (typeof args.registry.onChatRemoved === 'function') {
      args.registry.onChatRemoved((chatId: string) => {
        const oc = this.#adapters.get('opencode');
        if (oc && 'evictChat' in oc) {
          (oc as any).evictChat(chatId);
        }
      });
    }
  }

  hasHarness(harnessId: string): boolean {
    return this.#adapters.has(harnessId);
  }

  #adapterFor(harnessId: string): ProviderAdapter {
    const adapter = this.#adapters.get(harnessId);
    if (!adapter) throw new Error(`Unsupported harness: ${harnessId}`);
    return adapter;
  }

  async startSession(chatId: string, command: string, opts: {
    images?: AgentCommandImage[];
    model?: string;
    permissionMode?: PermissionMode;
    thinkingMode?: ThinkingMode;
    claudeThinkingMode?: ClaudeThinkingMode;
    ampAgentMode?: AmpAgentMode;
    projectPath?: string;
  } = {}): Promise<void> {
    const rawEntry = this.#registry.getChat(chatId);

    const maxSessions = getMaxSessions();
    if (maxSessions > 0) {
      const running = this.getRunningSessionCount();
      if (running >= maxSessions) {
        throw new Error(`Session limit reached (${maxSessions}). Wait for existing sessions to complete or increase GARCON_MAX_SESSIONS.`);
      }
    }

    const entry = requireChatEntry(chatId, rawEntry);
    const selection = this.#endpointResolver.resolveSelection({
      harnessId: entry.provider,
      model: entry.model,
      apiProviderId: entry.apiProviderId,
      modelEndpointId: entry.modelEndpointId,
    });

    const request: StartSessionRequest = {
      chatId,
      command,
      projectPath: entry.projectPath,
      model: selection.model,
      permissionMode: entry.permissionMode,
      thinkingMode: entry.thinkingMode,
      claudeThinkingMode: opts.claudeThinkingMode ?? entry.claudeThinkingMode,
      images: opts.images,
      envOverrides: selection.envOverrides,
      ...selectionRequestFields(selection),
    };

    const adapter = this.#adapterFor(entry.provider);
    const started = await adapter.startSession(request);
    this.#registry.updateChat(chatId, {
      providerSessionId: started.providerSessionId,
      nativePath: started.nativePath,
      apiProviderId: selection.apiProviderId,
      modelEndpointId: selection.endpointId,
      modelProtocol: selection.protocol,
    });
  }

  async runProviderTurn(chatId: string, command: string, opts: RunProviderTurnOptions = {}): Promise<void> {
    const rawEntry = this.#registry.getChat(chatId);
    if (!rawEntry) {
      throw new Error(`Session not initialized: ${chatId}. Call /api/chats/start first.`);
    }

    const { provider, providerSessionId } = rawEntry;
    if (!providerSessionId) {
      throw new Error(`Session missing harness session ID: ${chatId}`);
    }

    const entry = requireChatEntry(chatId, rawEntry);
    const effectiveModel = opts.model ?? entry.model;

    const previousSelection = this.#endpointResolver.resolveSelection({
      harnessId: provider,
      model: entry.model,
      apiProviderId: rawEntry.apiProviderId,
      modelEndpointId: rawEntry.modelEndpointId,
    });

    const nextApiProviderId = opts.apiProviderId !== undefined ? opts.apiProviderId : rawEntry.apiProviderId;
    const nextEndpointId = opts.modelEndpointId !== undefined ? opts.modelEndpointId : rawEntry.modelEndpointId;
    const selection = this.#endpointResolver.resolveSelection({
      harnessId: provider,
      model: effectiveModel,
      apiProviderId: nextApiProviderId,
      modelEndpointId: nextEndpointId,
    });

    assertSameApiProviderBoundary(previousSelection, selection);

    const adapter = this.#adapterFor(provider);
    await adapter.runTurn({
      chatId,
      providerSessionId,
      command,
      projectPath: entry.projectPath,
      model: selection.model,
      permissionMode: opts.permissionMode ?? entry.permissionMode,
      thinkingMode: opts.thinkingMode ?? entry.thinkingMode,
      claudeThinkingMode: opts.claudeThinkingMode ?? entry.claudeThinkingMode,
      images: opts.images,
      envOverrides: selection.envOverrides,
      ...selectionRequestFields(selection),
    });
  }

  async abortSession(chatId: string): Promise<boolean> {
    const entry = this.#registry.getChat(chatId);
    const providerSessionId = entry?.providerSessionId;
    if (!providerSessionId) return false;
    const adapter = this.#adapters.get(entry.provider);
    if (!adapter) return false;
    return adapter.abort(providerSessionId);
  }

  isChatRunning(chatId: string): boolean {
    const entry = this.#registry.getChat(chatId);
    if (!entry) return false;
    return this.isHarnessSessionRunning(entry.provider, entry.providerSessionId);
  }

  isHarnessSessionRunning(provider: string, providerSessionId: string | null | undefined): boolean {
    if (!providerSessionId) return false;
    const adapter = this.#adapters.get(provider);
    if (!adapter) return false;
    return adapter.isRunning(providerSessionId);
  }

  getRunningSessions(): Record<string, Array<{ id: string;[key: string]: unknown }>> {
    const mapToChatId = (arr: Array<{ id: string;[key: string]: unknown }>) =>
      arr
        .map((e) => (typeof e === 'string' ? { id: e } : e))
        .map((e) => {
          const match = e?.id ? this.#registry.getChatByProviderSessionId(e.id) : null;
          const mapped = match ? match[0] : null;
          return mapped ? { ...e, id: mapped } : null;
        })
        .filter((e): e is NonNullable<typeof e> => Boolean(e));

    const result: Record<string, Array<{ id: string;[key: string]: unknown }>> = {};
    for (const [provider, adapter] of this.#adapters.entries()) {
      result[provider] = mapToChatId(adapter.getRunningSessions());
    }
    return result;
  }

  getRunningSessionCount(): number {
    let total = 0;
    for (const adapter of this.#adapters.values()) {
      total += adapter.getRunningSessions().length;
    }
    return total;
  }

  resolvePermission(chatId: string, permissionRequestId: string, decision: { allow: boolean; alwaysAllow?: boolean }): void {
    if (!chatId || !permissionRequestId) return;

    const chat = this.#registry.getChat(chatId);
    if (!chat) {
      console.warn('providers: resolvePermission, unknown chatId:', chatId);
      return;
    }

    if (chat.provider === 'claude') {
      const adapter = this.#adapters.get('claude') as any;
      adapter?.resolveInternalToolApproval?.(permissionRequestId, decision);
      return;
    }

    if (chat.provider === 'opencode') {
      const adapter = this.#adapters.get('opencode') as any;
      adapter?.resolvePermission?.(permissionRequestId, decision).catch((err: Error) => {
        console.warn('providers: opencode permission reply failed:', err.message);
      });
      return;
    }

    console.warn('providers: no permission handler for provider:', chat.provider);
  }

  async setPermissionMode(chatId: string, mode: PermissionMode): Promise<void> {
    const entry = this.#registry.getChat(chatId);
    const providerSessionId = entry?.providerSessionId;
    if (!providerSessionId || entry.provider !== 'claude') return;
    const adapter = this.#adapters.get('claude') as any;
    adapter?.setInternalPermissionMode?.(providerSessionId, mode);
  }

  async setThinkingMode(chatId: string, mode: ThinkingMode): Promise<void> {
    const entry = this.#registry.getChat(chatId);
    const providerSessionId = entry?.providerSessionId;
    if (!providerSessionId || entry.provider !== 'claude') return;
    const adapter = this.#adapters.get('claude') as any;
    adapter?.setInternalThinkingMode?.(providerSessionId, mode);
  }

  async setClaudeThinkingMode(chatId: string, mode: ClaudeThinkingMode): Promise<void> {
    const entry = this.#registry.getChat(chatId);
    const providerSessionId = entry?.providerSessionId;
    if (!providerSessionId || entry.provider !== 'claude') return;
    const adapter = this.#adapters.get('claude') as any;
    adapter?.setInternalClaudeThinkingMode?.(providerSessionId, mode);
  }

  async setAmpAgentMode(_chatId: string, _mode: AmpAgentMode): Promise<void> { }

  async setModel(chatId: string, model: string, metadata: {
    apiProviderId?: string | null;
    modelEndpointId?: string | null;
  } = {}): Promise<void> {
    const entry = this.#registry.getChat(chatId);
    if (!entry) return;
    const previous = this.#endpointResolver.resolveSelection({
      harnessId: entry.provider,
      model: entry.model,
      apiProviderId: entry.apiProviderId,
      modelEndpointId: entry.modelEndpointId,
    });
    const next = this.#endpointResolver.resolveSelection({
      harnessId: entry.provider,
      model,
      apiProviderId: metadata.apiProviderId !== undefined ? metadata.apiProviderId : entry.apiProviderId,
      modelEndpointId: metadata.modelEndpointId !== undefined ? metadata.modelEndpointId : entry.modelEndpointId,
    });
    assertSameApiProviderBoundary(previous, next);
  }

  async runSingleQuery(prompt: string, options: { provider?: string;[key: string]: unknown } = {}): Promise<string> {
    const { provider = 'claude', ...rest } = options;
    const adapter = this.#adapters.get(provider);
    if (adapter?.runSingleQuery) {
      const model = typeof rest.model === 'string' ? rest.model : '';
      if (model) {
        const selection = this.#endpointResolver.resolveSelection({
          harnessId: provider,
          model,
          apiProviderId: typeof rest.apiProviderId === 'string' ? rest.apiProviderId : null,
          modelEndpointId: typeof rest.modelEndpointId === 'string' ? rest.modelEndpointId : null,
        });
        rest.model = selection.model;
        if (selection.envOverrides) rest.envOverrides = selection.envOverrides;
        Object.assign(rest, selectionRequestFields(selection));
      }
      return adapter.runSingleQuery(prompt, rest);
    }
    throw new Error(`Single query unsupported for provider: ${provider}`);
  }

  async getPreview(session: ProviderChatEntry | null): Promise<unknown> {
    if (!session?.provider) return null;

    if (session.provider === 'amp') return null;
    if (session.provider === 'factory') {
      const sessionId = session.providerSessionId || getArtificialProviderSessionId(session.nativePath, 'factory');
      return getFactoryPreviewFromSessionId(sessionId || '');
    }
    if (session.provider === 'opencode') {
      const sessionId = session.providerSessionId || session.nativePath?.replace('opencode:', '');
      const client = this.#opencodeInstance?.getClientIfInitialized?.();
      if (!client) return null;
      return getOpenCodePreviewFromSessionId(sessionId, () => Promise.resolve(client));
    }
    if (session.provider === 'claude') {
      return getClaudePreviewFromNativePath(session.nativePath);
    }
    if (session.provider === 'codex') {
      return getCodexPreviewFromNativePath(session.nativePath);
    }
    if (session.provider === 'direct-openai-compatible') {
      const sessionId = session.providerSessionId || getArtificialProviderSessionId(session.nativePath, 'direct-openai-compatible');
      const endpointId = session.modelEndpointId;
      if (!endpointId) return null;
      return getOpenAiCompatiblePreviewFromSessionId(
        sessionId,
        (id) => this.#loadDirectOpenAiMessages(endpointId, id),
        'OpenAI-compatible Session',
      );
    }

    return null;
  }

  async loadMessages(session: ProviderChatEntry | null): Promise<unknown[]> {
    if (!session?.provider) return [];

    if (session.provider === 'amp') return [];
    if (session.provider === 'factory') {
      const sessionId = session.providerSessionId || getArtificialProviderSessionId(session.nativePath, 'factory');
      return loadFactoryChatMessagesBySessionId(sessionId || '');
    }
    if (session.provider === 'opencode') {
      const sessionId = session.providerSessionId || session.nativePath?.replace('opencode:', '');
      const getClient = () => this.#opencodeInstance?.getClient?.() ?? Promise.resolve(null);
      return loadOpenCodeChatMessages(sessionId, getClient);
    }
    if (session.provider === 'claude') {
      return loadClaudeChatMessages(session.nativePath);
    }
    if (session.provider === 'codex') {
      return loadCodexChatMessages(session.nativePath);
    }
    if (session.provider === 'direct-openai-compatible') {
      const sessionId = session.providerSessionId || getArtificialProviderSessionId(session.nativePath, 'direct-openai-compatible');
      const endpointId = session.modelEndpointId;
      if (!endpointId) return [];
      return this.#loadDirectOpenAiMessages(endpointId, sessionId);
    }

    return [];
  }

  async #loadDirectOpenAiMessages(endpointId: string, sessionId: string | null | undefined): Promise<ChatMessage[]> {
    return loadOpenAiCompatibleChatMessages(sessionId, {
      getSessionFilePath: (id) => directOpenAiSessionFilePath(endpointId, id),
      isValidSessionId: (id) => DIRECT_SESSION_ID_RE.test(id),
      sessionLabel: 'OpenAI-compatible Session',
    });
  }

  async getModels(provider: string): Promise<Array<{ value: string; label: string; supportsImages?: boolean }>> {
    const adapter = this.#adapters.get(provider);
    if (adapter?.getModels) return adapter.getModels();
    return [];
  }

  async modelSupportsImages(input: {
    provider: string;
    model: string;
    apiProviderId?: string | null;
    modelEndpointId?: string | null;
  }): Promise<boolean> {
    return this.#endpointResolver.modelSupportsImages({
      harnessId: input.provider as any,
      model: input.model,
      apiProviderId: input.apiProviderId,
      modelEndpointId: input.modelEndpointId,
    });
  }

  async getHarnessAuthStatus(harnessId: string): Promise<unknown | null> {
    if (harnessId === DIRECT_OPENAI_COMPATIBLE_HARNESS_ID) {
      return {
        authenticated: false,
        canReauth: false,
        label: '',
        source: 'none',
      };
    }
    const dispatcher = this.#authDispatchers.get(harnessId);
    if (!dispatcher) return null;
    return dispatcher(this.#opencodeInstance);
  }

  async getHarnessAuthStatusMap(): Promise<Record<string, unknown>> {
    const entries = Array.from(this.#authDispatchers.entries());
    const results = await Promise.all(entries.map(([, fn]) => fn(this.#opencodeInstance)));
    return {
      ...Object.fromEntries(entries.map(([name], i) => [name, results[i]])),
      [DIRECT_OPENAI_COMPATIBLE_HARNESS_ID]: await this.getHarnessAuthStatus(DIRECT_OPENAI_COMPATIBLE_HARNESS_ID),
    };
  }

  async getHarnessReadinessMap(): Promise<Record<string, {
    ready: boolean;
    nativeReady: boolean;
    endpointReady: boolean;
    reason: string;
  }>> {
    const auth = await this.getHarnessAuthStatusMap();
    const result: Record<string, { ready: boolean; nativeReady: boolean; endpointReady: boolean; reason: string }> = {};
    for (const [harnessId] of this.#adapters.entries()) {
      if (!isVisibleHarnessId(harnessId)) continue;
      const endpointReady = this.#endpointResolver.getModelOptions(harnessId as any).length > 0;
      const nativeReady = Boolean((auth[harnessId] as any)?.authenticated);
      result[harnessId] = {
        ready: nativeReady || endpointReady,
        nativeReady,
        endpointReady,
        reason: endpointReady
          ? 'At least one compatible API provider endpoint is configured.'
          : nativeReady
            ? 'Native harness authentication is available.'
            : 'No native authentication or compatible API provider endpoint is configured.',
      };
    }
    return result;
  }

  startPurgeTimers(): void {
    for (const adapter of this.#adapters.values()) {
      adapter.startPurgeTimer?.();
    }
  }

  shutdown(): void {
    for (const adapter of this.#adapters.values()) {
      adapter.shutdown?.();
    }
  }

  onMessages(cb: (chatId: string, messages: unknown[]) => void): void {
    for (const adapter of this.#adapters.values()) {
      adapter.onMessages(cb);
    }
  }

  onProcessing(cb: (chatId: string, isProcessing: boolean) => void): void {
    for (const adapter of this.#adapters.values()) {
      adapter.onProcessing(cb);
    }
  }

  onSessionCreated(cb: (chatId: string) => void): void {
    for (const adapter of this.#adapters.values()) {
      adapter.onSessionCreated(cb);
    }
  }

  onFinished(cb: (chatId: string, exitCode: number) => void): void {
    for (const adapter of this.#adapters.values()) {
      adapter.onFinished(cb);
    }
  }

  onFailed(cb: (chatId: string, errorMessage: string) => void): void {
    for (const adapter of this.#adapters.values()) {
      adapter.onFailed(cb);
    }
  }

  async getHarnessCatalog(): Promise<HarnessCatalog> {
    const apiProviders = this.#apiProviderStore.redactedList();
    const harnesses: HarnessCatalogEntry[] = [];

    for (const [id, adapter] of this.#adapters.entries()) {
      if (!isVisibleHarnessId(id)) continue;
      const endpointModels = this.#endpointResolver.getModelOptions(id as any);
      const nativeModels = await nativeModelsForHarness(id, adapter);
      const models = id === DIRECT_OPENAI_COMPATIBLE_HARNESS_ID
        ? dedupeModels(endpointModels)
        : dedupeModels([...nativeModels, ...endpointModels]);
      const builtinCaps = BUILTIN_HARNESS_CAPABILITIES[id as keyof typeof BUILTIN_HARNESS_CAPABILITIES];
      harnesses.push({
        id: id as any,
        label: adapter.label,
        kind: 'harness',
        supportsFork: builtinCaps?.supportsFork ?? false,
        supportsImages: builtinCaps?.supportsImages ?? false,
        acceptsApiProviderEndpoints: builtinCaps?.acceptsApiProviderEndpoints ?? false,
        supportedProtocols: builtinCaps?.supportedProtocols ?? [],
        defaultModel: defaultModelForHarness(id, nativeModels, endpointModels),
        models,
      });
    }

    return {
      harnesses,
      apiProviders: apiProviders as any,
    };
  }

  getApiProviderCatalog(): ApiProviderCatalogEntry[] {
    return this.#apiProviderStore.redactedList() as any;
  }

  async createApiProvider(input: ApiProviderInput): Promise<ApiProviderCatalogEntry> {
    const apiProvider = await this.#apiProviderStore.createApiProvider(flattenApiProviderInput(input));
    return redactApiProviderForCatalog(apiProvider);
  }

  async updateApiProvider(id: string, input: Partial<ApiProviderInput>): Promise<ApiProviderCatalogEntry> {
    const apiProvider = await this.#apiProviderStore.updateApiProvider(id, flattenApiProviderPatch(input));
    return redactApiProviderForCatalog(apiProvider);
  }

  async deleteApiProvider(id: string): Promise<void> {
    await this.#apiProviderStore.deleteApiProvider(id, (apiProviderId) => this.#registryHasChatsForApiProvider(apiProviderId));
  }

  async testApiProvider(input: ApiProviderInput): Promise<ApiProviderModelDiscoveryResponse> {
    const flat = flattenApiProviderInput(input);
    if (flat.modelDiscovery === 'ollama-tags') return testOllamaTags(flat);
    if (flat.modelDiscovery === 'anthropic-models') return testAnthropicModels(flat);
    if (flat.modelDiscovery === 'openai-models' || flat.modelDiscovery === 'openrouter-models') {
      return testOpenAiModels(flat);
    }
    return { success: true };
  }

  async discoverApiProviderModels(input: ApiProviderModelDiscoveryRequest): Promise<ApiProviderModelDiscoveryResponse> {
    const flat = flattenApiProviderModelDiscoveryInput(input);
    const apiKey = flat.apiKey ?? this.#storedApiKeyForDiscovery(flat);
    const discoveryInput = { ...flat, apiKey };
    if (discoveryInput.modelDiscovery === 'ollama-tags') return testOllamaTags(discoveryInput);
    if (discoveryInput.modelDiscovery === 'anthropic-models') return testAnthropicModels(discoveryInput);
    if (discoveryInput.modelDiscovery === 'openai-models' || discoveryInput.modelDiscovery === 'openrouter-models') {
      return testOpenAiModels(discoveryInput);
    }
    return { success: false, error: `Model discovery is not supported for ${discoveryInput.modelDiscovery}.` };
  }

  #registryHasChatsForApiProvider(apiProviderId: string): boolean {
    for (const entry of Object.values(this.#registry.listAllChats())) {
      if ((entry as any).apiProviderId === apiProviderId) return true;
    }
    return false;
  }

  #storedApiKeyForDiscovery(input: Pick<ApiProviderModelDiscoveryFlatInput, 'apiProviderId' | 'endpointId' | 'protocol'>): string | undefined {
    if (input.endpointId) {
      const resolved = this.#apiProviderStore.getEndpoint(input.endpointId);
      if (resolved?.endpoint.protocol === input.protocol) return resolved.endpoint.apiKey || undefined;
    }
    if (input.apiProviderId) {
      const apiProvider = this.#apiProviderStore.getApiProvider(input.apiProviderId);
      const endpoint = apiProvider?.endpoints.find((entry) => entry.protocol === input.protocol);
      return endpoint?.apiKey || undefined;
    }
    return undefined;
  }

}
