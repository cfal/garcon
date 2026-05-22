// Shared agent and API provider contracts. Agents execute chats; API
// providers expose protocol-specific model endpoints that agents may use.

export const DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_HARNESS_ID = 'direct-openai-compatible' as const;
export const DIRECT_OPENAI_RESPONSES_COMPATIBLE_HARNESS_ID = 'direct-openai-responses-compatible' as const;
export const DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID = 'direct-anthropic-compatible' as const;
export const DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_HARNESS_LABEL = 'Direct (Chat Completions)' as const;
export const DIRECT_OPENAI_RESPONSES_COMPATIBLE_HARNESS_LABEL = 'Direct (Responses)' as const;
export const DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_LABEL = 'Direct (Anthropic)' as const;

export const BUILTIN_AGENTS = [
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

export type BuiltinAgentId = (typeof BUILTIN_AGENTS)[number];
export type AgentId = BuiltinAgentId | (string & {});

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

export interface AgentCapabilities {
  supportsFork: boolean;
  supportsImages: boolean;
  acceptsApiProviderEndpoints: boolean;
  supportedProtocols: ApiProtocol[];
  authLoginSupported: boolean;
}

export interface OpenAiEndpointCapabilities {
  chatCompletions: boolean;
  responses: boolean;
}

export const BUILTIN_AGENT_CAPABILITIES: Record<BuiltinAgentId, AgentCapabilities> = {
  claude: {
    supportsFork: true,
    supportsImages: true,
    acceptsApiProviderEndpoints: true,
    supportedProtocols: ['anthropic-messages'],
    authLoginSupported: true,
  },
  codex: {
    supportsFork: true,
    supportsImages: true,
    acceptsApiProviderEndpoints: true,
    supportedProtocols: ['openai-compatible'],
    authLoginSupported: true,
  },
  cursor: {
    supportsFork: false,
    supportsImages: false,
    acceptsApiProviderEndpoints: false,
    supportedProtocols: [],
    authLoginSupported: false,
  },
  opencode: {
    supportsFork: false,
    supportsImages: false,
    acceptsApiProviderEndpoints: false,
    supportedProtocols: [],
    authLoginSupported: false,
  },
  amp: {
    supportsFork: false,
    supportsImages: false,
    acceptsApiProviderEndpoints: false,
    supportedProtocols: [],
    authLoginSupported: false,
  },
  factory: {
    supportsFork: false,
    supportsImages: false,
    acceptsApiProviderEndpoints: false,
    supportedProtocols: [],
    authLoginSupported: false,
  },
  pi: {
    supportsFork: false,
    supportsImages: false,
    acceptsApiProviderEndpoints: false,
    supportedProtocols: [],
    authLoginSupported: false,
  },
  [DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_HARNESS_ID]: {
    supportsFork: false,
    supportsImages: true,
    acceptsApiProviderEndpoints: true,
    supportedProtocols: ['openai-compatible'],
    authLoginSupported: false,
  },
  [DIRECT_OPENAI_RESPONSES_COMPATIBLE_HARNESS_ID]: {
    supportsFork: false,
    supportsImages: true,
    acceptsApiProviderEndpoints: true,
    supportedProtocols: ['openai-compatible'],
    authLoginSupported: false,
  },
  [DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID]: {
    supportsFork: false,
    supportsImages: true,
    acceptsApiProviderEndpoints: true,
    supportedProtocols: ['anthropic-messages'],
    authLoginSupported: false,
  },
};

const AGENT_IDS_BY_PROTOCOL: Record<ApiProtocol, readonly BuiltinAgentId[]> = {
  'anthropic-messages': ['claude', DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID],
  'openai-compatible': [
    'codex',
    DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_HARNESS_ID,
    DIRECT_OPENAI_RESPONSES_COMPATIBLE_HARNESS_ID,
  ],
};

export interface AgentModelOption {
  value: string;
  label: string;
  supportsImages?: boolean;
  isLocal?: boolean;
  apiProviderId?: string;
  endpointId?: string;
  rawModel?: string;
  protocol?: ApiProtocol;
}

export interface AgentCatalogEntry {
  id: AgentId;
  label: string;
  description?: string;
  kind: 'agent';
  supportsFork: boolean;
  supportsImages: boolean;
  acceptsApiProviderEndpoints: boolean;
  supportedProtocols: ApiProtocol[];
  authLoginSupported: boolean;
  defaultModel: string;
  models: AgentModelOption[];
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
  models: AgentModelOption[];
  supportsImages: boolean;
  hasApiKey: boolean;
  apiKeyLabel?: string;
  modelDiscovery?: ModelDiscoveryKind;
}

export interface AgentCatalog {
  agents: AgentCatalogEntry[];
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
  models?: AgentModelOption[];
  error?: string;
}

const ENDPOINT_MODEL_VALUE_SEPARATOR = ':';
const SAFE_ID_RE = /^[a-z][a-z0-9_-]{1,63}$/;
const SETTINGS_OAUTH_AGENTS = ['claude', 'codex'] as const;
const SETTINGS_OTHER_AGENTS = ['amp', 'cursor', 'factory', 'opencode', 'pi'] as const;
export const ENDPOINT_ONLY_AGENTS = [
  DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_HARNESS_ID,
  DIRECT_OPENAI_RESPONSES_COMPATIBLE_HARNESS_ID,
  DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID,
] as const;

export type OAuthAgentId = (typeof SETTINGS_OAUTH_AGENTS)[number];
export type OtherSettingsAgentId = (typeof SETTINGS_OTHER_AGENTS)[number];
export type EndpointOnlyAgentId = (typeof ENDPOINT_ONLY_AGENTS)[number];

export function endpointModelOptionValue(endpointId: string, rawModel: string): string {
  return `${endpointId}${ENDPOINT_MODEL_VALUE_SEPARATOR}${rawModel}`;
}

export function rawModelFromEndpointOptionValue(endpointId: string, selectedModel: string): string {
  const prefix = `${endpointId}${ENDPOINT_MODEL_VALUE_SEPARATOR}`;
  return selectedModel.startsWith(prefix) ? selectedModel.slice(prefix.length) : selectedModel;
}

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === 'string' && SAFE_ID_RE.test(value);
}

