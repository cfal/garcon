import { OPENROUTER_MODELS, type SharedModelOption } from '../../common/models.js';
import {
  OpenAiCompatibleChatProvider,
  type OpenAiCompatibleChatProviderConfig,
  runOpenAiCompatibleSingleQuery,
} from './openai-compatible-chat-provider.js';
import { getSessionDir, getSessionFilePath } from './openrouter-paths.js';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

function getApiKey(): string {
  return process.env.OPENROUTER_API_KEY || '';
}

function makeHeaders(apiKey: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://github.com/cfal/garcon',
    'X-Title': 'Garcon',
  };
}

async function fetchOpenRouterModels({
  apiKey,
  baseUrl,
  requestTimeoutMs,
  fallbackModels,
}: {
  apiKey: string;
  baseUrl: string;
  requestTimeoutMs: number;
  fallbackModels: SharedModelOption[];
}): Promise<SharedModelOption[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!response.ok) return fallbackModels;

    const data = await response.json() as {
      data?: Array<{
        id: string;
        name?: string;
        architecture?: { modality?: string };
      }>;
    };
    if (!Array.isArray(data.data)) return fallbackModels;

    const models = data.data
      .filter((model) => model.id && model.name)
      .map((model) => ({
        value: model.id,
        label: model.name!,
        supportsImages: model.architecture?.modality?.includes('image') ?? false,
      }));

    return models.length > 0 ? models : fallbackModels;
  } finally {
    clearTimeout(timer);
  }
}

const OPENROUTER_CONFIG: OpenAiCompatibleChatProviderConfig = {
  providerId: 'openrouter',
  providerLabel: 'OpenRouter',
  apiKeyEnvVar: 'OPENROUTER_API_KEY',
  defaultModel: OPENROUTER_MODELS.DEFAULT,
  fallbackModels: OPENROUTER_MODELS.OPTIONS,
  getApiKey,
  getBaseUrl: () => OPENROUTER_BASE_URL,
  getSessionDir,
  getSessionFilePath,
  buildHeaders: makeHeaders,
  fetchModels: fetchOpenRouterModels,
};

export async function runSingleQuery(prompt: string, options: Record<string, unknown> = {}): Promise<string> {
  return runOpenAiCompatibleSingleQuery(OPENROUTER_CONFIG, prompt, options);
}

export class OpenRouterProvider extends OpenAiCompatibleChatProvider {
  constructor() {
    super(OPENROUTER_CONFIG);
  }
}
