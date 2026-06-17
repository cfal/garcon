// Shared agent contracts. Agents execute chats; API providers expose
// compatible endpoint configurations that some agents may consume.

import type { ApiProviderCatalogEntry, ApiProtocol } from './api-providers.js';

export const DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID = 'direct-openai-compatible' as const;
export const DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID = 'direct-openai-responses-compatible' as const;
export const DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID = 'direct-anthropic-compatible' as const;
export const DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_LABEL = 'Direct (Chat Completions)' as const;
export const DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_LABEL = 'Direct (Responses)' as const;
export const DIRECT_ANTHROPIC_COMPATIBLE_AGENT_LABEL = 'Direct (Anthropic)' as const;

export const BUILTIN_AGENTS = [
  'claude',
  'codex',
  'cursor',
  'opencode',
  'amp',
  'factory',
  'pi',
  DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
  DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
  DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
] as const;

export type BuiltinAgentId = (typeof BUILTIN_AGENTS)[number];
export type AgentId = BuiltinAgentId | (string & {});

export interface AgentCapabilities {
  supportsFork: boolean;
  supportsImages: boolean;
  acceptsApiProviderEndpoints: boolean;
  supportedProtocols: ApiProtocol[];
  authLoginSupported: boolean;
}

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

export interface AgentCatalog {
  agents: AgentCatalogEntry[];
  apiProviders: ApiProviderCatalogEntry[];
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
    supportsFork: true,
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
    supportsFork: true,
    supportsImages: false,
    acceptsApiProviderEndpoints: false,
    supportedProtocols: [],
    authLoginSupported: false,
  },
  [DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID]: {
    supportsFork: false,
    supportsImages: true,
    acceptsApiProviderEndpoints: true,
    supportedProtocols: ['openai-compatible'],
    authLoginSupported: false,
  },
  [DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID]: {
    supportsFork: false,
    supportsImages: true,
    acceptsApiProviderEndpoints: true,
    supportedProtocols: ['openai-compatible'],
    authLoginSupported: false,
  },
  [DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID]: {
    supportsFork: false,
    supportsImages: true,
    acceptsApiProviderEndpoints: true,
    supportedProtocols: ['anthropic-messages'],
    authLoginSupported: false,
  },
};

const SAFE_ID_RE = /^[a-z][a-z0-9_-]{1,63}$/;
const SETTINGS_OAUTH_AGENTS = ['claude', 'codex'] as const;
const SETTINGS_OTHER_AGENTS = ['amp', 'cursor', 'factory', 'opencode', 'pi'] as const;

export const ENDPOINT_ONLY_AGENTS = [
  DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
  DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
  DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
] as const;

export type OAuthAgentId = (typeof SETTINGS_OAUTH_AGENTS)[number];
export type OtherSettingsAgentId = (typeof SETTINGS_OTHER_AGENTS)[number];
export type EndpointOnlyAgentId = (typeof ENDPOINT_ONLY_AGENTS)[number];

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
