// OpenRouter provider. Streams chat completions from the OpenRouter API
// (OpenAI-compatible) and maintains per-session conversation history.
// No tool use or agent loop -- pure multi-turn chat.
//
// Image data is stored in the in-memory session for context continuity
// but only plain text is persisted to JSONL (images are not recoverable
// after a server restart by design).

import crypto from 'crypto';
import { promises as fs } from 'fs';
import { AssistantMessage, type ChatMessage } from '../../common/chat-types.js';
import { OPENROUTER_MODELS, type SharedModelOption } from '../../common/models.js';
import { AbsProvider } from './base.js';
import { createArtificialNativePath } from '../chats/artificial-native-path.js';
import { getSessionDir, getSessionFilePath } from './openrouter-paths.js';
import type { StartSessionRequest, StartedProviderSession, ResumeTurnRequest, AgentCommandImage } from './types.js';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const STREAM_TIMEOUT_MS = 5 * 60_000;
const MAX_MESSAGES_PER_SESSION = 200;

interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
}

interface OpenRouterSession {
  abortController: AbortController | null;
  aborted: boolean;
  chatId: string;
  id: string;
  isRunning: boolean;
  messages: ConversationMessage[];
  model: string;
  startTime: number;
}

function getApiKey(): string {
  return process.env.OPENROUTER_API_KEY || '';
}

function makeHeaders(apiKey: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://github.com/cfal/garcon',
    'X-Title': 'Garcon',
  };
}

// Converts image attachments to the OpenAI multimodal content format.
function buildUserContent(
  text: string,
  images?: AgentCommandImage[],
): string | Array<{ type: string; text?: string; image_url?: { url: string } }> {
  if (!images?.length) return text;
  const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
    { type: 'text', text },
  ];
  for (const image of images) {
    if (!image.data) continue;
    parts.push({ type: 'image_url', image_url: { url: image.data } });
  }
  return parts;
}

// Extracts plain text from a conversation message's content field.
function extractTextContent(content: ConversationMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text!)
    .join('\n');
}

