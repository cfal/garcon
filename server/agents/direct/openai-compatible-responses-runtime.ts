// Implements Direct over OpenAI-compatible Responses APIs.
// Keeps Responses request/stream parsing separate from chat completions.

import type { SharedModelOption } from "../../../common/models.js";
import type { AgentCommandImage } from "../session-types.js";
import {
  DirectChatRuntimeBase,
  type DirectRuntimeSession,
  type DirectUserTurn,
} from "./direct-chat-runtime-base.js";
import type { DirectConversationMessage } from "./session-store.js";
import { readSseDataEvents } from "../shared/sse.js";
import { appendTextAttachmentContext, imageAttachments } from '../shared/attachments.js';
import { directSingleQueryEffort, directSingleQueryTimeoutMs } from './single-query-options.js';

const STREAM_TIMEOUT_MS = 5 * 60_000;

interface ResponsesInputText {
  type: 'input_text';
  text: string;
}

interface ResponsesInputImage {
  type: 'input_image';
  image_url: string;
  detail?: 'auto' | 'low' | 'high';
}

type ResponsesInputContent = string | Array<ResponsesInputText | ResponsesInputImage>;

interface ResponsesInputMessage {
  role: 'user' | 'assistant';
  content: ResponsesInputContent;
}

export interface OpenAiCompatibleResponsesRuntimeConfig {
  runtimeId: string;
  runtimeLabel: string;
  defaultModel: string;
  fallbackModels: SharedModelOption[];
  getApiKey: () => string;
  getBaseUrl: () => string;
  getSessionDir: () => string;
  getSessionFilePath: (sessionId: string) => string;
  buildHeaders?: (apiKey: string) => Record<string, string>;
}

function buildHeaders(
  config: OpenAiCompatibleResponsesRuntimeConfig,
  apiKey: string,
): Record<string, string> {
  return config.buildHeaders?.(apiKey) ?? {
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    'Content-Type': 'application/json',
  };
}

export function buildOpenAiResponsesUserContent(
  text: string,
  images?: AgentCommandImage[],
): ResponsesInputContent {
  const prompt = appendTextAttachmentContext(text, images);
  const imageParts = imageAttachments(images);
  if (!imageParts.length) return prompt;

  const parts: Array<ResponsesInputText | ResponsesInputImage> = [
    { type: 'input_text', text: prompt },
  ];
  for (const image of imageParts) {
    if (!image.data) continue;
    parts.push({
      type: 'input_image',
      image_url: image.data,
      detail: 'auto',
    });
  }
  return parts;
}

export function extractOpenAiResponsesTextContent(content: ResponsesInputContent): string {
  if (typeof content === 'string') return content;
  return content
    .filter((part): part is ResponsesInputText => part.type === 'input_text')
    .map((part) => part.text)
    .join('\n');
}

function persistedToResponsesMessage(message: DirectConversationMessage): ResponsesInputMessage {
  return {
    role: message.role,
    content: message.content,
  };
}

interface ResponsesOutputTextPart {
  type: 'output_text';
  text?: string;
}

interface ResponsesOutputMessage {
  type?: string;
  content?: ResponsesOutputTextPart[];
}

export function extractResponsesOutputText(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const response = data as {
    output_text?: unknown;
    output?: unknown;
  };

  if (typeof response.output_text === 'string') {
    return response.output_text.trim();
  }

  if (!Array.isArray(response.output)) return '';
  return response.output
    .filter((item): item is ResponsesOutputMessage => Boolean(item) && typeof item === 'object')
    .flatMap((item) => Array.isArray(item.content) ? item.content : [])
    .filter((part): part is ResponsesOutputTextPart => part?.type === 'output_text')
    .map((part) => typeof part.text === 'string' ? part.text : '')
    .join('')
    .trim();
}

