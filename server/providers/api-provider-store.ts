// Persists user-managed API providers and their protocol-specific endpoints.
// Credentials stay server-side; catalog responses expose only redacted flags.

import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import {
  apiProviderTemplate,
  type ApiProviderTemplate,
} from '../../common/api-provider-templates.js';
import {
  harnessesForProtocol,
  labelForProtocol,
  type ApiProtocol,
  type ApiProviderTemplateId,
  type HarnessId,
  type HarnessModelOption,
  type ModelDiscoveryKind,
} from '../../common/providers.js';
import { getConfigDir } from '../config.js';

const SAFE_ID_RE = /^[a-z][a-z0-9_-]{1,63}$/;
const MODEL_DISCOVERY_KINDS = new Set<ModelDiscoveryKind>([
  'none',
  'anthropic-models',
  'openai-models',
  'ollama-tags',
  'openrouter-models',
]);

export interface StoredApiProvider {
  id: string;
  label: string;
  templateId?: ApiProviderTemplateId;
  endpoints: StoredApiProviderEndpoint[];
  createdAt: string;
  updatedAt: string;
}

export interface StoredApiProviderEndpoint {
  id: string;
  protocol: ApiProtocol;
  baseUrl: string;
  apiKey: string;
  apiKeyLabel?: string;
  exposeTo: HarnessId[];
  defaultModel: string;
  models: HarnessModelOption[];
  supportsImages: boolean;
  modelDiscovery: ModelDiscoveryKind;
  headers?: Record<string, string>;
}

export interface CreateApiProviderInput {
  templateId: ApiProviderTemplateId;
  label: string;
  protocol: ApiProtocol;
  baseUrl: string;
  apiKey?: string;
  exposeTo: HarnessId[];
  defaultModel: string;
  models: HarnessModelOption[];
  supportsImages: boolean;
  modelDiscovery: ModelDiscoveryKind;
}

export interface UpdateApiProviderEndpointInput {
  id?: string;
  baseUrl?: string;
  apiKey?: string;
  clearApiKey?: boolean;
  exposeTo?: HarnessId[];
  defaultModel?: string;
  models?: HarnessModelOption[];
  supportsImages?: boolean;
  modelDiscovery?: ModelDiscoveryKind;
}

export interface UpdateApiProviderInput {
  label?: string;
  endpoint?: UpdateApiProviderEndpointInput;
}

export interface ApiProviderStoreSnapshot {
  version: 1;
  apiProviders: StoredApiProvider[];
}

function storePath(): string {
  return path.join(getConfigDir(), 'api-providers.json');
}

function redactEndpoint(endpoint: StoredApiProviderEndpoint) {
  const { apiKey: _apiKey, headers: _headers, ...rest } = endpoint;
  return {
    ...rest,
    hasApiKey: Boolean(endpoint.apiKey),
    apiKeyLabel: endpoint.apiKeyLabel ?? '',
  };
}

function createApiProviderId(label: string): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const suffix = crypto.randomBytes(3).toString('hex');
  const id = `${base}_${suffix}`;
  return SAFE_ID_RE.test(id) ? id : `custom_${suffix}`;
}

function normalizeRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function normalizeBaseUrl(url: string): string {
  let normalized = normalizeRequiredString(url, 'baseUrl');
  if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
    normalized = `https://${normalized}`;
  }
  const parsed = new URL(normalized);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('baseUrl must use http or https');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('baseUrl must not include query or fragment components');
  }
  return normalized.replace(/\/+$/, '');
}

function labelApiKey(apiKey: string | undefined): string {
  if (!apiKey) return '';
  if (apiKey.length <= 8) return '****';
  return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
}

function normalizeExposeTargets(protocol: ApiProtocol, targets: HarnessId[]): HarnessId[] {
  if (!Array.isArray(targets)) {
    throw new Error('endpoint.exposeTo must be an array');
  }
  const allowed = new Set(harnessesForProtocol(protocol));
  const invalid = targets.filter((target) => typeof target !== 'string' || !allowed.has(target as any));
  if (invalid.length > 0) {
    throw new Error(`endpoint.exposeTo must only include ${labelForProtocol(protocol)} harnesses`);
  }
  const normalized = [...new Set(targets)] as HarnessId[];
  if (normalized.length === 0) {
    throw new Error(`endpoint.exposeTo must include at least one ${labelForProtocol(protocol)} harness`);
  }
  return normalized;
}

