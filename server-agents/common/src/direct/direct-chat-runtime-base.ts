import {
  normalizeThinkingMode,
  type ThinkingMode,
} from '@garcon/common/chat-modes';
import { AssistantMessage } from '@garcon/common/chat-types';
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
import {
  directSessionUnavailable,
  loadDirectSessionRequired,
} from './native-session.js';
import {
  DirectSessionStore,
  type DirectResponsesCheckpointV1,
  type DirectSessionRecordV1,
} from './session-store.js';

const DEFAULT_MAX_MESSAGES_PER_SESSION = 200;

export interface DirectRuntimeSession<TMessage> {
  abortController: AbortController | null;
  aborted: boolean;
  chatId: string;
  history: DirectSessionRecordV1[];
  historyDirty: boolean;
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

export interface DirectTurnCompletion {
  readonly content: string;
  readonly checkpoint: DirectResponsesCheckpointV1 | null;
}

export interface DirectChatRuntimeBaseConfig {
  runtimeLabel: string;
  defaultModel: string;
  sessions: DirectSessionStore;
  maxMessagesPerSession?: number;
}

export abstract class DirectChatRuntimeBase<
  TMessage,
  TConfig extends DirectChatRuntimeBaseConfig,
> {
  protected readonly config: TConfig;
  readonly #maxMessagesPerSession: number;
  readonly #sessionsStore: DirectSessionStore;
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
    this.#sessionsStore = config.sessions;
    this.#maxMessagesPerSession = config.maxMessagesPerSession
      ?? DEFAULT_MAX_MESSAGES_PER_SESSION;
    if (!Number.isSafeInteger(this.#maxMessagesPerSession) || this.#maxMessagesPerSession < 2) {
      throw new TypeError('Direct runtime message limit must be at least two');
    }
  }

  protected abstract buildUserMessage(
    command: string,
    images?: readonly AgentAttachment[],
  ): TMessage;

  protected abstract buildAssistantMessage(content: string): TMessage;

  protected abstract streamSession(
    session: DirectRuntimeSession<TMessage>,
  ): Promise<DirectTurnCompletion>;

  async startSession(request: DirectStartRequest): Promise<DirectStartedSession> {
    assertDirectExecutionOpen(request);
    const sessionId = this.#sessionsStore.createSessionId();
    const snapshot = await this.#sessionsStore.create({
      sessionId,
      runId: request.operation.runId,
      content: request.command,
      attachments: request.images ?? [],
    });
    try {
      assertDirectExecutionOpen(request);
    } catch (error) {
      await this.#sessionsStore.delete(sessionId).catch(() => undefined);
      throw error;
    }

    const now = Date.now();
    const session: DirectRuntimeSession<TMessage> = {
      abortController: null,
      aborted: false,
      chatId: request.chatId,
      history: [...snapshot.records],
      historyDirty: false,
      id: sessionId,
      isFinalizing: false,
      isRunning: false,
      messages: this.#projectMessages(snapshot.records),
      model: request.model || this.config.defaultModel,
      thinkingMode: normalizeThinkingMode(request.thinkingMode),
      startTime: now,
      lastActivityAt: now,
      operation: request.operation,
    };

