import { ZAI_MODELS } from '../../common/models.js';
import {
  OpenAiCompatibleChatProvider,
  type OpenAiCompatibleChatProviderConfig,
  runOpenAiCompatibleSingleQuery,
} from './openai-compatible-chat-provider.js';
import { getSessionDir, getSessionFilePath } from './zai-paths.js';

const DEFAULT_ZAI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4';

function getApiKey(): string {
  return process.env.ZAI_API_KEY || '';
}

function getBaseUrl(): string {
  const configured = process.env.ZAI_BASE_URL?.trim();
  return configured || DEFAULT_ZAI_BASE_URL;
}

const ZAI_CONFIG: OpenAiCompatibleChatProviderConfig = {
  providerId: 'zai',
  providerLabel: 'Z.AI',
  apiKeyEnvVar: 'ZAI_API_KEY',
  defaultModel: ZAI_MODELS.DEFAULT,
  fallbackModels: ZAI_MODELS.OPTIONS,
  getApiKey,
  getBaseUrl,
  getSessionDir,
  getSessionFilePath,
};

export async function runSingleQuery(prompt: string, options: Record<string, unknown> = {}): Promise<string> {
  return runOpenAiCompatibleSingleQuery(ZAI_CONFIG, prompt, options);
}

export class ZaiProvider extends OpenAiCompatibleChatProvider {
  constructor() {
    super(ZAI_CONFIG);
  }
}