export async function runSingleQuery(prompt: string, options: Record<string, unknown> = {}): Promise<string> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');

  const model = typeof options.model === 'string' && options.model
    ? options.model
    : OPENROUTER_MODELS.DEFAULT;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: makeHeaders(apiKey),
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenRouter API error ${response.status}: ${errorText}`);
    }

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content?.trim() || '';
  } finally {
    clearTimeout(timer);
  }
}

export class OpenRouterProvider extends AbsProvider {
  #sessions = new Map<string, OpenRouterSession>();
  #modelCache: SharedModelOption[] | null = null;
  #modelCacheTime = 0;
  #modelFetchPromise: Promise<SharedModelOption[]> | null = null;

  async #ensureSessionDir(): Promise<void> {
    await fs.mkdir(getSessionDir(), { recursive: true });
  }

  async #persistMessage(sessionId: string, role: string, content: string): Promise<void> {
    await this.#ensureSessionDir();
    const line = JSON.stringify({ role, content, timestamp: new Date().toISOString() }) + '\n';
    await fs.appendFile(getSessionFilePath(sessionId), line);
  }

  async #streamCompletion(session: OpenRouterSession): Promise<string> {
    const apiKey = getApiKey();
    if (!apiKey) {
      throw new Error('OPENROUTER_API_KEY is not set');
    }

    const abortController = new AbortController();
    session.abortController = abortController;

    // Wall-clock timeout for the entire streaming response.
    const streamTimer = setTimeout(() => abortController.abort(), STREAM_TIMEOUT_MS);

    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

    try {
      const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: makeHeaders(apiKey),
        body: JSON.stringify({
          model: session.model,
          messages: session.messages,
          stream: true,
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenRouter API error ${response.status}: ${errorText}`);
      }

      reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let accumulated = '';
      let lastStreamError = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string } }>;
              error?: { message?: string };
            };
            // Capture stream-level errors (e.g. rate limit mid-stream).
            if (parsed.error?.message) {
              lastStreamError = parsed.error.message;
              continue;
            }
            const delta = parsed.choices?.[0]?.delta?.content;
            if (typeof delta === 'string') {
              accumulated += delta;
            }
          } catch {
            // Skip malformed chunks.
          }
        }
      }

      // If the model produced no output but reported an error, surface it.
      if (!accumulated.trim() && lastStreamError) {
        throw new Error(`OpenRouter stream error: ${lastStreamError}`);
      }

      return accumulated;
    } finally {
      clearTimeout(streamTimer);
      session.abortController = null;
      if (reader) {
        reader.cancel().catch(() => {});
      }
    }
  }

  async #runTurnInternal(session: OpenRouterSession): Promise<void> {
    session.isRunning = true;
    session.aborted = false;
    this.emitProcessing(session.chatId, true);

    try {
      const response = await this.#streamCompletion(session);

      if (session.aborted) return;

      if (!response.trim()) {
        this.emitFailed(session.chatId, 'Empty response from OpenRouter');
        return;
      }

      // Append assistant response to conversation history.
      session.messages.push({ role: 'assistant', content: response });

      const timestamp = new Date().toISOString();
      this.emitMessages(session.chatId, [new AssistantMessage(timestamp, response)]);
      this.emitFinished(session.chatId, 0);

      // Persist asynchronously.
      void this.#persistMessage(session.id, 'assistant', response).catch((err) => {
        console.warn(`openrouter(${session.id.slice(0, 8)}): persist failed:`, err.message);
      });
    } catch (error: unknown) {
      if (session.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      this.emitFailed(session.chatId, message);
    } finally {
      session.isRunning = false;
      this.emitProcessing(session.chatId, false);
    }
  }

  async startSession(request: StartSessionRequest): Promise<StartedProviderSession> {
    const sessionId = crypto.randomUUID();
    const userContent = buildUserContent(request.command, request.images);
    const textContent = extractTextContent(userContent);

    const session: OpenRouterSession = {
      abortController: null,
      aborted: false,
      chatId: request.chatId,
      id: sessionId,
      isRunning: false,
      messages: [{ role: 'user', content: userContent }],
      model: request.model || OPENROUTER_MODELS.DEFAULT,
      startTime: Date.now(),
    };

    this.#sessions.set(sessionId, session);
    this.emitSessionCreated(request.chatId);

    // Persist the user message.
    void this.#persistMessage(sessionId, 'user', textContent).catch((err) => {
      console.warn(`openrouter(${sessionId.slice(0, 8)}): persist failed:`, err.message);
    });

    // Run the turn asynchronously (caller doesn't wait for completion).
    void this.#runTurnInternal(session);

    return {
      providerSessionId: sessionId,
      nativePath: createArtificialNativePath('openrouter', sessionId),
    };
  }

  async runTurn(request: ResumeTurnRequest): Promise<void> {
    const session = this.#sessions.get(request.providerSessionId);
    if (!session) {
      throw new Error(`Unknown OpenRouter session: ${request.providerSessionId}`);
    }
    if (session.isRunning) {
      throw new Error(`Session ${request.providerSessionId} is already running`);
    }

    // Allow model changes between turns.
    if (request.model) {
      session.model = request.model;
    }

    const userContent = buildUserContent(request.command, request.images);
    const textContent = extractTextContent(userContent);

    // Enforce message cap to prevent unbounded memory/context growth.
    if (session.messages.length >= MAX_MESSAGES_PER_SESSION) {
      // Keep the first message (initial system/user context) and trim
      // the oldest middle messages to stay under the cap.
      const first = session.messages[0];
      session.messages = [first, ...session.messages.slice(-(MAX_MESSAGES_PER_SESSION - 2))];
    }

    session.messages.push({ role: 'user', content: userContent });
    session.chatId = request.chatId;

    void this.#persistMessage(session.id, 'user', textContent).catch((err) => {
      console.warn(`openrouter(${session.id.slice(0, 8)}): persist failed:`, err.message);
    });

    await this.#runTurnInternal(session);
  }

  abort(providerSessionId: string): boolean {
    const session = this.#sessions.get(providerSessionId);
    if (!session?.isRunning) return false;
    // Set aborted flag and cancel the HTTP request. The running
    // #runTurnInternal coroutine will see session.aborted=true and
    // exit cleanly, emitting processing=false in its own finally block.
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

  // Fetches models from OpenRouter API with caching and deduplication.
  async getModels(): Promise<SharedModelOption[]> {
    if (this.#modelCache && Date.now() - this.#modelCacheTime < MODEL_CACHE_TTL_MS) {
      return this.#modelCache;
    }

    // Deduplicate concurrent fetches to prevent cache stampede.
    if (this.#modelFetchPromise) return this.#modelFetchPromise;

    this.#modelFetchPromise = this.#fetchModels();
    try {
      return await this.#modelFetchPromise;
    } finally {
      this.#modelFetchPromise = null;
    }
  }

  async #fetchModels(): Promise<SharedModelOption[]> {
    const apiKey = getApiKey();
    if (!apiKey) return OPENROUTER_MODELS.OPTIONS;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${OPENROUTER_BASE_URL}/models`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      if (!response.ok) return OPENROUTER_MODELS.OPTIONS;

      const data = await response.json() as {
        data?: Array<{
          id: string;
          name?: string;
          architecture?: { modality?: string };
        }>;
      };

      if (!Array.isArray(data.data)) return OPENROUTER_MODELS.OPTIONS;

      const models: SharedModelOption[] = data.data
        .filter((model) => model.id && model.name)
        .map((model) => ({
          value: model.id,
          label: model.name!,
          supportsImages: model.architecture?.modality?.includes('image') ?? false,
        }));

      if (models.length > 0) {
        this.#modelCache = models;
        this.#modelCacheTime = Date.now();
        return models;
      }
    } catch (error) {
      console.warn('openrouter: model fetch failed:', error instanceof Error ? error.message : error);
    } finally {
      clearTimeout(timer);
    }

    return OPENROUTER_MODELS.OPTIONS;
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
