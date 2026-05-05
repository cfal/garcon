// Non-secret API provider templates used to prefill the settings dialog and
// let the server apply provider-specific managed metadata.

import {
  ALIBABA_CLOUD_MODELS,
  FIREWORKS_MODELS,
  GEMINI_MODELS,
  OPENROUTER_MODELS,
  TOGETHER_MODELS,
  ZAI_MODELS,
} from './models.js';
import type {
  ApiProtocol,
  ApiProviderTemplateId,
  HarnessModelOption,
  ModelDiscoveryKind,
  OpenAiEndpointCapabilities,
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
  capabilities?: OpenAiEndpointCapabilities;
  modelDiscovery: ModelDiscoveryKind;
  managedHeaders?: 'openrouter';
}

export const API_PROVIDER_TEMPLATES = [
  {
    id: 'alibaba-cloud',
    protocol: 'anthropic-messages',
    label: 'Alibaba Cloud',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/apps/anthropic',
    apiKeyPlaceholder: 'Alibaba Cloud API key',
    apiKeyRequired: true,
    defaultModel: ALIBABA_CLOUD_MODELS.DEFAULT,
    models: ALIBABA_CLOUD_MODELS.OPTIONS,
    supportsImages: false,
    modelDiscovery: 'anthropic-models',
  },
  {
    id: 'alibaba-cloud',
    protocol: 'openai-compatible',
    label: 'Alibaba Cloud',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    apiKeyPlaceholder: 'Alibaba Cloud API key',
    apiKeyRequired: true,
    defaultModel: ALIBABA_CLOUD_MODELS.DEFAULT,
    models: ALIBABA_CLOUD_MODELS.OPTIONS,
    supportsImages: false,
    capabilities: { chatCompletions: true, responses: true },
    modelDiscovery: 'openai-models',
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
    modelDiscovery: 'none',
  },
  {
    id: 'custom',
    protocol: 'openai-compatible',
    label: '',
    baseUrl: '',
    apiKeyPlaceholder: 'API key or token',
    apiKeyRequired: false,
    defaultModel: '',
    models: [],
    supportsImages: false,
    capabilities: { chatCompletions: true, responses: false },
    modelDiscovery: 'openai-models',
  },
  {
    id: 'fireworks',
    protocol: 'anthropic-messages',
    label: 'Fireworks.ai',
    baseUrl: 'https://api.fireworks.ai/inference',
    apiKeyPlaceholder: 'Fireworks.ai API key',
    apiKeyRequired: true,
    defaultModel: FIREWORKS_MODELS.DEFAULT,
    models: FIREWORKS_MODELS.OPTIONS,
    supportsImages: false,
    modelDiscovery: 'anthropic-models',
  },
  {
    id: 'fireworks',
    protocol: 'openai-compatible',
    label: 'Fireworks.ai',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    apiKeyPlaceholder: 'Fireworks.ai API key',
    apiKeyRequired: true,
    defaultModel: FIREWORKS_MODELS.DEFAULT,
    models: FIREWORKS_MODELS.OPTIONS,
    supportsImages: false,
    capabilities: { chatCompletions: true, responses: true },
    modelDiscovery: 'openai-models',
  },
  {
    id: 'gemini',
    protocol: 'openai-compatible',
    label: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyPlaceholder: 'Gemini API key',
    apiKeyRequired: true,
    defaultModel: GEMINI_MODELS.DEFAULT,
    models: GEMINI_MODELS.OPTIONS,
    supportsImages: true,
    capabilities: { chatCompletions: true, responses: false },
    modelDiscovery: 'openai-models',
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
    modelDiscovery: 'ollama-tags',
  },
  {
    id: 'ollama',
    protocol: 'openai-compatible',
    label: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    apiKeyPlaceholder: 'Leave blank for local Ollama',
    apiKeyRequired: false,
    defaultModel: 'llama3',
    models: [{ value: 'llama3', label: 'llama3 (local)', isLocal: true }],
    supportsImages: false,
    capabilities: { chatCompletions: true, responses: true },
    modelDiscovery: 'ollama-tags',
  },
  {
    id: 'openrouter',
    protocol: 'openai-compatible',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyPlaceholder: 'OpenRouter API key',
    apiKeyRequired: true,
    defaultModel: OPENROUTER_MODELS.DEFAULT,
    models: OPENROUTER_MODELS.OPTIONS,
    supportsImages: true,
    capabilities: { chatCompletions: true, responses: true },
    modelDiscovery: 'openrouter-models',
    managedHeaders: 'openrouter',
  },
  {
    id: 'together',
    protocol: 'openai-compatible',
    label: 'Together.ai',
    baseUrl: 'https://api.together.ai/v1',
    apiKeyPlaceholder: 'Together.ai API key',
    apiKeyRequired: true,
    defaultModel: TOGETHER_MODELS.DEFAULT,
    models: TOGETHER_MODELS.OPTIONS,
    supportsImages: false,
    capabilities: { chatCompletions: true, responses: false },
    modelDiscovery: 'openai-models',
  },
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
    modelDiscovery: 'none',
  },
  {
    id: 'zai',
    protocol: 'openai-compatible',
    label: 'Z.AI',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    apiKeyPlaceholder: 'Z.AI API key',
    apiKeyRequired: true,
    defaultModel: ZAI_MODELS.DEFAULT,
    models: ZAI_MODELS.OPTIONS,
    supportsImages: false,
    capabilities: { chatCompletions: true, responses: false },
    modelDiscovery: 'none',
  },
] as const satisfies readonly ApiProviderTemplate[];

export function templatesForProtocol(protocol: ApiProtocol): readonly ApiProviderTemplate[] {
  return API_PROVIDER_TEMPLATES
    .filter((template) => template.protocol === protocol)
    .sort(compareTemplatesForMenu);
}

export function apiProviderTemplate(
  protocol: ApiProtocol,
  templateId: ApiProviderTemplateId,
): ApiProviderTemplate | null {
  return API_PROVIDER_TEMPLATES.find((template) =>
    template.protocol === protocol && template.id === templateId
  ) ?? null;
}

function compareTemplatesForMenu(left: ApiProviderTemplate, right: ApiProviderTemplate): number {
  const leftIsCustom = left.id === 'custom';
  const rightIsCustom = right.id === 'custom';
  if (leftIsCustom || rightIsCustom) {
    return leftIsCustom === rightIsCustom ? 0 : leftIsCustom ? 1 : -1;
  }
  return left.label.localeCompare(right.label, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}
