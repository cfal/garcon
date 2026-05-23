// Shared Anthropic-compatible chat runtime. Implements direct server-side
// execution against Anthropic Messages endpoints.

import crypto from 'crypto';
import { AssistantMessage } from "../../../common/chat-types.js";
import type { SharedModelOption } from "../../../common/models.js";
import { createArtificialNativePath } from "../../chats/artificial-native-path.js";
import { AgentEventEmitterRuntime } from "../shared/event-emitter-runtime.js";
import {
  DirectSessionStore,
  type DirectConversationMessage,
} from "./session-store.js";
import { readSseDataEvents } from "../shared/sse.js";
import type {
  AgentCommandImage,
  ResumeTurnRequest,
  StartSessionRequest,
  StartedAgentSession,
} from "../session-types.js";

const REQUEST_TIMEOUT_MS = 30_000;
const STREAM_TIMEOUT_MS = 5 * 60_000;
const MAX_MESSAGES_PER_SESSION = 200;
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

interface RuntimeSession {
  abortController: AbortController | null;
  aborted: boolean;
  chatId: string;
  id: string;
  isRunning: boolean;
  messages: AnthropicConversationMessage[];
  model: string;
  startTime: number;
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

export class AnthropicCompatibleChatRuntime extends AgentEventEmitterRuntime {
  readonly #config: AnthropicCompatibleChatRuntimeConfig;
  readonly #sessionStore: DirectSessionStore;
  #sessions = new Map<string, RuntimeSession>();

  constructor(config: AnthropicCompatibleChatRuntimeConfig) {
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
    } catch (error: any) {
      console.warn(`${this.#config.runtimeId}(${sessionId.slice(0, 8)}): persist failed:`, error?.message ?? String(error));
    }
  }

  async #hydrateSession(sessionId: string, request: ResumeTurnRequest): Promise<RuntimeSession | null> {
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
      messages: messages.map(persistedToAnthropicMessage),
      model: request.model || this.#config.defaultModel,
      startTime: Date.now(),
    };
    this.#sessions.set(sessionId, session);
    return session;
  }

  async #streamMessage(session: RuntimeSession): Promise<string> {
    const abortController = new AbortController();
    session.abortController = abortController;
    const streamTimer = setTimeout(() => abortController.abort(), STREAM_TIMEOUT_MS);

    try {
      const response = await fetch(anthropicMessagesUrl(this.#config.getBaseUrl()), {
        method: 'POST',
        headers: buildAnthropicCompatibleHeaders(this.#config.getApiKey()),
        body: JSON.stringify({
          model: session.model,
          max_tokens: this.#config.maxTokens ?? DEFAULT_MAX_TOKENS,
          messages: session.messages,
          stream: true,
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`${this.#config.runtimeLabel} API error ${response.status}: ${errorText}`);
      }
      if (!response.body) {
        throw new Error(`${this.#config.runtimeLabel} response did not include a stream body.`);
      }

      let accumulated = '';
      let lastStreamError = '';

      await readSseDataEvents(response.body, (data) => {
        const result = appendAnthropicDelta(accumulated, data);
        accumulated = result.accumulated;
        if (result.errorMessage) lastStreamError = result.errorMessage;
      });

      if (!accumulated.trim() && lastStreamError) {
        throw new Error(`${this.#config.runtimeLabel} stream error: ${lastStreamError}`);
      }

      return accumulated;
    } finally {
      clearTimeout(streamTimer);
      session.abortController = null;
    }
  }

  async #runTurnInternal(session: RuntimeSession): Promise<void> {
    session.isRunning = true;
    session.aborted = false;
    this.emitProcessing(session.chatId, true);

    try {
      const response = await this.#streamMessage(session);
      if (session.aborted) return;

      if (!response.trim()) {
        this.emitFailed(session.chatId, `Empty response from ${this.#config.runtimeLabel}`);
        return;
      }

      session.messages.push({ role: 'assistant', content: response });

      await this.#persistMessage(session.id, 'assistant', response);

      const timestamp = new Date().toISOString();
      this.emitMessages(session.chatId, [new AssistantMessage(timestamp, response)]);
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
    const userContent = buildAnthropicCompatibleUserContent(request.command, request.images);
    const textContent = extractAnthropicTextContent(userContent);

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
    if (!session) {
      throw new Error(`Unknown ${this.#config.runtimeLabel} session: ${request.agentSessionId}`);
    }
    if (session.isRunning) {
      throw new Error(`Session ${request.agentSessionId} is already running`);
    }

    if (request.model) {
      session.model = request.model;
    }

    const userContent = buildAnthropicCompatibleUserContent(request.command, request.images);
    const textContent = extractAnthropicTextContent(userContent);

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

  async getModels(): Promise<SharedModelOption[]> {
    return this.#config.fallbackModels;
  }

  startPurgeTimer(): ReturnType<typeof setInterval> {
    const maxAge = 30 * 60 * 1000;
    return setInterval(() => {
      const now = Date.now();
      for (const [id, session] of this.#sessions.entries()) {
        if (!session.isRunning && now - session.startTime > maxAge) {
          this.#sessions.delete(id);
        }
      }
    }, 5 * 60 * 1000);
  }
}