function normalizeManualModels(models: HarnessModelOption[], defaultModel: string): HarnessModelOption[] {
  const fallback = normalizeRequiredString(defaultModel, 'defaultModel');
  const normalized: HarnessModelOption[] = [];
  if (Array.isArray(models)) {
    for (const model of models) {
      if (!model || typeof model !== 'object') continue;
      const value = typeof model.value === 'string' ? model.value.trim() : '';
      const label = typeof model.label === 'string' ? model.label.trim() : '';
      if (!value || !label) continue;
      const normalizedModel: HarnessModelOption = { value, label };
      if (typeof model.supportsImages === 'boolean') normalizedModel.supportsImages = model.supportsImages;
      if (typeof model.isLocal === 'boolean') normalizedModel.isLocal = model.isLocal;
      if (typeof model.apiProviderId === 'string') normalizedModel.apiProviderId = model.apiProviderId;
      if (typeof model.endpointId === 'string') normalizedModel.endpointId = model.endpointId;
      if (typeof model.rawModel === 'string') normalizedModel.rawModel = model.rawModel;
      if (model.protocol === 'openai-chat-completions' || model.protocol === 'anthropic-messages') {
        normalizedModel.protocol = model.protocol;
      }
      normalized.push(normalizedModel);
    }
  }

  if (normalized.length === 0) {
    return [{ value: fallback, label: fallback }];
  }
  const hasDefault = normalized.some((m) => m.value === fallback);
  return hasDefault ? normalized : [{ value: fallback, label: fallback }, ...normalized];
}

function normalizeProtocol(value: unknown): ApiProtocol | null {
  return value === 'anthropic-messages' || value === 'openai-chat-completions' ? value : null;
}

function normalizeTemplateId(value: unknown): ApiProviderTemplateId | undefined {
  if (value === 'openrouter' || value === 'zai' || value === 'ollama' || value === 'custom') return value;
  return undefined;
}

function normalizeModelDiscovery(protocol: ApiProtocol, value: unknown): ModelDiscoveryKind {
  if (typeof value === 'string' && MODEL_DISCOVERY_KINDS.has(value as ModelDiscoveryKind)) {
    return value as ModelDiscoveryKind;
  }
  return protocol === 'openai-chat-completions' ? 'openai-models' : 'none';
}

function normalizeHeaders(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const headers: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string') headers[key] = raw;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function normalizeStoredEndpoint(value: unknown): StoredApiProviderEndpoint | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || !SAFE_ID_RE.test(raw.id)) return null;
  const protocol = normalizeProtocol(raw.protocol);
  if (!protocol) return null;
  if (typeof raw.baseUrl !== 'string' || typeof raw.defaultModel !== 'string') return null;
  const defaultModel = normalizeRequiredString(raw.defaultModel, 'defaultModel');
  return {
    id: raw.id,
    protocol,
    baseUrl: normalizeBaseUrl(raw.baseUrl),
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
    apiKeyLabel: typeof raw.apiKeyLabel === 'string' ? raw.apiKeyLabel : labelApiKey(typeof raw.apiKey === 'string' ? raw.apiKey : ''),
    exposeTo: normalizeExposeTargets(protocol, Array.isArray(raw.exposeTo) ? raw.exposeTo as HarnessId[] : []),
    defaultModel,
    models: normalizeManualModels(Array.isArray(raw.models) ? raw.models as HarnessModelOption[] : [], defaultModel),
    supportsImages: Boolean(raw.supportsImages),
    modelDiscovery: normalizeModelDiscovery(protocol, raw.modelDiscovery),
    headers: normalizeHeaders(raw.headers),
  };
}

