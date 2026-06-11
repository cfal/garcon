// Implements Direct over OpenAI-compatible Responses APIs.
// Keeps Responses request/stream parsing separate from chat completions.

import crypto from 'crypto';
import { AssistantMessage } from "../../../common/chat-types.js";
import type { SharedModelOption } from "../../../common/models.js";
import { createArtificialNativePath } from "../../chats/artificial-native-path.js";
import { AgentEventEmitterRuntime } from "../shared/event-emitter-runtime.js";
import type {
  AgentCommandImage,
  ResumeTurnRequest,
  StartSessionRequest,
  StartedAgentSession,
} from "../session-types.js";
import {
  DirectSessionStore,
  type DirectConversationMessage,
} from "./session-store.js";
import { readSseDataEvents } from "../shared/sse.js";

const REQUEST_TIMEOUT_MS = 30_000;
const STREAM_TIMEOUT_MS = 5 * 60_000;
const MAX_MESSAGES_PER_SESSION = 200;

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

interface RuntimeSession {
  abortController: AbortController | null;
  aborted: boolean;
  chatId: string;
  id: string;
  isRunning: boolean;
  messages: ResponsesInputMessage[];
  model: string;
  startTime: number;
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
  if (!images?.length) return text;

  const parts: Array<ResponsesInputText | ResponsesInputImage> = [
    { type: 'input_text', text },
  ];
  for (const image of images) {
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${config.getBaseUrl()}/responses`, {
      method: 'POST',
      headers: buildHeaders(config, apiKey),
      body: JSON.stringify({
        model,
        input: [{ role: 'user', content: prompt }],
        store: false,
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

export class OpenAiCompatibleResponsesRuntime extends AgentEventEmitterRuntime {
  readonly #config: OpenAiCompatibleResponsesRuntimeConfig;
  readonly #sessionStore: DirectSessionStore;
  #sessions = new Map<string, RuntimeSession>();
  #purgeTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: OpenAiCompatibleResponsesRuntimeConfig) {
    super();
    this.#config = config;
    this.#sessionStore = new DirectSessionStore({
      getSessionDir: config.getSessionDir,
      getSessionFilePath: config.getSessionFilePath,
    });
  }

  async #persistMessage(sessionId: string, role: 'user' | 'assistant', content: string): Promise<void> {
    try {
      await this.#sessionStore.append(sessionId, role, content);
    } catch (error: unknown) {
      console.warn(
        `${this.#config.runtimeId}(${sessionId.slice(0, 8)}): persist failed:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async #hydrateSession(sessionId: string, request: ResumeTurnRequest): Promise<RuntimeSession> {
    const messages = await this.#sessionStore.read(sessionId);
    if (!messages) {
      throw new Error(`Cannot hydrate ${this.#config.runtimeLabel} session without persisted messages: ${sessionId}`);
    }

    const session: RuntimeSession = {
      abortController: null,
      aborted: false,
      chatId: request.chatId,
      id: sessionId,
      isRunning: false,
      messages: messages.map(persistedToResponsesMessage),
      model: request.model || this.#config.defaultModel,
      startTime: Date.now(),
    };
    this.#sessions.set(sessionId, session);
    return session;
  }

  async #streamResponse(session: RuntimeSession): Promise<string> {
    const apiKey = this.#config.getApiKey();
    const abortController = new AbortController();
    session.abortController = abortController;
    const timer = setTimeout(() => abortController.abort(), STREAM_TIMEOUT_MS);

    try {
      const response = await fetch(`${this.#config.getBaseUrl()}/responses`, {
        method: 'POST',
        headers: buildHeaders(this.#config, apiKey),
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
        throw new Error(`${this.#config.runtimeLabel} Responses API error ${response.status}: ${errorText}`);
      }
      if (!response.body) {
        throw new Error(`${this.#config.runtimeLabel} response did not include a stream body.`);
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
        throw new Error(`${this.#config.runtimeLabel} Responses stream error: ${streamError}`);
      }
      return accumulated;
    } finally {
      clearTimeout(timer);
      session.abortController = null;
    }
  }

  async #runTurnInternal(session: RuntimeSession): Promise<void> {
    session.isRunning = true;
    session.aborted = false;
    this.emitProcessing(session.chatId, true);

    try {
      const response = await this.#streamResponse(session);
      if (session.aborted) return;
      if (!response.trim()) {
        this.emitFailed(session.chatId, `Empty response from ${this.#config.runtimeLabel}`);
        return;
      }

      session.messages.push({ role: 'assistant', content: response });
      await this.#persistMessage(session.id, 'assistant', response);

      this.emitMessages(session.chatId, [
        new AssistantMessage(new Date().toISOString(), response),
      ]);
      this.emitFinished(session.chatId, 0);
    } catch (error: unknown) {
      if (session.aborted) return;
      this.emitFailed(session.chatId, error instanceof Error ? error.message : String(error));
    } finally {
      session.isRunning = false;
      this.emitProcessing(session.chatId, false);
    }
  }

  async startSession(request: StartSessionRequest): Promise<StartedAgentSession> {
    const sessionId = crypto.randomUUID();
    const userContent = buildOpenAiResponsesUserContent(request.command, request.images);
    const textContent = extractOpenAiResponsesTextContent(userContent);

    const session: RuntimeSession = {
      abortController: null,
      aborted: false,
      chatId: request.chatId,
      id: sessionId,
      isRunning: false,
      messages: [{ role: 'user', content: userContent }],
      model: request.model || this.#config.defaultModel,
      startTime: Date.now(),
    };

    this.#sessions.set(sessionId, session);
    this.emitSessionCreated(request.chatId);
    await this.#persistMessage(sessionId, 'user', textContent);
    void this.#runTurnInternal(session);

    return {
      agentSessionId: sessionId,
      nativePath: createArtificialNativePath(this.#config.runtimeId, sessionId),
    };
  }

  async runTurn(request: ResumeTurnRequest): Promise<void> {
    const session = this.#sessions.get(request.agentSessionId)
      ?? await this.#hydrateSession(request.agentSessionId, request);

    if (session.isRunning) {
      throw new Error(`Session ${request.agentSessionId} is already running`);
    }
    if (request.model) session.model = request.model;

    const userContent = buildOpenAiResponsesUserContent(request.command, request.images);
    const textContent = extractOpenAiResponsesTextContent(userContent);

    if (session.messages.length >= MAX_MESSAGES_PER_SESSION) {
      const first = session.messages[0];
      session.messages = [first, ...session.messages.slice(-(MAX_MESSAGES_PER_SESSION - 2))];
    }

    session.messages.push({ role: 'user', content: userContent });
    session.chatId = request.chatId;
    await this.#persistMessage(session.id, 'user', textContent);
    await this.#runTurnInternal(session);
  }

  abort(agentSessionId: string): boolean {
    const session = this.#sessions.get(agentSessionId);
    if (!session?.isRunning) return false;
    session.aborted = true;
    session.abortController?.abort();
    return true;
  }

  isRunning(agentSessionId: string): boolean {
    return this.#sessions.get(agentSessionId)?.isRunning === true;
  }

  getRunningSessions(): Array<{ id: string; startedAt: string; status: string }> {
    return Array.from(this.#sessions.values())
      .filter((session) => session.isRunning)
      .map((session) => ({
        id: session.id,
        startedAt: new Date(session.startTime).toISOString(),
        status: 'running',
      }));
  }

  startPurgeTimer(): void {
    if (this.#purgeTimer) return;
    const maxAge = 30 * 60 * 1000;
    this.#purgeTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, session] of this.#sessions.entries()) {
        if (!session.isRunning && now - session.startTime > maxAge) {
          this.#sessions.delete(id);
        }
      }
    }, 5 * 60 * 1000);
  }

  shutdown(): void {
    if (this.#purgeTimer) {
      clearInterval(this.#purgeTimer);
      this.#purgeTimer = null;
    }
    for (const session of this.#sessions.values()) {
      session.aborted = true;
      session.abortController?.abort();
    }
    this.#sessions.clear();
  }
}
