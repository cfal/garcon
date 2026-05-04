// Shared harness and API provider contracts. Harnesses execute chats; API
// providers expose protocol-specific model endpoints that harnesses may use.

export const BUILTIN_HARNESSES = [
  'claude',
  'codex',
  'opencode',
  'amp',
  'factory',
  'direct-openai-compatible',
] as const;

export type BuiltinHarnessId = (typeof BUILTIN_HARNESSES)[number];
export type HarnessId = BuiltinHarnessId | (string & {});

export type ApiProtocol =
  | 'anthropic-messages'
  | 'openai-chat-completions';

export type ModelDiscoveryKind =
  | 'none'
  | 'anthropic-models'
  | 'openai-models'
  | 'ollama-tags'
  | 'openrouter-models';

export type ApiProviderTemplateId =
  | 'openrouter'
  | 'zai'
  | 'ollama'
  | 'custom';

export interface HarnessCapabilities {
  supportsFork: boolean;
  supportsImages: boolean;
  acceptsApiProviderEndpoints: boolean;
  supportedProtocols: ApiProtocol[];
}

export const BUILTIN_HARNESS_CAPABILITIES: Record<BuiltinHarnessId, HarnessCapabilities> = {
  claude: {
    supportsFork: true,
    supportsImages: true,
    acceptsApiProviderEndpoints: true,
    supportedProtocols: ['anthropic-messages'],
  },
  codex: {
    supportsFork: true,
    supportsImages: true,
    acceptsApiProviderEndpoints: true,
    supportedProtocols: ['openai-chat-completions'],
  },
  opencode: {
    supportsFork: false,
    supportsImages: false,
    acceptsApiProviderEndpoints: false,
    supportedProtocols: [],
  },
  amp: {
    supportsFork: false,
    supportsImages: false,
    acceptsApiProviderEndpoints: false,
    supportedProtocols: [],
  },
  factory: {
    supportsFork: false,
    supportsImages: false,
    acceptsApiProviderEndpoints: false,
    supportedProtocols: [],
  },
  'direct-openai-compatible': {
    supportsFork: false,
    supportsImages: true,
    acceptsApiProviderEndpoints: true,
    supportedProtocols: ['openai-chat-completions'],
  },
};

const HARNESS_IDS_BY_PROTOCOL: Record<ApiProtocol, readonly BuiltinHarnessId[]> = {
  'anthropic-messages': ['claude'],
  'openai-chat-completions': ['codex', 'direct-openai-compatible'],
};

export interface HarnessModelOption {
  value: string;
  label: string;
  supportsImages?: boolean;
  isLocal?: boolean;
  apiProviderId?: string;
  endpointId?: string;
  rawModel?: string;
  protocol?: ApiProtocol;
}

export interface HarnessCatalogEntry {
  id: HarnessId;
  label: string;
  description?: string;
  kind: 'harness';
  supportsFork: boolean;
  supportsImages: boolean;
  acceptsApiProviderEndpoints: boolean;
  supportedProtocols: ApiProtocol[];
  defaultModel: string;
  models: HarnessModelOption[];
}

export interface ApiProviderCatalogEntry {
  id: string;
  label: string;
  templateId?: ApiProviderTemplateId;
  createdAt: string;
  updatedAt: string;
  endpoints: ApiProviderEndpointCatalogEntry[];
}

export interface ApiProviderEndpointCatalogEntry {
  id: string;
  protocol: ApiProtocol;
  baseUrl: string;
  exposeTo: HarnessId[];
  defaultModel: string;
  models: HarnessModelOption[];
  supportsImages: boolean;
  hasApiKey: boolean;
  apiKeyLabel?: string;
  modelDiscovery?: ModelDiscoveryKind;
}

export interface HarnessCatalog {
  harnesses: HarnessCatalogEntry[];
  apiProviders: ApiProviderCatalogEntry[];
}

export interface ApiProviderModelDiscoveryRequest {
  protocol: ApiProtocol;
  baseUrl: string;
  apiKey?: string;
  apiProviderId?: string | null;
  endpointId?: string | null;
  modelDiscovery?: ModelDiscoveryKind;
}

export interface ApiProviderModelDiscoveryResponse {
  success: boolean;
  models?: HarnessModelOption[];
  error?: string;
}

const ENDPOINT_MODEL_VALUE_SEPARATOR = ':';
const SAFE_ID_RE = /^[a-z][a-z0-9_-]{1,63}$/;
const SETTINGS_OAUTH_HARNESSES = ['claude', 'codex'] as const;
const SETTINGS_OTHER_HARNESSES = ['opencode', 'amp', 'factory'] as const;

export type OAuthHarnessId = (typeof SETTINGS_OAUTH_HARNESSES)[number];
export type OtherSettingsHarnessId = (typeof SETTINGS_OTHER_HARNESSES)[number];

export function endpointModelOptionValue(endpointId: string, rawModel: string): string {
  return `${endpointId}${ENDPOINT_MODEL_VALUE_SEPARATOR}${rawModel}`;
}

export function rawModelFromEndpointOptionValue(endpointId: string, selectedModel: string): string {
  const prefix = `${endpointId}${ENDPOINT_MODEL_VALUE_SEPARATOR}`;
  return selectedModel.startsWith(prefix) ? selectedModel.slice(prefix.length) : selectedModel;
}

export function isHarnessId(value: unknown): value is HarnessId {
  return typeof value === 'string' && SAFE_ID_RE.test(value);
}

export function isVisibleHarnessId(value: string): boolean {
  return (BUILTIN_HARNESSES as readonly string[]).includes(value);
}

export function isOAuthHarnessId(value: string): value is OAuthHarnessId {
  return (SETTINGS_OAUTH_HARNESSES as readonly string[]).includes(value);
}

export function isOtherSettingsHarnessId(value: string): value is OtherSettingsHarnessId {
  return (SETTINGS_OTHER_HARNESSES as readonly string[]).includes(value);
}

export function isApiProviderId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID_RE.test(value);
}

export function harnessesForProtocol(protocol: ApiProtocol): readonly BuiltinHarnessId[] {
  return HARNESS_IDS_BY_PROTOCOL[protocol];
}

export function isHarnessCompatibleWithProtocol(harnessId: string, protocol: ApiProtocol): boolean {
  return harnessesForProtocol(protocol).includes(harnessId as BuiltinHarnessId);
}

export function labelForProtocol(protocol: ApiProtocol): string {
  return protocol === 'anthropic-messages' ? 'Anthropic-compatible' : 'OpenAI-compatible';
}

export function supportsFork(harnessId: HarnessId): boolean {
  if (harnessId in BUILTIN_HARNESS_CAPABILITIES) {
    return BUILTIN_HARNESS_CAPABILITIES[harnessId as BuiltinHarnessId].supportsFork;
  }
  return false;
}

export function supportsImages(harnessId: HarnessId): boolean {
  if (harnessId in BUILTIN_HARNESS_CAPABILITIES) {
    return BUILTIN_HARNESS_CAPABILITIES[harnessId as BuiltinHarnessId].supportsImages;
  }
  return false;
}
