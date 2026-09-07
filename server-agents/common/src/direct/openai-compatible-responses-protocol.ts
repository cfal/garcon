import { readSseDataEvents } from '@garcon/server-agent-common/shared/sse';
import { isJsonResponse } from './response-media-type.js';
import { stripThinkBlocks } from './strip-think-blocks.js';

export const PREVIOUS_RESPONSE_NOT_FOUND = 'previous_response_not_found';

interface ResponsesOutputTextPart {
  type: 'output_text';
  text?: string;
}

interface ResponsesOutputMessage {
  type?: string;
  content?: ResponsesOutputTextPart[];
}

interface ResponsesFailureFields {
  error?: { code?: unknown; message?: unknown };
  incomplete_details?: { reason?: unknown };
  status_details?: { error?: { code?: unknown; message?: unknown } };
}

interface ResponsesJsonBody extends ResponsesFailureFields {
  id?: unknown;
  status?: unknown;
}

export interface ResponsesCompletion {
  readonly text: string;
  readonly responseId: string | null;
}

export interface ResponsesStreamState {
  text: string;
  errorMessage: string | null;
  errorCode: string | null;
  outputAccepted: boolean;
  responseId: string | null;
  terminal: 'completed' | 'failed' | 'incomplete' | null;
}

interface ResponsesStreamEvent {
  type?: string;
  delta?: unknown;
  error?: { code?: unknown; message?: unknown };
  response?: ResponsesFailureFields & { id?: unknown };
}

export class ResponsesRequestError extends Error {
  constructor(
    message: string,
    readonly responseCode: string | null,
    readonly outputAccepted: boolean,
  ) {
    super(message);
    this.name = 'ResponsesRequestError';
  }
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

function hasResponsesOutputText(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const response = data as { output_text?: unknown; output?: unknown };
  if (typeof response.output_text === 'string') return response.output_text.length > 0;
  if (!Array.isArray(response.output)) return false;
  return response.output.some((item) => (
    item
    && typeof item === 'object'
    && Array.isArray((item as ResponsesOutputMessage).content)
    && (item as ResponsesOutputMessage).content?.some((part) => (
      part?.type === 'output_text'
      && typeof part.text === 'string'
      && part.text.length > 0
    ))
  ));
}

function responsesFailureMessage(event: ResponsesStreamEvent): string {
  return responseErrorMessage(event.response)
    ?? responseIncompleteReason(event.response)
    ?? `Responses stream ended with ${event.type ?? 'an unknown failure'}.`;
}

function responsesFailureCode(event: ResponsesStreamEvent): string | null {
  return responseErrorCode(event.response);
}

function responseErrorMessage(fields: ResponsesFailureFields | undefined): string | null {
  const directMessage = fields?.error?.message;
  if (typeof directMessage === 'string') return directMessage;
  const compatibleMessage = fields?.status_details?.error?.message;
  return typeof compatibleMessage === 'string' ? compatibleMessage : null;
}

function responseErrorCode(fields: ResponsesFailureFields | undefined): string | null {
  const directCode = fields?.error?.code;
  if (typeof directCode === 'string') return directCode;
  const compatibleCode = fields?.status_details?.error?.code;
  return typeof compatibleCode === 'string' ? compatibleCode : null;
}

function responseIncompleteReason(fields: ResponsesFailureFields | undefined): string | null {
  const reason = fields?.incomplete_details?.reason;
  return typeof reason === 'string' ? reason : null;
}

function responseId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export function consumeResponsesStreamEvent(
  state: ResponsesStreamState,
  event: unknown,
): void {
  if (!event || typeof event !== 'object') return;
  const parsed = event as ResponsesStreamEvent;

  if (parsed.type === 'response.output_text.delta') {
    if (typeof parsed.delta === 'string') {
      state.text += parsed.delta;
      if (parsed.delta.length > 0) state.outputAccepted = true;
    }
    return;
  }

  if (parsed.type === 'response.completed') {
    state.terminal = 'completed';
    state.responseId = responseId(parsed.response?.id);
    return;
  }

  if (parsed.type === 'error') {
    state.errorMessage = typeof parsed.error?.message === 'string'
      ? parsed.error.message
      : 'Responses stream returned an error.';
    state.errorCode = typeof parsed.error?.code === 'string' ? parsed.error.code : null;
    return;
  }

  if (parsed.type === 'response.failed' || parsed.type === 'response.incomplete') {
    state.terminal = parsed.type === 'response.failed' ? 'failed' : 'incomplete';
    state.errorMessage = responsesFailureMessage(parsed);
    state.errorCode = responsesFailureCode(parsed);
  }
}

export async function readOpenAiResponsesResponse(
  response: Response,
  runtimeLabel: string,
): Promise<ResponsesCompletion> {
  let text: string;
  let completedResponseId: string | null;
  if (isJsonResponse(response)) {
    const data = await response.json() as ResponsesJsonBody;
    const responseError = responseErrorMessage(data);
    if (data.status === 'failed' || data.status === 'incomplete' || responseError) {
      const detail = responseError
        ?? responseIncompleteReason(data)
        ?? `Responses API returned status ${data.status}.`;
      throw new ResponsesRequestError(
        `${runtimeLabel} response error: ${detail}`,
        responseErrorCode(data),
        hasResponsesOutputText(data),
      );
    }
    text = extractResponsesOutputText(data);
    completedResponseId = responseId(data.id);
  } else {
    if (!response.body) {
      throw new Error(`${runtimeLabel} response did not include a stream body.`);
    }

    const state: ResponsesStreamState = {
      text: '',
      errorMessage: null,
      errorCode: null,
      outputAccepted: false,
      responseId: null,
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
      throw new ResponsesRequestError(
        `${runtimeLabel} stream error: ${state.errorMessage}`,
        state.errorCode,
        state.outputAccepted,
      );
    }
    if (state.terminal !== 'completed') {
      throw new ResponsesRequestError(
        `${runtimeLabel} stream ended before response.completed.`,
        null,
        state.outputAccepted,
      );
    }
    text = state.text;
    completedResponseId = state.responseId;
  }

  return {
    text: stripThinkBlocks(text),
    responseId: completedResponseId,
  };
}

export async function throwResponsesHttpError(
  response: Response,
  runtimeLabel: string,
): Promise<never> {
  const errorText = await response.text();
  let message = errorText;
  let code: string | null = null;
  try {
    const parsed = JSON.parse(errorText) as {
      error?: { code?: unknown; message?: unknown };
    };
    if (typeof parsed.error?.message === 'string') message = parsed.error.message;
    if (typeof parsed.error?.code === 'string') code = parsed.error.code;
  } catch {
    // Preserves the provider's non-JSON error body.
  }
  throw new ResponsesRequestError(
    `${runtimeLabel} API error ${response.status}: ${message}`,
    code,
    false,
  );
}

export function isUnresolvedCheckpoint(error: unknown): boolean {
  return error instanceof ResponsesRequestError
    && error.responseCode === PREVIOUS_RESPONSE_NOT_FOUND
    && !error.outputAccepted;
}
