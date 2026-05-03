// Non-secret API provider templates used to prefill the settings dialog and
// let the server apply provider-specific managed metadata.

import { OPENROUTER_MODELS, ZAI_MODELS } from './models.js';
import type {
  ApiProtocol,
  ApiProviderTemplateId,
  HarnessId,
  HarnessModelOption,
  ModelDiscoveryKind,
} from './providers.js';

export type { ApiProviderTemplateId } from './providers.js';

export interface ApiProviderTemplate {
  id: ApiProviderTemplateId;
  protocol: ApiProtocol;
  label: string;
  baseUrl: string;
  apiKeyPlaceholder: string;
  apiKeyRequired: boolean;
  defaultModel: string;
  models: readonly HarnessModelOption[];
  supportsImages: boolean;
  exposeTo: readonly HarnessId[];
  modelDiscovery: ModelDiscoveryKind;
  managedHeaders?: 'openrouter';
}

export const API_PROVIDER_TEMPLATES = [
  {
    id: 'zai',
    protocol: 'anthropic-messages',
    label: 'Z.AI',
    baseUrl: 'https://api.z.ai/api/anthropic',
    apiKeyPlaceholder: 'Z.AI API key',
    apiKeyRequired: true,
    defaultModel: ZAI_MODELS.DEFAULT,
    models: ZAI_MODELS.OPTIONS,
    supportsImages: false,
    exposeTo: ['claude'],
    modelDiscovery: 'none',
  },
  {
    id: 'ollama',
    protocol: 'anthropic-messages',
    label: 'Ollama',
    baseUrl: 'http://localhost:11434',
    apiKeyPlaceholder: 'Leave blank for local Ollama',
    apiKeyRequired: false,
    defaultModel: 'llama3',
    models: [{ value: 'llama3', label: 'llama3 (local)', isLocal: true }],
    supportsImages: false,
    exposeTo: ['claude'],
    modelDiscovery: 'ollama-tags',
  },
  {
    id: 'openrouter',
    protocol: 'openai-chat-completions',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyPlaceholder: 'OpenRouter API key',
    apiKeyRequired: true,
    defaultModel: OPENROUTER_MODELS.DEFAULT,
    models: OPENROUTER_MODELS.OPTIONS,
    supportsImages: true,
    exposeTo: ['codex', 'direct-openai-compatible'],
    modelDiscovery: 'openrouter-models',
    managedHeaders: 'openrouter',
  },
  {
    id: 'zai',
    protocol: 'openai-chat-completions',
    label: 'Z.AI',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    apiKeyPlaceholder: 'Z.AI API key',
    apiKeyRequired: true,
    defaultModel: ZAI_MODELS.DEFAULT,
    models: ZAI_MODELS.OPTIONS,
    supportsImages: false,
    exposeTo: ['codex', 'direct-openai-compatible'],
    modelDiscovery: 'none',
  },
  {
    id: 'ollama',
    protocol: 'openai-chat-completions',
    label: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    apiKeyPlaceholder: 'Leave blank for local Ollama',
    apiKeyRequired: false,
    defaultModel: 'llama3',
    models: [{ value: 'llama3', label: 'llama3 (local)', isLocal: true }],
    supportsImages: false,
    exposeTo: ['codex', 'direct-openai-compatible'],
    modelDiscovery: 'ollama-tags',
  },
  {
    id: 'custom',
    protocol: 'anthropic-messages',
    label: '',
    baseUrl: '',
    apiKeyPlaceholder: 'API key or token',
    apiKeyRequired: false,
    defaultModel: '',
    models: [],
    supportsImages: false,
    exposeTo: ['claude'],
    modelDiscovery: 'none',
  },
  {
    id: 'custom',
    protocol: 'openai-chat-completions',
    label: '',
    baseUrl: '',
    apiKeyPlaceholder: 'API key or token',
    apiKeyRequired: false,
    defaultModel: '',
    models: [],
    supportsImages: false,
    exposeTo: ['codex', 'direct-openai-compatible'],
    modelDiscovery: 'openai-models',
  },
] as const satisfies readonly ApiProviderTemplate[];

export function templatesForProtocol(protocol: ApiProtocol): readonly ApiProviderTemplate[] {
  return API_PROVIDER_TEMPLATES.filter((template) => template.protocol === protocol);
}

export function apiProviderTemplate(
  protocol: ApiProtocol,
  templateId: ApiProviderTemplateId,
): ApiProviderTemplate | null {
  return API_PROVIDER_TEMPLATES.find((template) =>
    template.protocol === protocol && template.id === templateId
  ) ?? null;
}