export function isVisibleAgentId(value: string): boolean {
  return (BUILTIN_AGENTS as readonly string[]).includes(value);
}

export function isOAuthAgentId(value: string): value is OAuthAgentId {
  return (SETTINGS_OAUTH_AGENTS as readonly string[]).includes(value);
}

export function isOtherSettingsAgentId(value: string): value is OtherSettingsAgentId {
  return (SETTINGS_OTHER_AGENTS as readonly string[]).includes(value);
}

export function isEndpointOnlyAgentId(value: string): value is EndpointOnlyAgentId {
  return (ENDPOINT_ONLY_AGENTS as readonly string[]).includes(value);
}

export function isApiProviderId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID_RE.test(value);
}

export function isApiProviderTemplateId(value: unknown): value is ApiProviderTemplateId {
  return typeof value === 'string' && (API_PROVIDER_TEMPLATE_IDS as readonly string[]).includes(value);
}

export function agentsForProtocol(protocol: ApiProtocol): readonly BuiltinAgentId[] {
  return AGENT_IDS_BY_PROTOCOL[protocol];
}

export function isAgentCompatibleWithProtocol(agentId: string, protocol: ApiProtocol): boolean {
  return agentsForProtocol(protocol).includes(agentId as BuiltinAgentId);
}

export interface EndpointAgentCompatibilityInput {
  protocol: ApiProtocol;
  capabilities?: OpenAiEndpointCapabilities;
}

export function endpointSupportsAgent(
  agentId: AgentId,
  endpoint: EndpointAgentCompatibilityInput,
): boolean {
  if (endpoint.protocol === 'anthropic-messages') {
    return agentId === 'claude' || agentId === DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID;
  }

  const capabilities = endpoint.capabilities ?? {
    chatCompletions: false,
    responses: false,
  };
  if (agentId === DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_HARNESS_ID) {
    return capabilities.chatCompletions;
  }
  if (agentId === 'codex' || agentId === DIRECT_OPENAI_RESPONSES_COMPATIBLE_HARNESS_ID) {
    return capabilities.responses;
  }
  return false;
}

export function agentsForEndpoint(endpoint: EndpointAgentCompatibilityInput): AgentId[] {
  return agentsForProtocol(endpoint.protocol)
    .filter((agentId) => endpointSupportsAgent(agentId, endpoint));
}

export function labelForProtocol(protocol: ApiProtocol): string {
  return protocol === 'anthropic-messages' ? 'Anthropic-compatible' : 'OpenAI-compatible';
}

export function supportsFork(agentId: AgentId): boolean {
  if (agentId in BUILTIN_AGENT_CAPABILITIES) {
    return BUILTIN_AGENT_CAPABILITIES[agentId as BuiltinAgentId].supportsFork;
  }
  return false;
}

export function supportsImages(agentId: AgentId): boolean {
  if (agentId in BUILTIN_AGENT_CAPABILITIES) {
    return BUILTIN_AGENT_CAPABILITIES[agentId as BuiltinAgentId].supportsImages;
  }
  return false;
}
