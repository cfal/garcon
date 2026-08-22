// OpenAI-compatible chat-completions protocol adapter for direct runtimes.

import type { AgentAttachment } from '@garcon/common/agent-execution';
import { readSseDataEvents } from '@garcon/server-agent-common/shared/sse';
import {
  DirectChatRuntimeBase,
  type DirectChatRuntimeBaseConfig,
  type DirectRuntimeSession,
} from "./direct-chat-runtime-base.js";
import { appendTextAttachmentContext, imageAttachments } from '@garcon/server-agent-common/shared/attachments';
import {
  directSingleQuerySignal,
  directSingleQueryTimeoutMs,
} from './single-query-options.js';
import { resolveDirectExplicitEffort } from './reasoning-effort.js';
import { isJsonResponse } from './response-media-type.js';
import { stripThinkBlocks } from './strip-think-blocks.js';

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

export interface OpenAiCompatibleChatRuntimeConfig extends DirectChatRuntimeBaseConfig {
  getApiKey: () => string;
  getBaseUrl: () => string;
  buildHeaders?: (apiKey: string) => Record<string, string>;
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
  images?: readonly AgentAttachment[],
): string | OpenAiCompatibleContentPart[] {
  const prompt = appendTextAttachmentContext(text, images);
  const imageParts = imageAttachments(images);
  if (!imageParts.length) return prompt;

  const parts: OpenAiCompatibleContentPart[] = [{ type: 'text', text: prompt }];
  for (const image of imageParts) {
    if (!image.data) continue;
    parts.push({ type: 'image_url', image_url: { url: image.data } });
  }
  return parts;
}

async function readOpenAiCompatibleTextStream(
  response: Response,
  runtimeLabel: string,
): Promise<string> {
  if (!response.body) {
    throw new Error(`${runtimeLabel} response did not include a stream body.`);
  }

  let accumulated = '';
  let lastStreamError = '';
  let sawDone = false;

  await readSseDataEvents(response.body, (data) => {
    if (data === '[DONE]') {
      sawDone = true;
      return;
    }

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
      // Skips malformed chunks from partially-compatible providers.
    }
  });

  if (lastStreamError) {
    throw new Error(`${runtimeLabel} stream error: ${lastStreamError}`);
  }
  if (!sawDone) {
    throw new Error(`${runtimeLabel} stream ended before [DONE]`);
  }

  return accumulated;
}

async function readOpenAiCompatibleResponse(
  response: Response,
  runtimeLabel: string,
): Promise<string> {
  let text: string;
  if (!isJsonResponse(response)) {
    text = await readOpenAiCompatibleTextStream(response, runtimeLabel);
  } else {
    const parsed = await response.json() as {
      choices?: Array<{ message?: { content?: unknown } }>;
      error?: { message?: string };
    };
    if (parsed.error?.message) {
      throw new Error(`${runtimeLabel} response error: ${parsed.error.message}`);
    }
    text = appendDeltaText('', parsed.choices?.[0]?.message?.content);
  }

  return stripThinkBlocks(text);
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
  const reasoningEffort = resolveDirectExplicitEffort(options.thinkingMode);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), directSingleQueryTimeoutMs(options));

  try {
    const response = await fetch(`${config.getBaseUrl()}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(config, apiKey),
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        stream: true,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      }),
      signal: directSingleQuerySignal(options, controller.signal),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`${config.runtimeLabel} API error ${response.status}: ${errorText}`);
    }

    return await readOpenAiCompatibleResponse(response, config.runtimeLabel);
  } finally {
    clearTimeout(timer);
  }
}

export class OpenAiCompatibleChatRuntime extends DirectChatRuntimeBase<
  ConversationMessage,
  OpenAiCompatibleChatRuntimeConfig
> {
  constructor(config: OpenAiCompatibleChatRuntimeConfig) {
    super(config);
  }

  protected buildUserMessage(
    command: string,
    images?: readonly AgentAttachment[],
  ): ConversationMessage {
    const content = buildOpenAiCompatibleUserContent(command, images);
    return { role: 'user', content };
  }

  protected buildAssistantMessage(content: string): ConversationMessage {
    return { role: 'assistant', content };
  }

  protected async streamSession(session: DirectRuntimeSession<ConversationMessage>): Promise<string> {
    const apiKey = this.config.getApiKey();
    const reasoningEffort = resolveDirectExplicitEffort(session.thinkingMode);
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
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`${this.config.runtimeLabel} API error ${response.status}: ${errorText}`);
      }
      return await readOpenAiCompatibleResponse(response, this.config.runtimeLabel);
    } finally {
      clearTimeout(streamTimer);
      session.abortController = null;
    }
  }

}
