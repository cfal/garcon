// Shared API provider contracts. API providers are user-managed
// compatible endpoint configurations consumed by agents.

import type { AgentModelOption } from './agents.js';

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

export interface OpenAiEndpointCapabilities {
  chatCompletions: boolean;
  responses: boolean;
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

const SAFE_ID_RE = /^[a-z][a-z0-9_-]{1,63}$/;

export function isApiProviderId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID_RE.test(value);
}

export function isApiProviderTemplateId(value: unknown): value is ApiProviderTemplateId {
  return typeof value === 'string' && (API_PROVIDER_TEMPLATE_IDS as readonly string[]).includes(value);
}

export function labelForProtocol(protocol: ApiProtocol): string {
  return protocol === 'anthropic-messages' ? 'Anthropic-compatible' : 'OpenAI-compatible';
}
