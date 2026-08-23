// Implements Direct over OpenAI-compatible Responses APIs.
// Keeps Responses request/stream parsing separate from chat completions.

import type { AgentAttachment } from '@garcon/common/agent-execution';
import {
  DirectChatRuntimeBase,
  type DirectChatRuntimeBaseConfig,
  type DirectRuntimeSession,
  type DirectTurnCompletion,
} from "./direct-chat-runtime-base.js";
import { appendTextAttachmentContext, imageAttachments } from '@garcon/server-agent-common/shared/attachments';
import {
  directSingleQuerySignal,
  directSingleQueryTimeoutMs,
} from './single-query-options.js';
import { resolveDirectExplicitEffort } from './reasoning-effort.js';
import {
  isUnresolvedCheckpoint,
  readOpenAiResponsesResponse,
  throwResponsesHttpError,
  type ResponsesCompletion,
} from './openai-compatible-responses-protocol.js';
import type { DirectResponsesCheckpointV1 } from './session-store.js';

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

export interface OpenAiCompatibleResponsesRuntimeConfig extends DirectChatRuntimeBaseConfig {
  endpointId: string;
  endpointFingerprint: string;
  getApiKey: () => string;
  getBaseUrl: () => string;
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
      await throwResponsesHttpError(response, config.runtimeLabel);
    }

    return (await readOpenAiResponsesResponse(response, config.runtimeLabel)).text;
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

  protected buildUserMessage(
    command: string,
    images?: readonly AgentAttachment[],
  ): ResponsesInputMessage {
    const content = buildOpenAiResponsesUserContent(command, images);
    return { role: 'user', content };
  }

  protected buildAssistantMessage(content: string): ResponsesInputMessage {
    return { role: 'assistant', content };
  }

  protected async streamSession(
    session: DirectRuntimeSession<ResponsesInputMessage>,
  ): Promise<DirectTurnCompletion> {
    const apiKey = this.config.getApiKey();
    const reasoningEffort = resolveDirectExplicitEffort(session.thinkingMode);
    const abortController = new AbortController();
    session.abortController = abortController;
    const timer = setTimeout(() => abortController.abort(), STREAM_TIMEOUT_MS);

    try {
      const checkpoint = compatibleCheckpoint(session, this.config);
      const currentInput = session.messages.at(-1);
      if (!currentInput || currentInput.role !== 'user') {
        throw new Error(`${this.config.runtimeLabel} session is missing its current user input.`);
      }
      let completion: ResponsesCompletion;
      try {
        completion = await this.#request(
          session,
          checkpoint ? [currentInput] : session.messages,
          checkpoint?.responseId ?? null,
          apiKey,
          reasoningEffort,
          abortController.signal,
        );
      } catch (error) {
        if (!checkpoint || !isUnresolvedCheckpoint(error)) throw error;
        completion = await this.#request(
          session,
          session.messages,
          null,
          apiKey,
          reasoningEffort,
          abortController.signal,
        );
      }

      return {
        content: completion.text,
        checkpoint: completion.responseId
          ? {
              kind: 'openai-response',
              responseId: completion.responseId,
              endpointId: this.config.endpointId,
              endpointFingerprint: this.config.endpointFingerprint,
              model: session.model,
            }
          : null,
      };
    } finally {
      clearTimeout(timer);
      session.abortController = null;
    }
  }

  async #request(
    session: DirectRuntimeSession<ResponsesInputMessage>,
    input: readonly ResponsesInputMessage[],
    previousResponseId: string | null,
    apiKey: string,
    reasoningEffort: ReturnType<typeof resolveDirectExplicitEffort>,
    signal: AbortSignal,
  ): Promise<ResponsesCompletion> {
    const response = await fetch(`${this.config.getBaseUrl()}/responses`, {
      method: 'POST',
      headers: buildHeaders(this.config, apiKey),
      body: JSON.stringify({
        model: session.model,
        input,
        previous_response_id: previousResponseId,
        stream: true,
        store: true,
        ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
      }),
      signal,
    });

    if (!response.ok) {
      await throwResponsesHttpError(response, this.config.runtimeLabel);
    }
    return await readOpenAiResponsesResponse(response, this.config.runtimeLabel);
  }
}

function compatibleCheckpoint(
  session: DirectRuntimeSession<ResponsesInputMessage>,
  config: OpenAiCompatibleResponsesRuntimeConfig,
): DirectResponsesCheckpointV1 | null {
  const previous = session.history.at(-2);
  if (!previous || previous.type !== 'assistant') return null;
  const checkpoint = previous.checkpoint;
  if (
    checkpoint?.kind !== 'openai-response'
    || checkpoint.endpointId !== config.endpointId
    || checkpoint.endpointFingerprint !== config.endpointFingerprint
    || checkpoint.model !== session.model
  ) {
    return null;
  }
  return checkpoint;
}
