import crypto from 'crypto';
import {
  normalizeThinkingMode,
  type ThinkingMode,
} from '@garcon/common/chat-modes';
import { AssistantMessage } from '@garcon/common/chat-types';
import type { SharedModelOption } from '@garcon/common/models';
import {
  assertDirectExecutionOpen,
  directEventMetadata,
  markDirectExecutionStarted,
  type DirectResumeRequest,
  type DirectStartedSession,
  type DirectStartRequest,
} from './runtime-types.js';
import { AgentEventEmitterRuntime } from '@garcon/server-agent-common/shared/event-emitter-runtime';
import type { RuntimeEventMetadata } from '@garcon/server-agent-common/shared/event-emitter-runtime';
import type { AgentAttachment } from '@garcon/common/agent-execution';
import { IdleSessionPurger } from '@garcon/server-agent-common/shared/idle-session-purger';
import {
  DirectSessionStore,
  type DirectConversationMessage,
  type DirectMessageIdentity,
} from './session-store.js';

const DEFAULT_MAX_MESSAGES_PER_SESSION = 200;

export interface DirectRuntimeSession<TMessage> {
  abortController: AbortController | null;
  aborted: boolean;
  chatId: string;
  id: string;
  isFinalizing: boolean;
  isRunning: boolean;
  messages: TMessage[];
  model: string;
  thinkingMode: ThinkingMode;
  startTime: number;
  lastActivityAt: number;
  eventMetadata: RuntimeEventMetadata;
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

  protected abstract buildUserTurn(command: string, images?: readonly AgentAttachment[]): DirectUserTurn<TMessage>;

  protected abstract buildAssistantMessage(content: string): TMessage;

  protected abstract persistedToMessage(message: DirectConversationMessage): TMessage;

  protected abstract streamSession(session: DirectRuntimeSession<TMessage>): Promise<string>;

  async startSession(request: DirectStartRequest): Promise<DirectStartedSession> {
    assertDirectExecutionOpen(request);
    const sessionId = crypto.randomUUID();
    const userTurn = this.buildUserTurn(request.command, request.images);
    const now = Date.now();
    const session: DirectRuntimeSession<TMessage> = {
      abortController: null,
      aborted: false,
      chatId: request.chatId,
      id: sessionId,
      isFinalizing: false,
      isRunning: false,
      messages: [userTurn.message],
      model: request.model || this.config.defaultModel,
      thinkingMode: normalizeThinkingMode(request.thinkingMode),
      startTime: now,
      lastActivityAt: now,
      eventMetadata: directEventMetadata(request, 'chat-start'),
    };

    await this.#sessionStore.append(
      sessionId,
      'user',
      userTurn.persistedContent,
      this.#turnIdentity(request),
    );
    assertDirectExecutionOpen(request);
    this.#sessions.set(sessionId, session);
    this.emitSessionCreated(request.chatId);
    void this.#runTurnInternal(session, this.#turnIdentity(request), request).catch(() => undefined);
    request.onAbortable?.();