    this.#sessions.set(sessionId, session);
    const started = {
      agentSessionId: sessionId,
      nativeSession: this.#sessionsStore.nativeReference(sessionId),
    };
    request.onSessionActivated?.(started);
    void this.#runTurnInternal(session, request).catch(() => undefined);
    return started;
  }

  async runTurn(request: DirectResumeRequest): Promise<void> {
    assertDirectExecutionOpen(request);
    const session = this.#sessions.get(request.agentSessionId)
      ?? await this.#hydrateSession(request);
    assertDirectExecutionOpen(request);

    if (session.isRunning) {
      throw new Error(`Session ${request.agentSessionId} is already running`);
    }
    if (request.model) session.model = request.model;
    session.thinkingMode = normalizeThinkingMode(request.thinkingMode);
    session.operation = request.operation;
    this.#markSessionRunning(session);
    try {
      if (session.historyDirty) {
        const snapshot = await loadDirectSessionRequired(
          this.#sessionsStore,
          request.agentSessionId,
          request.nativeSession,
          request.executionAdmission?.signal ?? new AbortController().signal,
        );
        session.history = [...snapshot.records];
        session.messages = this.#projectMessages(snapshot.records);
        session.historyDirty = false;
        assertDirectExecutionOpen(request);
      }
      const user = await this.#appendUser(request);
      session.history.push(user);
      session.messages = this.#projectMessages(session.history);
      session.chatId = request.chatId;
      this.#markSuccessorHistoryDirty(session);
      assertDirectExecutionOpen(request);
      await this.#runTurnInternal(session, request);
    } catch (error) {
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

  forgetSession(agentSessionId: string): void {
    const session = this.#sessions.get(agentSessionId);
    if (session?.isRunning) {
      throw new Error(`Session ${agentSessionId} is already running`);
    }
    this.#sessions.delete(agentSessionId);
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

  async #hydrateSession(request: DirectResumeRequest): Promise<DirectRuntimeSession<TMessage>> {
    const snapshot = await loadDirectSessionRequired(
      this.#sessionsStore,
      request.agentSessionId,
      request.nativeSession,
      request.executionAdmission?.signal ?? new AbortController().signal,
    );
    const now = Date.now();
    const session: DirectRuntimeSession<TMessage> = {
      abortController: null,
      aborted: false,
      chatId: request.chatId,
      history: [...snapshot.records],
      historyDirty: false,
      id: request.agentSessionId,
      isFinalizing: false,
      isRunning: false,
      messages: this.#projectMessages(snapshot.records),
      model: request.model || this.config.defaultModel,
      thinkingMode: normalizeThinkingMode(request.thinkingMode),
      startTime: now,
      lastActivityAt: now,
      operation: request.operation,
    };
    this.#sessions.set(request.agentSessionId, session);
    return session;
  }

  async #appendUser(request: DirectResumeRequest) {
    try {
      this.#sessionsStore.sessionIdFromReference(request.nativeSession, request.agentSessionId);
      return await this.#sessionsStore.appendUser({
        sessionId: request.agentSessionId,
        runId: request.operation.runId,
        content: request.command,
        attachments: request.images ?? [],
      });
    } catch (error) {
      throw directSessionUnavailable(error);
    }
  }

  #projectMessages(records: readonly DirectSessionRecordV1[]): TMessage[] {
    const projected = records.length <= this.#maxMessagesPerSession
      ? records
      : [records[0]!, ...records.slice(-(this.#maxMessagesPerSession - 1))];
    return projected.map((record) => (
      record.type === 'user'
        ? this.buildUserMessage(record.content, record.attachments)
        : this.buildAssistantMessage(record.content)
    ));
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
      const completion = await this.streamSession(session);
      const response = completion.content;

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
      let assistant;
      try {
        assistant = await this.#sessionsStore.appendAssistant({
          sessionId: session.id,
          runId: operation.runId,
          content: response,
          checkpoint: completion.checkpoint,
        });
      } catch (error) {
        throw directSessionUnavailable(error);
      }
      session.history.push(assistant);
      session.messages = this.#projectMessages(session.history);
      this.#markSuccessorHistoryDirty(session);
      operation.publish({
        type: 'rows',
        rows: runtimeRows([new AssistantMessage(assistant.at, response)]),
      });
      this.#markSessionIdle(session);
      operation.publish({ type: 'run-ended', runId: operation.runId, outcome: 'finished' });
    } catch (error) {
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
        error: {
          code: 'code' in failure && typeof failure.code === 'string'
            ? failure.code
            : 'PROVIDER_FAILURE',
          message: failure.message,
        },
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

  #markSuccessorHistoryDirty(session: DirectRuntimeSession<TMessage>): void {
    const current = this.#sessions.get(session.id);
    if (current && current !== session) current.historyDirty = true;
  }
}
