// Shared harness and API provider contracts. Harnesses execute chats; API
// providers expose protocol-specific model endpoints that harnesses may use.

export const DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_HARNESS_ID = 'direct-openai-compatible' as const;
export const DIRECT_OPENAI_RESPONSES_COMPATIBLE_HARNESS_ID = 'direct-openai-responses-compatible' as const;
export const DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID = 'direct-anthropic-compatible' as const;
export const DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_HARNESS_LABEL = 'Direct (Chat Completions)' as const;
export const DIRECT_OPENAI_RESPONSES_COMPATIBLE_HARNESS_LABEL = 'Direct (Responses)' as const;
export const DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_LABEL = 'Direct (Anthropic)' as const;

export const BUILTIN_HARNESSES = [
  'claude',
  'codex',
  'cursor',
  'opencode',
  'amp',
  'factory',
  'pi',
  DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_HARNESS_ID,
  DIRECT_OPENAI_RESPONSES_COMPATIBLE_HARNESS_ID,
  DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID,
] as const;

export type BuiltinHarnessId = (typeof BUILTIN_HARNESSES)[number];
export type HarnessId = BuiltinHarnessId | (string & {});

export type ApiProtocol =
  | 'anthropic-messages'
  | 'openai-compatible';

export type ModelDiscoveryKind =
  | 'none'
  | 'anthropic-models'
  | 'openai-models'
  | 'ollama-tags'
  | 'openrouter-models';

export const API_PROVIDER_TEMPLATE_IDS = [
  'alibaba-cloud',
  'fireworks',
  'gemini',
  'ollama',
  'openrouter',
  'together',
  'zai',
  'custom',
] as const;

export type ApiProviderTemplateId = (typeof API_PROVIDER_TEMPLATE_IDS)[number];

export interface HarnessCapabilities {
  supportsFork: boolean;
  supportsImages: boolean;
  acceptsApiProviderEndpoints: boolean;
  supportedProtocols: ApiProtocol[];
}

export interface OpenAiEndpointCapabilities {
  chatCompletions: boolean;
  responses: boolean;
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
    supportedProtocols: ['openai-compatible'],
  },
  cursor: {
    supportsFork: false,
    supportsImages: false,
    acceptsApiProviderEndpoints: false,
    supportedProtocols: [],
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
  pi: {
    supportsFork: false,
    supportsImages: false,
    acceptsApiProviderEndpoints: false,
    supportedProtocols: [],
  },
  [DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_HARNESS_ID]: {
    supportsFork: false,
    supportsImages: true,
    acceptsApiProviderEndpoints: true,
    supportedProtocols: ['openai-compatible'],
  },
  [DIRECT_OPENAI_RESPONSES_COMPATIBLE_HARNESS_ID]: {
    supportsFork: false,
    supportsImages: true,
    acceptsApiProviderEndpoints: true,
    supportedProtocols: ['openai-compatible'],
  },
  [DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID]: {
    supportsFork: false,
    supportsImages: true,
    acceptsApiProviderEndpoints: true,
    supportedProtocols: ['anthropic-messages'],
  },
};

const HARNESS_IDS_BY_PROTOCOL: Record<ApiProtocol, readonly BuiltinHarnessId[]> = {
  'anthropic-messages': ['claude', DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID],
  'openai-compatible': [
    'codex',
    DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_HARNESS_ID,
    DIRECT_OPENAI_RESPONSES_COMPATIBLE_HARNESS_ID,
  ],
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
  capabilities?: OpenAiEndpointCapabilities;
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
const SETTINGS_OTHER_HARNESSES = ['amp', 'cursor', 'factory', 'opencode', 'pi'] as const;
export const ENDPOINT_ONLY_HARNESSES = [
  DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_HARNESS_ID,
  DIRECT_OPENAI_RESPONSES_COMPATIBLE_HARNESS_ID,
  DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID,
] as const;

export type OAuthHarnessId = (typeof SETTINGS_OAUTH_HARNESSES)[number];
export type OtherSettingsHarnessId = (typeof SETTINGS_OTHER_HARNESSES)[number];
export type EndpointOnlyHarnessId = (typeof ENDPOINT_ONLY_HARNESSES)[number];

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

export function isEndpointOnlyHarnessId(value: string): value is EndpointOnlyHarnessId {
  return (ENDPOINT_ONLY_HARNESSES as readonly string[]).includes(value);
}

export function isApiProviderId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID_RE.test(value);
}

export function isApiProviderTemplateId(value: unknown): value is ApiProviderTemplateId {
  return typeof value === 'string' && (API_PROVIDER_TEMPLATE_IDS as readonly string[]).includes(value);
}

export function harnessesForProtocol(protocol: ApiProtocol): readonly BuiltinHarnessId[] {
  return HARNESS_IDS_BY_PROTOCOL[protocol];
}

export function isHarnessCompatibleWithProtocol(harnessId: string, protocol: ApiProtocol): boolean {
  return harnessesForProtocol(protocol).includes(harnessId as BuiltinHarnessId);
}

export interface EndpointHarnessCompatibilityInput {
  protocol: ApiProtocol;
  capabilities?: OpenAiEndpointCapabilities;
}

export function endpointSupportsHarness(
  harnessId: HarnessId,
  endpoint: EndpointHarnessCompatibilityInput,
): boolean {
  if (endpoint.protocol === 'anthropic-messages') {
    return harnessId === 'claude' || harnessId === DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID;
  }

  const capabilities = endpoint.capabilities ?? {
    chatCompletions: false,
    responses: false,
  };
  if (harnessId === DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_HARNESS_ID) {
    return capabilities.chatCompletions;
  }
  if (harnessId === 'codex' || harnessId === DIRECT_OPENAI_RESPONSES_COMPATIBLE_HARNESS_ID) {
    return capabilities.responses;
  }
  return false;
}

export function harnessesForEndpoint(endpoint: EndpointHarnessCompatibilityInput): HarnessId[] {
  return harnessesForProtocol(endpoint.protocol)
    .filter((harnessId) => endpointSupportsHarness(harnessId, endpoint));
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
