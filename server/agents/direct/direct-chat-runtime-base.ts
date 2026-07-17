import crypto from 'crypto';
import {
  normalizeThinkingMode,
  type ThinkingMode,
} from '../../../common/chat-modes.js';
import { AssistantMessage } from '../../../common/chat-types.js';
import type { SharedModelOption } from '../../../common/models.js';
import type {
  AgentCommandImage,
  ResumeTurnRequest,
  StartSessionRequest,
  StartedAgentSession,
} from '../session-types.js';
import { AgentEventEmitterRuntime } from '../shared/event-emitter-runtime.js';
import { IdleSessionPurger } from '../shared/idle-session-purger.js';
import {
  DirectSessionStore,
  type DirectConversationMessage,
} from './session-store.js';

const DEFAULT_MAX_MESSAGES_PER_SESSION = 200;

export interface DirectRuntimeSession<TMessage> {
  abortController: AbortController | null;
  aborted: boolean;
  chatId: string;
  id: string;
  isRunning: boolean;
  messages: TMessage[];
  model: string;
  thinkingMode: ThinkingMode;
  startTime: number;
  lastActivityAt: number;
}

export interface DirectUserTurn<TMessage> {
  message: TMessage;
  persistedContent: string;
}

export interface DirectChatRuntimeBaseConfig {
  runtimeId: string;
  runtimeLabel: string;
  defaultModel: string;
  fallbackModels: SharedModelOption[];
  getSessionDir: () => string;
  getSessionFilePath: (sessionId: string) => string;
  maxMessagesPerSession?: number;
}

export abstract class DirectChatRuntimeBase<
  TMessage,
  TConfig extends DirectChatRuntimeBaseConfig,
