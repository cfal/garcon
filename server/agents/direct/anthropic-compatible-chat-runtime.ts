// Anthropic-compatible Messages protocol adapter for direct runtimes.

import type { SharedModelOption } from "../../../common/models.js";
import type { AgentCommandImage } from "../session-types.js";
import {
  DirectChatRuntimeBase,
  type DirectRuntimeSession,
  type DirectUserTurn,
} from "./direct-chat-runtime-base.js";
import type { DirectConversationMessage } from "./session-store.js";
import { readSseDataEvents } from "../shared/sse.js";

const REQUEST_TIMEOUT_MS = 30_000;
const STREAM_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_TOKENS = 4096;
const ANTHROPIC_VERSION = '2023-06-01';

interface AnthropicTextContentBlock {
  type: 'text';
  text: string;
}

interface AnthropicImageContentBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

type AnthropicContent = string | Array<AnthropicTextContentBlock | AnthropicImageContentBlock>;

interface AnthropicConversationMessage {
  role: 'user' | 'assistant';
  content: AnthropicContent;
}

export interface AnthropicCompatibleChatRuntimeConfig {
  runtimeId: string;
  runtimeLabel: string;
  defaultModel: string;
  fallbackModels: SharedModelOption[];
  getApiKey: () => string;
  getBaseUrl: () => string;
  getSessionDir: () => string;
  getSessionFilePath: (sessionId: string) => string;
  maxTokens?: number;
}

function appendPath(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`;
}

export function anthropicMessagesUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  return normalized.endsWith('/v1')
    ? appendPath(normalized, '/messages')
    : appendPath(normalized, '/v1/messages');
}

export function buildAnthropicCompatibleHeaders(apiKey: string): Record<string, string> {
  return {
    ...(apiKey ? { 'x-api-key': apiKey } : {}),
    'anthropic-version': ANTHROPIC_VERSION,
    'content-type': 'application/json',
  };
}

export function buildAnthropicCompatibleUserContent(
  text: string,
  images?: AgentCommandImage[],
): AnthropicContent {
  if (!images?.length) return text;

  const blocks: Array<AnthropicTextContentBlock | AnthropicImageContentBlock> = [];
  for (const image of images) {
    const match = image.data?.match?.(/^data:([^;]+);base64,(.+)$/);
    if (!match) continue;
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: match[1],
        data: match[2],
      },
    });
  }

  blocks.push({ type: 'text', text });
  return blocks;
}

export function extractAnthropicTextContent(content: AnthropicContent): string {
  if (typeof content === 'string') return content;
  return content
    .filter((part): part is AnthropicTextContentBlock => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function persistedToAnthropicMessage(message: DirectConversationMessage): AnthropicConversationMessage {
  return {
    role: message.role,
    content: message.content,
  };
}

function appendAnthropicDelta(accumulated: string, data: string): {
  accumulated: string;
  errorMessage: string | null;
} {
  try {
    const parsed = JSON.parse(data) as {
      type?: string;
      delta?: { type?: string; text?: string };
      error?: { message?: string };
    };

    if (parsed.type === 'error' && parsed.error?.message) {
      return { accumulated, errorMessage: parsed.error.message };
    }

    if (
      parsed.type === 'content_block_delta'
      && parsed.delta?.type === 'text_delta'
      && typeof parsed.delta.text === 'string'
    ) {
      return { accumulated: accumulated + parsed.delta.text, errorMessage: null };
    }
  } catch {
    return { accumulated, errorMessage: null };
  }

  return { accumulated, errorMessage: null };
}

export async function runAnthropicCompatibleSingleQuery(
  config: AnthropicCompatibleChatRuntimeConfig,
  prompt: string,
  options: Record<string, unknown> = {},
): Promise<string> {
  const model = typeof options.model === 'string' && options.model
    ? options.model
    : config.defaultModel;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(anthropicMessagesUrl(config.getBaseUrl()), {
      method: 'POST',
      headers: buildAnthropicCompatibleHeaders(config.getApiKey()),
      body: JSON.stringify({
        model,
        max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`${config.runtimeLabel} API error ${response.status}: ${errorText}`);
    }

    const data = await response.json() as {
      content?: Array<{ type?: string; text?: string }>;
    };
    return (data.content ?? [])
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('')
      .trim();
  } finally {
    clearTimeout(timer);
  }
}

export class AnthropicCompatibleChatRuntime extends DirectChatRuntimeBase<
  AnthropicConversationMessage,
  AnthropicCompatibleChatRuntimeConfig
> {
  constructor(config: AnthropicCompatibleChatRuntimeConfig) {
    super(config);
  }

  protected buildUserTurn(
    command: string,
    images?: AgentCommandImage[],
  ): DirectUserTurn<AnthropicConversationMessage> {
    const content = buildAnthropicCompatibleUserContent(command, images);
    return {
      message: { role: 'user', content },
      persistedContent: extractAnthropicTextContent(content),
    };
  }

  protected buildAssistantMessage(content: string): AnthropicConversationMessage {
    return { role: 'assistant', content };
  }

  protected persistedToMessage(message: DirectConversationMessage): AnthropicConversationMessage {
    return persistedToAnthropicMessage(message);
  }

  protected async streamSession(session: DirectRuntimeSession<AnthropicConversationMessage>): Promise<string> {
    const abortController = new AbortController();
    session.abortController = abortController;
    const streamTimer = setTimeout(() => abortController.abort(), STREAM_TIMEOUT_MS);

    try {
      const response = await fetch(anthropicMessagesUrl(this.config.getBaseUrl()), {
        method: 'POST',
        headers: buildAnthropicCompatibleHeaders(this.config.getApiKey()),
        body: JSON.stringify({
          model: session.model,
          max_tokens: this.config.maxTokens ?? DEFAULT_MAX_TOKENS,
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
        const result = appendAnthropicDelta(accumulated, data);
        accumulated = result.accumulated;
        if (result.errorMessage) lastStreamError = result.errorMessage;
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
}
