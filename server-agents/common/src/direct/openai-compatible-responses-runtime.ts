// Implements Direct over OpenAI-compatible Responses APIs.
// Keeps Responses request/stream parsing separate from chat completions.

import type { SharedModelOption } from '@garcon/common/models';
import type { AgentAttachment } from '@garcon/common/agent-execution';
import {
  DirectChatRuntimeBase,
  type DirectRuntimeSession,
  type DirectUserTurn,
} from "./direct-chat-runtime-base.js";
import type { DirectConversationMessage } from "./session-store.js";
import { readSseDataEvents } from '@garcon/server-agent-common/shared/sse';
import { appendTextAttachmentContext, imageAttachments } from '@garcon/server-agent-common/shared/attachments';
import {
  directSingleQuerySignal,
  directSingleQueryTimeoutMs,
} from './single-query-options.js';
import { resolveDirectExplicitEffort } from './reasoning-effort.js';
import { isJsonResponse } from './response-media-type.js';

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
  images?: readonly AgentAttachment[],
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

export interface ResponsesStreamState {
  text: string;
  errorMessage: string | null;
  terminal: 'completed' | 'failed' | 'incomplete' | null;
}

interface ResponsesStreamEvent {
  type?: string;
  delta?: unknown;
  error?: { message?: unknown };
  response?: {
    error?: { message?: unknown };
    incomplete_details?: { reason?: unknown };
    status_details?: { error?: { message?: unknown } };
  };
}

function responsesFailureMessage(event: ResponsesStreamEvent): string {
  const directMessage = event.response?.error?.message;
  if (typeof directMessage === 'string') return directMessage;

  const compatibleMessage = event.response?.status_details?.error?.message;
  if (typeof compatibleMessage === 'string') return compatibleMessage;

  const incompleteReason = event.response?.incomplete_details?.reason;
  if (typeof incompleteReason === 'string') return incompleteReason;

  return `Responses stream ended with ${event.type ?? 'an unknown failure'}.`;
}

export function consumeResponsesStreamEvent(
  state: ResponsesStreamState,
  event: unknown,
): void {
  if (!event || typeof event !== 'object') return;
  const parsed = event as ResponsesStreamEvent;

  if (parsed.type === 'response.output_text.delta') {
    if (typeof parsed.delta === 'string') state.text += parsed.delta;
    return;
  }

  if (parsed.type === 'response.completed') {
    state.terminal = 'completed';
    return;
  }

  if (parsed.type === 'error') {
    state.errorMessage = typeof parsed.error?.message === 'string'
      ? parsed.error.message
      : 'Responses stream returned an error.';
    return;
  }

  if (parsed.type === 'response.failed' || parsed.type === 'response.incomplete') {
    state.terminal = parsed.type === 'response.failed' ? 'failed' : 'incomplete';
    state.errorMessage = responsesFailureMessage(parsed);
  }
}

async function readOpenAiResponsesResponse(
  response: Response,
  runtimeLabel: string,
): Promise<string> {
  if (isJsonResponse(response)) {
    const data = await response.json() as {
      status?: unknown;
      error?: { message?: unknown };
      incomplete_details?: { reason?: unknown };
      status_details?: { error?: { message?: unknown } };
    };
    const responseError = typeof data.error?.message === 'string'
      ? data.error.message
      : typeof data.status_details?.error?.message === 'string'
        ? data.status_details.error.message
        : null;
    if (data.status === 'failed' || data.status === 'incomplete' || responseError) {
      const detail = responseError
        ?? (typeof data.incomplete_details?.reason === 'string'
          ? data.incomplete_details.reason
          : `Responses API returned status ${data.status}.`);
      throw new Error(`${runtimeLabel} response error: ${detail}`);
    }
    return extractResponsesOutputText(data);
  }

  if (!response.body) {
    throw new Error(`${runtimeLabel} response did not include a stream body.`);
  }

  const state: ResponsesStreamState = {
    text: '',
    errorMessage: null,
    terminal: null,
  };
  await readSseDataEvents(response.body, (data) => {
    try {
      consumeResponsesStreamEvent(state, JSON.parse(data));
    } catch {
      // Skips malformed chunks from partially-compatible providers.
    }
  });

  if (state.errorMessage) {
    throw new Error(`${runtimeLabel} stream error: ${state.errorMessage}`);
  }
  if (state.terminal !== 'completed') {
    throw new Error(`${runtimeLabel} stream ended before response.completed.`);
  }

  return state.text;
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
  const reasoningEffort = resolveDirectExplicitEffort(options.thinkingMode);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), directSingleQueryTimeoutMs(options));

  try {
    const response = await fetch(`${config.getBaseUrl()}/responses`, {
      method: 'POST',
      headers: buildHeaders(config, apiKey),
      body: JSON.stringify({
        model,
        input: [{ role: 'user', content: prompt }],
        stream: true,
        store: false,
        ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
      }),
      signal: directSingleQuerySignal(options, controller.signal),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`${config.runtimeLabel} API error ${response.status}: ${errorText}`);
    }

    return (await readOpenAiResponsesResponse(response, config.runtimeLabel)).trim();
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
    images?: readonly AgentAttachment[],
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
    const reasoningEffort = resolveDirectExplicitEffort(session.thinkingMode);
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
          ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`${this.config.runtimeLabel} API error ${response.status}: ${errorText}`);
      }
      return await readOpenAiResponsesResponse(response, this.config.runtimeLabel);
    } finally {
      clearTimeout(timer);
      session.abortController = null;
    }
  }
}