    return {
      agentSessionId: sessionId,
      nativePath: this.config.getSessionFilePath(sessionId),
    };
  }

  async runTurn(request: DirectResumeRequest): Promise<void> {
    assertDirectExecutionOpen(request);
    const session = this.#sessions.get(request.agentSessionId)
      ?? await this.#hydrateSession(request.agentSessionId, request);
    assertDirectExecutionOpen(request);

    if (session.isRunning) {
      throw new Error(`Session ${request.agentSessionId} is already running`);
    }
    if (request.model) {
      session.model = request.model;
    }
    session.thinkingMode = normalizeThinkingMode(request.thinkingMode);
    session.eventMetadata = directEventMetadata(request);

    const userTurn = this.buildUserTurn(request.command, request.images);
    const turnIdentity = this.#turnIdentity(request);
    this.#markSessionRunning(session);
    request.onAbortable?.();
    try {
      const prepared = await this.#sessionStore.prepareUserTurn(
        session.id,
        userTurn.persistedContent,
        turnIdentity,
      );
      assertDirectExecutionOpen(request);
      if (prepared === 'appended') {
        if (session.messages.length >= this.#maxMessagesPerSession) {
          const first = session.messages[0];
          session.messages = [first, ...session.messages.slice(-(this.#maxMessagesPerSession - 2))];
        }
        session.messages.push(userTurn.message);
      } else {
        await this.#refreshSessionMessages(session);
      }

      session.chatId = request.chatId;
      if (prepared === 'turn-complete') {
        this.#markSessionIdle(session);
        this.emitFinished(session.chatId, 0, session.eventMetadata);
        return;
      }
      await this.#runTurnInternal(session, turnIdentity, request);
    } catch (error: unknown) {
      this.#markSessionIdle(session);
      throw error;
    }
  }

  abort(agentSessionId: string): boolean {
    const session = this.#sessions.get(agentSessionId);
    if (!session?.isRunning || session.isFinalizing) return false;

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
      if (session.isFinalizing) continue;
      session.aborted = true;
      session.abortController?.abort();
    }
    this.#sessions.clear();
  }

  async #hydrateSession(
    sessionId: string,
    request: DirectResumeRequest,
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
      isFinalizing: false,
      isRunning: false,
      messages: messages.map((message) => this.persistedToMessage(message)),
      model: request.model || this.config.defaultModel,
      thinkingMode: normalizeThinkingMode(request.thinkingMode),
      startTime: now,
      lastActivityAt: now,
      eventMetadata: directEventMetadata(request),
    };
    this.#sessions.set(sessionId, session);
    return session;
  }

  async #refreshSessionMessages(session: DirectRuntimeSession<TMessage>): Promise<void> {
    const messages = await this.#sessionStore.read(session.id);
    if (!messages) {
      throw new Error(`Cannot refresh ${this.config.runtimeLabel} session without persisted messages: ${session.id}`);
    }
    session.messages = messages.map((message) => this.persistedToMessage(message));
  }

  #turnIdentity(
    request: Pick<DirectStartRequest, 'clientRequestId' | 'clientMessageId' | 'turnId'>,
  ): DirectMessageIdentity {
    return {
      ...(request.clientRequestId ? { clientRequestId: request.clientRequestId } : {}),
      ...(request.clientMessageId ? { clientMessageId: request.clientMessageId } : {}),
      ...(request.turnId ? { turnId: request.turnId } : {}),
    };
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
    session.isFinalizing = false;
    session.aborted = false;
    session.lastActivityAt = Date.now();
    this.emitProcessing(session.chatId, true);
  }

  async #runTurnInternal(
    session: DirectRuntimeSession<TMessage>,
    turnIdentity: DirectMessageIdentity,
    request: Pick<DirectStartRequest, 'executionAdmission'>,
  ): Promise<void> {
    const eventMetadata = session.eventMetadata;
    this.#markSessionRunning(session);
    if (session.aborted) {
      this.#finishAbortedTurn(session, eventMetadata);
      return;
    }

    try {
      markDirectExecutionStarted(request);
      const response = await this.streamSession(session);
      if (session.aborted) {
        this.#finishAbortedTurn(session, eventMetadata);
        return;
      }

      if (!response.trim()) {
        this.#markSessionIdle(session);
        this.emitFailed(
          session.chatId,
          `Empty response from ${this.config.runtimeLabel}`,
          eventMetadata,
        );
        return;
      }

      session.isFinalizing = true;
      await this.#sessionStore.append(
        session.id,
        'assistant',
        response,
        turnIdentity,
      );
      session.messages.push(this.buildAssistantMessage(response));
      this.emitMessages(session.chatId, [
        new AssistantMessage(new Date().toISOString(), response),
      ], eventMetadata);
      this.#markSessionIdle(session);
      this.emitFinished(session.chatId, 0, eventMetadata);
    } catch (error: unknown) {
      if (session.aborted) {
        this.#finishAbortedTurn(session, eventMetadata);
        return;
      }
      this.#markSessionIdle(session);
      const failure = error instanceof Error ? error : new Error(String(error));
      this.emitFailed(session.chatId, failure.message, eventMetadata);
      throw failure;
    } finally {
      session.isFinalizing = false;
      this.#markSessionIdle(session);
    }
  }

  #finishAbortedTurn(
    session: DirectRuntimeSession<TMessage>,
    eventMetadata: RuntimeEventMetadata,
  ): void {
    this.#markSessionIdle(session);
    this.emitFinished(session.chatId, 0, eventMetadata);
  }
}
