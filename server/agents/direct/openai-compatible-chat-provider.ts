// Shared OpenAI-compatible chat provider. Implements the common
// streaming, persistence, and session lifecycle used by remote
// chat-completions APIs such as OpenRouter and Z.AI.

import crypto from 'crypto';
import { AssistantMessage } from "../../../common/chat-types.js";
import type { SharedModelOption } from "../../../common/models.js";
import { createArtificialNativePath } from "../../chats/artificial-native-path.js";
import { AbsProvider } from "../shared/event-emitter-runtime.js";
import type { AgentCommandImage, ResumeTurnRequest, StartSessionRequest, StartedProviderSession } from "../session-types.js";
import { DirectSessionStore, type DirectConversationMessage } from "./session-store.js";
import { readSseDataEvents } from "../shared/sse.js";

const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const STREAM_TIMEOUT_MS = 5 * 60_000;
const MAX_MESSAGES_PER_SESSION = 200;

interface OpenAiCompatibleContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
}

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string | OpenAiCompatibleContentPart[];
}

interface ProviderSession {
  abortController: AbortController | null;
  aborted: boolean;
  chatId: string;
  id: string;
  isRunning: boolean;
  messages: ConversationMessage[];
  model: string;
  startTime: number;
}

interface ModelFetchContext {
  apiKey: string;
  baseUrl: string;
  requestTimeoutMs: number;
  fallbackModels: SharedModelOption[];
}

export interface OpenAiCompatibleChatProviderConfig {
  providerId: string;
  providerLabel: string;
  defaultModel: string;
  fallbackModels: SharedModelOption[];
  getApiKey: () => string;
  getBaseUrl: () => string;
  getSessionDir: () => string;
  getSessionFilePath: (sessionId: string) => string;
  buildHeaders?: (apiKey: string) => Record<string, string>;
  fetchModels?: (ctx: ModelFetchContext) => Promise<SharedModelOption[]>;
}

function buildHeaders(config: OpenAiCompatibleChatProviderConfig, apiKey: string): Record<string, string> {
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
  config: OpenAiCompatibleChatProviderConfig,
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
      throw new Error(`${config.providerLabel} API error ${response.status}: ${errorText}`);
    }

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content?.trim() || '';
  } finally {
    clearTimeout(timer);
  }
}

export class OpenAiCompatibleChatProvider extends AbsProvider {
  readonly #config: OpenAiCompatibleChatProviderConfig;
  readonly #sessionStore: DirectSessionStore;
  #sessions = new Map<string, ProviderSession>();
  #modelCache: SharedModelOption[] | null = null;
  #modelCacheTime = 0;
  #modelFetchPromise: Promise<SharedModelOption[]> | null = null;

  constructor(config: OpenAiCompatibleChatProviderConfig) {
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
      console.warn(`${this.#config.providerId}(${sessionId.slice(0, 8)}): persist failed:`, error?.message ?? String(error));
    }
  }

  async #hydrateSession(sessionId: string, request: ResumeTurnRequest): Promise<ProviderSession | null> {
    const messages = await this.#sessionStore.read(sessionId);
    if (!messages) {
      throw new Error(`Cannot hydrate ${this.#config.providerLabel} session without persisted messages: ${sessionId}`);
    }

    const session: ProviderSession = {
      abortController: null,
      aborted: false,
      chatId: request.chatId,
      id: sessionId,
      isRunning: false,
      messages: messages.map(persistedToOpenAiMessage),
      model: request.model || this.#config.defaultModel,
      startTime: Date.now(),
    };
    this.#sessions.set(sessionId, session);
    return session;
  }

  async #streamCompletion(session: ProviderSession): Promise<string> {
    const apiKey = this.#config.getApiKey();
    const abortController = new AbortController();
    session.abortController = abortController;

    const streamTimer = setTimeout(() => abortController.abort(), STREAM_TIMEOUT_MS);

    try {
      const response = await fetch(`${this.#config.getBaseUrl()}/chat/completions`, {
        method: 'POST',
        headers: buildHeaders(this.#config, apiKey),
        body: JSON.stringify({
          model: session.model,
          messages: session.messages,
          stream: true,
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`${this.#config.providerLabel} API error ${response.status}: ${errorText}`);
      }
      if (!response.body) {
        throw new Error(`${this.#config.providerLabel} response did not include a stream body.`);
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
        throw new Error(`${this.#config.providerLabel} stream error: ${lastStreamError}`);
      }

      return accumulated;
    } finally {
      clearTimeout(streamTimer);
      session.abortController = null;
    }
  }

  async #runTurnInternal(session: ProviderSession): Promise<void> {
    session.isRunning = true;
    session.aborted = false;
    this.emitProcessing(session.chatId, true);

    try {
      const response = await this.#streamCompletion(session);
      if (session.aborted) return;

      if (!response.trim()) {
        this.emitFailed(session.chatId, `Empty response from ${this.#config.providerLabel}`);
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

  async startSession(request: StartSessionRequest): Promise<StartedProviderSession> {
    const sessionId = crypto.randomUUID();
    const userContent = buildOpenAiCompatibleUserContent(request.command, request.images);
    const textContent = extractOpenAiCompatibleTextContent(userContent);

    const session: ProviderSession = {
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
      providerSessionId: sessionId,
      nativePath: createArtificialNativePath(this.#config.providerId, sessionId),
    };
  }

  async runTurn(request: ResumeTurnRequest): Promise<void> {
    const session = this.#sessions.get(request.providerSessionId)
      ?? await this.#hydrateSession(request.providerSessionId, request);
    if (!session) {
      throw new Error(`Unknown ${this.#config.providerLabel} session: ${request.providerSessionId}`);
    }
    if (session.isRunning) {
      throw new Error(`Session ${request.providerSessionId} is already running`);
    }

    if (request.model) {
      session.model = request.model;
    }

    const userContent = buildOpenAiCompatibleUserContent(request.command, request.images);
    const textContent = extractOpenAiCompatibleTextContent(userContent);

    if (session.messages.length >= MAX_MESSAGES_PER_SESSION) {
      const first = session.messages[0];
      session.messages = [first, ...session.messages.slice(-(MAX_MESSAGES_PER_SESSION - 2))];
    }

    session.messages.push({ role: 'user', content: userContent });
    session.chatId = request.chatId;

    await this.#persistMessage(session.id, 'user', textContent);

    await this.#runTurnInternal(session);
  }

  abort(providerSessionId: string): boolean {
    const session = this.#sessions.get(providerSessionId);
    if (!session?.isRunning) return false;

    session.aborted = true;
    session.abortController?.abort();
    return true;
  }

  isRunning(providerSessionId: string): boolean {
    return this.#sessions.get(providerSessionId)?.isRunning === true;
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
    if (!this.#config.fetchModels) {
      return this.#config.fallbackModels;
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
    const apiKey = this.#config.getApiKey();
    if (!apiKey) {
      return this.#config.fallbackModels;
    }

    try {
      const models = await this.#config.fetchModels!({
        apiKey,
        baseUrl: this.#config.getBaseUrl(),
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
        fallbackModels: this.#config.fallbackModels,
      });
      if (models.length > 0) {
        this.#modelCache = models;
        this.#modelCacheTime = Date.now();
        return models;
      }
    } catch (error) {
      console.warn(`${this.#config.providerId}: model fetch failed:`, error instanceof Error ? error.message : error);
    }

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
