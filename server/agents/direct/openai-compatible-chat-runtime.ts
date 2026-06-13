// OpenAI-compatible chat-completions protocol adapter for direct runtimes.

import type { SharedModelOption } from "../../../common/models.js";
import type { AgentCommandImage } from "../session-types.js";
import { readSseDataEvents } from "../shared/sse.js";
import {
  DirectChatRuntimeBase,
  type DirectRuntimeSession,
  type DirectUserTurn,
} from "./direct-chat-runtime-base.js";
import type { DirectConversationMessage } from "./session-store.js";
import { createLogger } from '../../lib/log.js';

const logger = createLogger('agents:direct:openai-compatible-chat-runtime');

const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const STREAM_TIMEOUT_MS = 5 * 60_000;

interface OpenAiCompatibleContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
}

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string | OpenAiCompatibleContentPart[];
}

interface ModelFetchContext {
  apiKey: string;
  baseUrl: string;
  requestTimeoutMs: number;
  fallbackModels: SharedModelOption[];
}

export interface OpenAiCompatibleChatRuntimeConfig {
  runtimeId: string;
  runtimeLabel: string;
  defaultModel: string;
  fallbackModels: SharedModelOption[];
  getApiKey: () => string;
  getBaseUrl: () => string;
  getSessionDir: () => string;
  getSessionFilePath: (sessionId: string) => string;
  buildHeaders?: (apiKey: string) => Record<string, string>;
  fetchModels?: (ctx: ModelFetchContext) => Promise<SharedModelOption[]>;
}

function buildHeaders(config: OpenAiCompatibleChatRuntimeConfig, apiKey: string): Record<string, string> {
  return config.buildHeaders?.(apiKey) ?? {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

function appendDeltaText(accumulated: string, delta: unknown): string {
  if (typeof delta === 'string') {
    return accumulated + delta;
  }
  if (!Array.isArray(delta)) {
    return accumulated;
  }
  return accumulated + delta
    .filter((part) => part && typeof part === 'object')
    .map((part) => {
      const maybe = part as { text?: unknown };
      return typeof maybe.text === 'string' ? maybe.text : '';
    })
    .join('');
}

export function buildOpenAiCompatibleUserContent(
  text: string,
  images?: AgentCommandImage[],
): string | OpenAiCompatibleContentPart[] {
  if (!images?.length) return text;

  const parts: OpenAiCompatibleContentPart[] = [{ type: 'text', text }];
  for (const image of images) {
    if (!image.data) continue;
    parts.push({ type: 'image_url', image_url: { url: image.data } });
  }
  return parts;
}

export function extractOpenAiCompatibleTextContent(content: ConversationMessage['content']): string {
  if (typeof content === 'string') return content;

  return content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text!)
    .join('\n');
}

function persistedToOpenAiMessage(message: DirectConversationMessage): ConversationMessage {
  return {
    role: message.role,
    content: message.content,
  };
}

export async function runOpenAiCompatibleSingleQuery(
  config: OpenAiCompatibleChatRuntimeConfig,
  prompt: string,
  options: Record<string, unknown> = {},
): Promise<string> {
  const apiKey = config.getApiKey();
  const model = typeof options.model === 'string' && options.model
    ? options.model
    : config.defaultModel;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${config.getBaseUrl()}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(config, apiKey),
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`${config.runtimeLabel} API error ${response.status}: ${errorText}`);
    }

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content?.trim() || '';
  } finally {
    clearTimeout(timer);
  }
}

export class OpenAiCompatibleChatRuntime extends DirectChatRuntimeBase<
  ConversationMessage,
  OpenAiCompatibleChatRuntimeConfig
> {
  #modelCache: SharedModelOption[] | null = null;
  #modelCacheTime = 0;
  #modelFetchPromise: Promise<SharedModelOption[]> | null = null;

  constructor(config: OpenAiCompatibleChatRuntimeConfig) {
    super(config);
  }

  protected buildUserTurn(
    command: string,
    images?: AgentCommandImage[],
  ): DirectUserTurn<ConversationMessage> {
    const content = buildOpenAiCompatibleUserContent(command, images);
    return {
      message: { role: 'user', content },
      persistedContent: extractOpenAiCompatibleTextContent(content),
    };
  }

  protected buildAssistantMessage(content: string): ConversationMessage {
    return { role: 'assistant', content };
  }

  protected persistedToMessage(message: DirectConversationMessage): ConversationMessage {
    return persistedToOpenAiMessage(message);
  }

  protected async streamSession(session: DirectRuntimeSession<ConversationMessage>): Promise<string> {
    const apiKey = this.config.getApiKey();
    const abortController = new AbortController();
    session.abortController = abortController;

    const streamTimer = setTimeout(() => abortController.abort(), STREAM_TIMEOUT_MS);

    try {
      const response = await fetch(`${this.config.getBaseUrl()}/chat/completions`, {
        method: 'POST',
        headers: buildHeaders(this.config, apiKey),
        body: JSON.stringify({
          model: session.model,
          messages: session.messages,
          stream: true,
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`${this.config.runtimeLabel} API error ${response.status}: ${errorText}`);
      }
      if (!response.body) {
        throw new Error(`${this.config.runtimeLabel} response did not include a stream body.`);
      }

      let accumulated = '';
      let lastStreamError = '';

      await readSseDataEvents(response.body, (data) => {
        if (data === '[DONE]') return;

        try {
          const parsed = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: unknown } }>;
            error?: { message?: string };
          };
          if (parsed.error?.message) {
            lastStreamError = parsed.error.message;
            return;
          }
          accumulated = appendDeltaText(accumulated, parsed.choices?.[0]?.delta?.content);
        } catch {
          // Skips malformed chunks.
        }
      });

      if (!accumulated.trim() && lastStreamError) {
        throw new Error(`${this.config.runtimeLabel} stream error: ${lastStreamError}`);
      }

      return accumulated;
    } finally {
      clearTimeout(streamTimer);
      session.abortController = null;
    }
  }

  override async getModels(): Promise<SharedModelOption[]> {
    if (!this.config.fetchModels) {
      return this.config.fallbackModels;
    }

    if (this.#modelCache && Date.now() - this.#modelCacheTime < MODEL_CACHE_TTL_MS) {
      return this.#modelCache;
    }

    if (this.#modelFetchPromise) {
      return this.#modelFetchPromise;
    }

    this.#modelFetchPromise = this.#fetchModels();
    try {
      return await this.#modelFetchPromise;
    } finally {
      this.#modelFetchPromise = null;
    }
  }

  async #fetchModels(): Promise<SharedModelOption[]> {
    const apiKey = this.config.getApiKey();
    if (!apiKey) {
      return this.config.fallbackModels;
    }

    try {
      const models = await this.config.fetchModels!({
        apiKey,
        baseUrl: this.config.getBaseUrl(),
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
        fallbackModels: this.config.fallbackModels,
      });
      if (models.length > 0) {
        this.#modelCache = models;
        this.#modelCacheTime = Date.now();
        return models;
      }
    } catch (error) {
      logger.warn(`${this.config.runtimeId}: model fetch failed:`, error instanceof Error ? error.message : error);
    }

    return this.config.fallbackModels;
  }
}