export function applyResponsesStreamEvent(accumulated: string, event: unknown): {
  text: string;
  error?: string;
} {
  if (!event || typeof event !== 'object') return { text: accumulated };
  const parsed = event as {
    type?: string;
    delta?: unknown;
    error?: { message?: unknown };
    response?: { status_details?: { error?: { message?: unknown } } };
  };

  if (parsed.type === 'response.output_text.delta') {
    return {
      text: accumulated + (typeof parsed.delta === 'string' ? parsed.delta : ''),
    };
  }

  if (parsed.type === 'error') {
    return {
      text: accumulated,
      error: typeof parsed.error?.message === 'string'
        ? parsed.error.message
        : 'Responses stream returned an error.',
    };
  }

  if (parsed.type === 'response.failed' || parsed.type === 'response.incomplete') {
    return {
      text: accumulated,
      error: typeof parsed.response?.status_details?.error?.message === 'string'
        ? parsed.response.status_details.error.message
        : `Responses stream ended with ${parsed.type}.`,
    };
  }

  return { text: accumulated };
}

export async function runOpenAiResponsesSingleQuery(
  config: OpenAiCompatibleResponsesRuntimeConfig,
  prompt: string,
  options: Record<string, unknown> = {},
): Promise<string> {
  const apiKey = config.getApiKey();
  const model = typeof options.model === 'string' && options.model
    ? options.model
    : config.defaultModel;
  const reasoningEffort = directSingleQueryEffort(options);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), directSingleQueryTimeoutMs(options));

  try {
    const response = await fetch(`${config.getBaseUrl()}/responses`, {
      method: 'POST',
      headers: buildHeaders(config, apiKey),
      body: JSON.stringify({
        model,
        input: [{ role: 'user', content: prompt }],
        store: false,
        ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`${config.runtimeLabel} Responses API error ${response.status}: ${errorText}`);
    }

    return extractResponsesOutputText(await response.json());
  } finally {
    clearTimeout(timer);
  }
}

export class OpenAiCompatibleResponsesRuntime extends DirectChatRuntimeBase<
  ResponsesInputMessage,
  OpenAiCompatibleResponsesRuntimeConfig
> {
  constructor(config: OpenAiCompatibleResponsesRuntimeConfig) {
    super(config);
  }

  protected buildUserTurn(
    command: string,
    images?: AgentCommandImage[],
  ): DirectUserTurn<ResponsesInputMessage> {
    const content = buildOpenAiResponsesUserContent(command, images);
    return {
      message: { role: 'user', content },
      persistedContent: extractOpenAiResponsesTextContent(content),
    };
  }

  protected buildAssistantMessage(content: string): ResponsesInputMessage {
    return { role: 'assistant', content };
  }

  protected persistedToMessage(message: DirectConversationMessage): ResponsesInputMessage {
    return persistedToResponsesMessage(message);
  }

  protected async streamSession(session: DirectRuntimeSession<ResponsesInputMessage>): Promise<string> {
    const apiKey = this.config.getApiKey();
    const abortController = new AbortController();
    session.abortController = abortController;
    const timer = setTimeout(() => abortController.abort(), STREAM_TIMEOUT_MS);

    try {
      const response = await fetch(`${this.config.getBaseUrl()}/responses`, {
        method: 'POST',
        headers: buildHeaders(this.config, apiKey),
        body: JSON.stringify({
          model: session.model,
          input: session.messages,
          stream: true,
          store: false,
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`${this.config.runtimeLabel} Responses API error ${response.status}: ${errorText}`);
      }
      if (!response.body) {
        throw new Error(`${this.config.runtimeLabel} response did not include a stream body.`);
      }

      let accumulated = '';
      let streamError = '';
      await readSseDataEvents(response.body, (data) => {
        try {
          const result = applyResponsesStreamEvent(accumulated, JSON.parse(data));
          accumulated = result.text;
          if (result.error) streamError = result.error;
        } catch {
          // Skips malformed chunks from partially-compatible providers.
        }
      });

      if (!accumulated.trim() && streamError) {
        throw new Error(`${this.config.runtimeLabel} Responses stream error: ${streamError}`);
      }
      return accumulated;
    } finally {
      clearTimeout(timer);
      session.abortController = null;
    }
  }
}