> extends AgentEventEmitterRuntime {
  protected readonly config: TConfig;
  readonly #sessionStore: DirectSessionStore;
  readonly #maxMessagesPerSession: number;
  #sessions = new Map<string, DirectRuntimeSession<TMessage>>();
  #idlePurger = new IdleSessionPurger<DirectRuntimeSession<TMessage>>({
    sessions: () => this.#sessions.entries(),
    isRunning: (session) => session.isRunning,
    lastActivityAt: (session) => session.lastActivityAt,
    purge: (sessionId) => {
      this.#sessions.delete(sessionId);
    },
  });

  protected constructor(config: TConfig) {
    super();
    this.config = config;
    this.#sessionStore = new DirectSessionStore({
      getSessionDir: config.getSessionDir,
      getSessionFilePath: config.getSessionFilePath,
    });
    this.#maxMessagesPerSession = config.maxMessagesPerSession ?? DEFAULT_MAX_MESSAGES_PER_SESSION;
  }

  protected abstract buildUserTurn(command: string, images?: AgentCommandImage[]): DirectUserTurn<TMessage>;

  protected abstract buildAssistantMessage(content: string): TMessage;

  protected abstract persistedToMessage(message: DirectConversationMessage): TMessage;

  protected abstract streamSession(session: DirectRuntimeSession<TMessage>): Promise<string>;

  async startSession(request: StartSessionRequest): Promise<StartedAgentSession> {
    const sessionId = crypto.randomUUID();
    const userTurn = this.buildUserTurn(request.command, request.images);
    const now = Date.now();
    const session: DirectRuntimeSession<TMessage> = {
      abortController: null,
      aborted: false,
      chatId: request.chatId,
      id: sessionId,
      isRunning: false,
      messages: [userTurn.message],
      model: request.model || this.config.defaultModel,
      thinkingMode: normalizeThinkingMode(request.thinkingMode),
      startTime: now,
      lastActivityAt: now,
    };

    await this.#sessionStore.append(sessionId, 'user', userTurn.persistedContent);
    this.#sessions.set(sessionId, session);
    this.emitSessionCreated(request.chatId);
    void this.#runTurnInternal(session);

    return {
      agentSessionId: sessionId,
      nativePath: this.config.getSessionFilePath(sessionId),
    };
  }

  async runTurn(request: ResumeTurnRequest): Promise<void> {
    const session = this.#sessions.get(request.agentSessionId)
      ?? await this.#hydrateSession(request.agentSessionId, request);

    if (session.isRunning) {
      throw new Error(`Session ${request.agentSessionId} is already running`);
    }
    if (request.model) {
      session.model = request.model;
    }
    session.thinkingMode = normalizeThinkingMode(request.thinkingMode);

    const userTurn = this.buildUserTurn(request.command, request.images);
    this.#markSessionRunning(session);
    try {
      await this.#sessionStore.append(session.id, 'user', userTurn.persistedContent);
      if (session.messages.length >= this.#maxMessagesPerSession) {
        const first = session.messages[0];
        session.messages = [first, ...session.messages.slice(-(this.#maxMessagesPerSession - 2))];
      }

      session.messages.push(userTurn.message);
      session.chatId = request.chatId;
      await this.#runTurnInternal(session);
    } catch (error: unknown) {
      this.#markSessionIdle(session);
      throw error;
    }
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
    return this.config.fallbackModels;
  }

  startPurgeTimer(): void {
    this.#idlePurger.start();
  }

  shutdown(): void {
    this.#idlePurger.stop();
    for (const session of this.#sessions.values()) {
      session.aborted = true;
      session.abortController?.abort();
    }
    this.#sessions.clear();
  }

  async #hydrateSession(
    sessionId: string,
    request: ResumeTurnRequest,
  ): Promise<DirectRuntimeSession<TMessage>> {
    const messages = await this.#sessionStore.read(sessionId);
    if (!messages) {
      throw new Error(`Cannot hydrate ${this.config.runtimeLabel} session without persisted messages: ${sessionId}`);
    }

    const now = Date.now();
    const session: DirectRuntimeSession<TMessage> = {
      abortController: null,
      aborted: false,
      chatId: request.chatId,
      id: sessionId,
      isRunning: false,
      messages: messages.map((message) => this.persistedToMessage(message)),
      model: request.model || this.config.defaultModel,
      thinkingMode: normalizeThinkingMode(request.thinkingMode),
      startTime: now,
      lastActivityAt: now,
    };
    this.#sessions.set(sessionId, session);
    return session;
  }

  #markSessionIdle(session: DirectRuntimeSession<TMessage>): void {
    if (!session.isRunning) return;
    session.isRunning = false;
    session.lastActivityAt = Date.now();
    this.emitProcessing(session.chatId, false);
  }

  #markSessionRunning(session: DirectRuntimeSession<TMessage>): void {
    if (session.isRunning) return;
    session.isRunning = true;
    session.aborted = false;
    session.lastActivityAt = Date.now();
    this.emitProcessing(session.chatId, true);
  }

  async #runTurnInternal(session: DirectRuntimeSession<TMessage>): Promise<void> {
    this.#markSessionRunning(session);
    if (session.aborted) {
      this.#markSessionIdle(session);
      return;
    }

    try {
      const response = await this.streamSession(session);
      if (session.aborted) return;

      if (!response.trim()) {
        this.#markSessionIdle(session);
        this.emitFailed(session.chatId, `Empty response from ${this.config.runtimeLabel}`);
        return;
      }

      await this.#sessionStore.append(session.id, 'assistant', response);
      session.messages.push(this.buildAssistantMessage(response));
      this.emitMessages(session.chatId, [
        new AssistantMessage(new Date().toISOString(), response),
      ]);
      this.#markSessionIdle(session);
      this.emitFinished(session.chatId, 0);
    } catch (error: unknown) {
      if (session.aborted) return;
      this.#markSessionIdle(session);
      this.emitFailed(session.chatId, error instanceof Error ? error.message : String(error));
    } finally {
      this.#markSessionIdle(session);
    }
  }
}