function normalizeStoredApiProvider(value: unknown): StoredApiProvider | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || !SAFE_ID_RE.test(raw.id) || typeof raw.label !== 'string') return null;
  if (!Array.isArray(raw.endpoints)) return null;

  const endpoints = raw.endpoints
    .map((endpoint) => {
      try {
        return normalizeStoredEndpoint(endpoint);
      } catch {
        return null;
      }
    })
    .filter((endpoint): endpoint is StoredApiProviderEndpoint => endpoint !== null);
  if (endpoints.length === 0) return null;

  const now = new Date().toISOString();
  return {
    id: raw.id,
    label: raw.label,
    templateId: normalizeTemplateId(raw.templateId),
    endpoints,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now,
  };
}

function normalizeSnapshot(raw: unknown): ApiProviderStoreSnapshot {
  if (!raw || typeof raw !== 'object') {
    return { version: 1, apiProviders: [] };
  }
  const root = raw as Record<string, unknown>;
  if (root.version !== 1 || !Array.isArray(root.apiProviders)) {
    return { version: 1, apiProviders: [] };
  }
  return {
    version: 1,
    apiProviders: root.apiProviders
      .map(normalizeStoredApiProvider)
      .filter((entry): entry is StoredApiProvider => entry !== null),
  };
}

function endpointSuffix(protocol: ApiProtocol): string {
  return protocol === 'anthropic-messages' ? 'anthropic' : 'openai';
}

function headersForTemplate(template: ApiProviderTemplate | null): Record<string, string> | undefined {
  if (template?.managedHeaders === 'openrouter') {
    return {
      'HTTP-Referer': 'https://github.com/cfal/garcon',
      'X-OpenRouter-Title': 'Garcon',
    };
  }
  return undefined;
}

function applyApiKeyPatch(
  endpoint: StoredApiProviderEndpoint,
  patch: { apiKey?: string; clearApiKey?: boolean },
): void {
  if (patch.clearApiKey) {
    endpoint.apiKey = '';
    endpoint.apiKeyLabel = '';
    return;
  }
  if (typeof patch.apiKey === 'string' && patch.apiKey.length > 0) {
    endpoint.apiKey = patch.apiKey;
    endpoint.apiKeyLabel = labelApiKey(patch.apiKey);
  }
}

export class ApiProviderStore {
  #writeLock = Promise.resolve();
  #snapshot: ApiProviderStoreSnapshot = { version: 1, apiProviders: [] };

