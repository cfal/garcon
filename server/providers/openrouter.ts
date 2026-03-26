// OpenRouter API provider. Sends chat completions via the OpenAI-compatible
// streaming endpoint at openrouter.ai. Sessions are maintained as in-memory
// conversation histories (no CLI process to spawn).

import crypto from 'crypto';
import { AbsProvider } from './base.js';
import { AssistantMessage, ThinkingMessage } from '../../common/chat-types.js';
import type { StartSessionRequest, ResumeTurnRequest, StartedProviderSession } from './types.js';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

interface OpenRouterChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OpenRouterSession {
  id: string;
  chatId: string;
  messages: OpenRouterChatMessage[];
  isRunning: boolean;
  finalized: boolean;
  aborted: boolean;
  abortController: AbortController | null;
  turnResolve: ((value?: unknown) => void) | null;
  startTime: number;
  model: string;
}

// Represents a single delta chunk from the SSE stream.
interface OpenRouterStreamDelta {
  choices?: Array<{
    delta?: {
      content?: string | null;
      role?: string;
    };
    finish_reason?: string | null;
  }>;
}

function getApiKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key?.trim()) {
    throw new Error('OPENROUTER_API_KEY environment variable is not set');
  }
  return key.trim();
}

function createSession(chatId: string, model: string): OpenRouterSession {
  return {
    id: crypto.randomUUID(),
    chatId,
    messages: [],
    isRunning: true,
    finalized: false,
    aborted: false,
    abortController: null,
    turnResolve: null,
    startTime: Date.now(),
    model,
  };
}

class OpenRouterProvider extends AbsProvider {
  #runningSessions = new Map<string, OpenRouterSession>();

  constructor() {
    super();
  }

  async startSession({ command, chatId, model }: StartSessionRequest): Promise<StartedProviderSession> {
    if (!chatId) throw new Error('chatId is required when starting an OpenRouter session');

    const session = createSession(chatId, model);
    this.#runningSessions.set(session.id, session);

    session.messages.push(
      { role: 'system', content: 'You are a helpful coding assistant.' },
      { role: 'user', content: command },
    );

    this.emitProcessing(chatId, true);
    this.emitSessionCreated(chatId);

    this.#streamCompletion(session).catch((err) => {
      console.error(`openrouter(${session.id.slice(0, 8)}): stream error:`, (err as Error).message);
    });

    return {
      providerSessionId: session.id,
      nativePath: `openrouter:${session.id}`,
    };
  }

  async runTurn({ command, providerSessionId, chatId }: ResumeTurnRequest): Promise<void> {
    if (!providerSessionId) throw new Error('Cannot resume without session ID');
    if (!chatId) throw new Error('Cannot resume without chat ID');

    let session = this.#runningSessions.get(providerSessionId);
    if (!session) {
      throw new Error(`OpenRouter session not found: ${providerSessionId}`);
    }

    if (session.isRunning) {
      throw new Error(`Session ${providerSessionId} is already running`);
    }
    if (chatId !== session.chatId) {
      throw new Error('Chat ID mismatch');
    }

    session.isRunning = true;
    session.finalized = false;
    session.aborted = false;

    session.messages.push({ role: 'user', content: command });

    this.emitProcessing(chatId, true);

    try {
      await this.#streamCompletion(session);
    } catch (err) {
      if (!session.aborted) {
        console.error(`openrouter(${session.id.slice(0, 8)}): turn error:`, (err as Error).message);
      }
    }
  }

  async #streamCompletion(session: OpenRouterSession): Promise<void> {
    const apiKey = getApiKey();
    const controller = new AbortController();
    session.abortController = controller;

    let fullContent = '';

    try {
      const response = await fetch(OPENROUTER_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/cfal/garcon',
          'X-Title': 'Garcon',
        },
        body: JSON.stringify({
          model: session.model,
          messages: session.messages,
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`OpenRouter API error ${response.status}: ${errorText.slice(0, 200)}`);
      }

      if (!response.body) {
        throw new Error('OpenRouter response has no body');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;
          if (!trimmed.startsWith('data: ')) continue;

          const jsonStr = trimmed.slice(6);
          let chunk: OpenRouterStreamDelta;
          try {
            chunk = JSON.parse(jsonStr) as OpenRouterStreamDelta;
          } catch {
            continue;
          }

          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) {
            fullContent += delta.content;
          }
        }
      }

      if (fullContent.trim()) {
        session.messages.push({ role: 'assistant', content: fullContent });

        const now = new Date().toISOString();
        this.emitMessages(session.chatId, [
          new AssistantMessage(now, fullContent),
        ]);
      }

      this.emitFinished(session.chatId, 0);
      this.#finalizeTurn(session);
    } catch (err) {
      if (session.aborted) {
        this.#finalizeTurn(session);
        return;
      }

      const message = (err as Error).message || 'Unknown error';
      this.emitFailed(session.chatId, `OpenRouter: ${message}`);
      this.#finalizeTurn(session);
    }
  }

  // Idempotent turn finalizer.
  #finalizeTurn(session: OpenRouterSession): void {
    if (session.finalized) return;
    session.finalized = true;

    const wasRunning = session.isRunning;
    session.isRunning = false;
    session.abortController = null;
    if (wasRunning) this.emitProcessing(session.chatId, false);

    const resolve = session.turnResolve;
    session.turnResolve = null;
    resolve?.();
  }

  abort(providerSessionId: string): boolean {
    const session = this.#runningSessions.get(providerSessionId);
    if (!session || !session.isRunning) return false;

    session.aborted = true;
    session.abortController?.abort();
    this.#finalizeTurn(session);
    return true;
  }

  isRunning(providerSessionId: string): boolean {
    const session = this.#runningSessions.get(providerSessionId);
    return session?.isRunning === true;
  }

  getRunningSessions(): Array<{ id: string; status: string; startedAt: string }> {
    return Array.from(this.#runningSessions.entries())
      .filter(([, s]) => s.isRunning)
      .map(([id, s]) => ({
        id,
        status: 'running',
        startedAt: new Date(s.startTime).toISOString(),
      }));
  }

  startPurgeTimer(): ReturnType<typeof setInterval> {
    const maxAge = 30 * 60 * 1000;

    return setInterval(() => {
      const now = Date.now();

      for (const [id, session] of this.#runningSessions.entries()) {
        if (!session.isRunning && (now - session.startTime > maxAge)) {
          this.#runningSessions.delete(id);
        }
      }
    }, 5 * 60 * 1000);
  }
}

export { OpenRouterProvider };
