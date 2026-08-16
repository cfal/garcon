import crypto from 'crypto';
import {
  normalizeThinkingMode,
  type ThinkingMode,
} from '@garcon/common/chat-modes';
import { AssistantMessage, type ChatMessage } from '@garcon/common/chat-types';
import { attachNativeMessageSource } from '@garcon/server-agent-common/shared/native-message-source';
import { directMessageNativeSource } from './direct-message-native-source.js';
import type { SharedModelOption } from '@garcon/common/models';
import {
  assertDirectExecutionOpen,
  markDirectExecutionStarted,
  type DirectResumeRequest,
  type DirectStartedSession,
  type DirectStartRequest,
} from './runtime-types.js';
import type { AgentAttachment } from '@garcon/common/agent-execution';
import { IdleSessionPurger } from '@garcon/server-agent-common/shared/idle-session-purger';
import type { AgentRuntimeOperation } from '@garcon/server-agent-common/execution/runtime-events';
import { runtimeRows } from '@garcon/server-agent-common/execution/runtime-events';

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
  operation: AgentRuntimeOperation;
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
> {
  protected readonly config: TConfig;
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
    this.config = config;
    this.#maxMessagesPerSession = config.maxMessagesPerSession ?? DEFAULT_MAX_MESSAGES_PER_SESSION;
  }

  protected abstract buildUserTurn(command: string, images?: readonly AgentAttachment[]): DirectUserTurn<TMessage>;

  protected abstract buildAssistantMessage(content: string): TMessage;

  protected abstract contextMessage(message: ChatMessage): TMessage | null;

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
      messages: [...this.#contextMessages(request.priorContext), userTurn.message],
      model: request.model || this.config.defaultModel,
      thinkingMode: normalizeThinkingMode(request.thinkingMode),
      startTime: now,
      lastActivityAt: now,
      operation: request.operation,
    };

    assertDirectExecutionOpen(request);
    this.#sessions.set(sessionId, session);
    const started = {
      agentSessionId: sessionId,
      nativePath: this.config.getSessionFilePath(sessionId),
    };
    request.onSessionActivated?.(started);
    void this.#runTurnInternal(session, request).catch(() => undefined);

    return started;
  }

  async runTurn(request: DirectResumeRequest): Promise<void> {
    assertDirectExecutionOpen(request);
    const session = this.#sessions.get(request.agentSessionId)
      ?? this.#hydrateSession(request.agentSessionId, request);
    assertDirectExecutionOpen(request);

    if (session.isRunning) {
      throw new Error(`Session ${request.agentSessionId} is already running`);
    }
    if (request.model) {
      session.model = request.model;
    }
    session.thinkingMode = normalizeThinkingMode(request.thinkingMode);
    session.operation = request.operation;

    const userTurn = this.buildUserTurn(request.command, request.images);
    this.#markSessionRunning(session);
    try {
      assertDirectExecutionOpen(request);
      session.messages = this.#contextMessages(request.priorContext);
      if (session.messages.length >= this.#maxMessagesPerSession) {
        session.messages = session.messages.slice(-(this.#maxMessagesPerSession - 1));
      }
      session.messages.push(userTurn.message);

      session.chatId = request.chatId;
      await this.#runTurnInternal(session, request);
    } catch (error: unknown) {
      this.#markSessionIdle(session);
      throw error;
    }
  }

  abort(agentSessionId: string): boolean {
    const session = this.#sessions.get(agentSessionId);
    if (!session?.isRunning || session.isFinalizing) return false;

    this.#sessions.delete(agentSessionId);
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

  #hydrateSession(
    sessionId: string,
    request: DirectResumeRequest,
  ): DirectRuntimeSession<TMessage> {
    const now = Date.now();
    const session: DirectRuntimeSession<TMessage> = {
      abortController: null,
      aborted: false,
      chatId: request.chatId,
      id: sessionId,
      isFinalizing: false,
      isRunning: false,
      messages: this.#contextMessages(request.priorContext),
      model: request.model || this.config.defaultModel,
      thinkingMode: normalizeThinkingMode(request.thinkingMode),
      startTime: now,
      lastActivityAt: now,
      operation: request.operation,
    };
    this.#sessions.set(sessionId, session);
    return session;
  }

  #contextMessages(messages: readonly ChatMessage[] | undefined): TMessage[] {
    return (messages ?? []).flatMap((message) => {
      const translated = this.contextMessage(message);
      return translated ? [translated] : [];
    });
  }

  #markSessionIdle(session: DirectRuntimeSession<TMessage>): void {
    if (!session.isRunning) return;
    session.isRunning = false;
    session.lastActivityAt = Date.now();
  }

  #markSessionRunning(session: DirectRuntimeSession<TMessage>): void {
    if (session.isRunning) return;
    session.isRunning = true;
    session.isFinalizing = false;
    session.aborted = false;
    session.lastActivityAt = Date.now();
  }

  async #runTurnInternal(
    session: DirectRuntimeSession<TMessage>,
    request: Pick<DirectStartRequest, 'executionAdmission'>,
  ): Promise<void> {
    const operation = session.operation;
    this.#markSessionRunning(session);
    if (session.aborted) {
      this.#finishAbortedTurn(session, operation);
      return;
    }

    try {
      if (request.executionAdmission) await markDirectExecutionStarted(request);
      const response = await this.streamSession(session);

      if (!response.trim()) {
        this.#markSessionIdle(session);
        operation.publish({
          type: 'run-ended',
          runId: operation.runId,
          outcome: 'failed',
          error: {
            code: 'PROVIDER_FAILURE',
            message: `Empty response from ${this.config.runtimeLabel}`,
          },
        });
        return;
      }

      session.isFinalizing = true;
      session.messages.push(this.buildAssistantMessage(response));
      // The live row carries the same turn-scoped identity the importer derives, so
      // reloaded history and streamed history dedupe against one key.
      const liveMessage = attachNativeMessageSource(
        new AssistantMessage(new Date().toISOString(), response),
        directMessageNativeSource({ role: 'assistant', turnId: operation.runId }),
      );
      operation.publish({ type: 'rows', rows: runtimeRows([liveMessage]) });
      this.#markSessionIdle(session);
      operation.publish({ type: 'run-ended', runId: operation.runId, outcome: 'finished' });
    } catch (error: unknown) {
      if (session.aborted) {
        this.#finishAbortedTurn(session, operation);
        return;
      }
      this.#markSessionIdle(session);
      const failure = error instanceof Error ? error : new Error(String(error));
      operation.publish({
        type: 'run-ended',
        runId: operation.runId,
        outcome: 'failed',
        error: { code: 'PROVIDER_FAILURE', message: failure.message },
      });
      throw failure;
    } finally {
      session.isFinalizing = false;
      this.#markSessionIdle(session);
    }
  }

  #finishAbortedTurn(
    session: DirectRuntimeSession<TMessage>,
    operation: AgentRuntimeOperation,
  ): void {
    this.#markSessionIdle(session);
    operation.publish({ type: 'run-ended', runId: operation.runId, outcome: 'finished' });
  }
}