  constructor(private readonly filePath = storePath()) {}

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    this.#snapshot = await this.#read();
    await this.#write(this.#snapshot);
  }

  list(): StoredApiProvider[] {
    return this.#snapshot.apiProviders;
  }

  redactedList() {
    return this.#snapshot.apiProviders.map((apiProvider) => ({
      ...apiProvider,
      endpoints: apiProvider.endpoints.map(redactEndpoint),
    }));
  }

  getApiProvider(id: string): StoredApiProvider | null {
    return this.#snapshot.apiProviders.find((apiProvider) => apiProvider.id === id) ?? null;
  }

  getEndpoint(endpointId: string): { apiProvider: StoredApiProvider; endpoint: StoredApiProviderEndpoint } | null {
    for (const apiProvider of this.#snapshot.apiProviders) {
      const endpoint = apiProvider.endpoints.find((entry) => entry.id === endpointId);
      if (endpoint) return { apiProvider, endpoint };
    }
    return null;
  }

  async createApiProvider(input: CreateApiProviderInput): Promise<StoredApiProvider> {
    const label = normalizeRequiredString(input.label, 'label');
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const exposeTo = normalizeExposeTargets(input.protocol, input.exposeTo);
    const defaultModel = normalizeRequiredString(input.defaultModel, 'defaultModel');
    const models = normalizeManualModels(input.models, defaultModel);
    const template = apiProviderTemplate(input.protocol, input.templateId);
    if (!template) {
      throw new Error(`Unsupported template for ${labelForProtocol(input.protocol)} providers: ${input.templateId}`);
    }

    return this.#withLock(async () => {
      const snapshot = await this.#read();
      const now = new Date().toISOString();
      const id = createApiProviderId(label);
      const endpointId = `${id}_${endpointSuffix(input.protocol)}`;
      const apiProvider: StoredApiProvider = {
        id,
        label,
        templateId: input.templateId,
        createdAt: now,
        updatedAt: now,
        endpoints: [{
          id: endpointId,
          protocol: input.protocol,
          baseUrl,
          apiKey: input.apiKey ?? '',
          apiKeyLabel: labelApiKey(input.apiKey),
          exposeTo,
          defaultModel,
          models,
          supportsImages: Boolean(input.supportsImages),
          modelDiscovery: input.modelDiscovery,
          headers: headersForTemplate(template),
        }],
      };
      snapshot.apiProviders.push(apiProvider);
      this.#snapshot = snapshot;
      await this.#write(snapshot);
      return apiProvider;
    });
  }

  async updateApiProvider(id: string, input: UpdateApiProviderInput): Promise<StoredApiProvider> {
    return this.#withLock(async () => {
      const snapshot = await this.#read();
      const apiProvider = snapshot.apiProviders.find((entry) => entry.id === id);
      if (!apiProvider) throw new Error(`Unknown API provider: ${id}`);

      if (input.label !== undefined) {
        apiProvider.label = normalizeRequiredString(input.label, 'label');
      }
      apiProvider.updatedAt = new Date().toISOString();

      if (input.endpoint) {
        const endpointId = input.endpoint.id ?? apiProvider.endpoints[0]?.id;
        const endpoint = apiProvider.endpoints.find((entry) => entry.id === endpointId);
        if (!endpoint) throw new Error(`Unknown endpoint: ${endpointId}`);
        endpoint.baseUrl = input.endpoint.baseUrl !== undefined ? normalizeBaseUrl(input.endpoint.baseUrl) : endpoint.baseUrl;
        endpoint.exposeTo = input.endpoint.exposeTo !== undefined
          ? normalizeExposeTargets(endpoint.protocol, input.endpoint.exposeTo)
          : endpoint.exposeTo;
        endpoint.defaultModel = input.endpoint.defaultModel !== undefined
          ? normalizeRequiredString(input.endpoint.defaultModel, 'defaultModel')
          : endpoint.defaultModel;
        endpoint.models = input.endpoint.models
          ? normalizeManualModels(input.endpoint.models, endpoint.defaultModel)
          : endpoint.models;
        endpoint.supportsImages = typeof input.endpoint.supportsImages === 'boolean'
          ? input.endpoint.supportsImages
          : endpoint.supportsImages;
        endpoint.modelDiscovery = input.endpoint.modelDiscovery !== undefined
          ? input.endpoint.modelDiscovery
          : endpoint.modelDiscovery;
        applyApiKeyPatch(endpoint, input.endpoint);
      }

      this.#snapshot = snapshot;
      await this.#write(snapshot);
      return apiProvider;
    });
  }

  async deleteApiProvider(id: string, isReferenced: (apiProviderId: string) => boolean): Promise<void> {
    return this.#withLock(async () => {
      const snapshot = await this.#read();
      const apiProvider = snapshot.apiProviders.find((entry) => entry.id === id);
      if (!apiProvider) return;
      if (isReferenced(id)) {
        throw new Error(`API provider is used by existing chats: ${id}`);
      }
      snapshot.apiProviders = snapshot.apiProviders.filter((entry) => entry.id !== id);
      this.#snapshot = snapshot;
      await this.#write(snapshot);
    });
  }

  async #withLock<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    const prev = this.#writeLock;
    this.#writeLock = next;
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async #read(): Promise<ApiProviderStoreSnapshot> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      return normalizeSnapshot(JSON.parse(raw));
    } catch (error: any) {
      if (error?.code === 'ENOENT') return { version: 1, apiProviders: [] };
      console.warn('api-providers: invalid api-providers.json, using empty provider list:', error.message);
      return { version: 1, apiProviders: [] };
    }
  }

  async #write(snapshot: ApiProviderStoreSnapshot): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const filePath = this.filePath;
    const tmp = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
    await fs.rename(tmp, filePath);
  }
}
