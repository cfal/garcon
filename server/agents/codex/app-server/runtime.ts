import { ErrorMessage, PermissionCancelledMessage, PermissionResolvedMessage } from "../../../../common/chat-types.js";
import { promises as fs } from 'fs';
import { AgentEventEmitterRuntime } from "../../shared/event-emitter-runtime.js";
import { loadCodexChatMessages, getCodexPreviewFromNativePath } from "../history-loader.js";
import type { AgentChatEntry, ResumeTurnRequest, StartSessionRequest, StartedAgentSession } from "../../session-types.js";
import { buildApprovalMessage, buildApprovalResponse, createPendingApproval, isApprovalRequest, type CodexPendingApproval } from './approvals.js';
import { CodexAppServerClient, CodexAppServerRpcError, type CodexAppServerClientOptions, type CodexAppServerMetric } from './client.js';
import {
  convertCodexAppServerLiveItem,
  convertCodexAppServerThread,
  convertCodexAppServerTurnMissingItems,
  getCodexThreadPreview,
} from './converter.js';
import { waitForMaterializedThread } from './durability.js';
import { CodexTurnMessageDeduper } from './message-deduper.js';
import type {
  ErrorNotification,
  ItemCompletedNotification,
  JsonRpcNotification,
  JsonRpcServerRequest,
  CodexThread,
  ThreadReadResponse,
  TurnCompletedNotification,
  TurnStartedNotification,
} from './protocol.js';
import {
  buildCodexEnv,
  buildThreadForkParams,
  buildThreadResumeParams,
  buildThreadStartParams,
  buildTurnStartParams,
  writeImagesToTempFiles,
} from './request-builders.js';

type RunningStatus = 'running' | 'completing' | 'completed' | 'failed' | 'aborted';

interface RunningCodexSession {
  chatId: string;
  threadId: string;
  nativePath: string | null;
  client: CodexAppServerClient;
  activeTurnId: string | null;
  messageDeduper: CodexTurnMessageDeduper;
  status: RunningStatus;
  startedAt: string;
}

interface CodexForkSessionRequest {
  sourceSession: AgentChatEntry;
  envOverrides?: Record<string, string>;
  codexConfig?: StartSessionRequest['codexConfig'];
}

export interface CodexAppServerRuntimeOptions {
  createClient?: (options?: CodexAppServerClientOptions) => CodexAppServerClient;
  materializationTimeoutMs?: number;
  terminalBackfillTimeoutMs?: number;
}

export class CodexAppServerRuntime extends AgentEventEmitterRuntime {
  #sessions = new Map<string, RunningCodexSession>();
  #pendingApprovals = new Map<string, CodexPendingApproval & { client: CodexAppServerClient }>();
  #utilityClient: CodexAppServerClient | null = null;
  #utilityQueue: Promise<unknown> = Promise.resolve();
  #threadListCaches = new Map<boolean, Promise<Map<string, CodexThread>>>();
  #createClient: (options?: CodexAppServerClientOptions) => CodexAppServerClient;
  #materializationTimeoutMs: number;
  #terminalBackfillTimeoutMs: number;

  constructor(options: CodexAppServerRuntimeOptions = {}) {
    super();
    this.#createClient = options.createClient ?? ((clientOptions) => new CodexAppServerClient(clientOptions));
    this.#materializationTimeoutMs = options.materializationTimeoutMs ?? 10_000;
    this.#terminalBackfillTimeoutMs = options.terminalBackfillTimeoutMs ?? 2_000;
  }

  async startSession(request: StartSessionRequest): Promise<StartedAgentSession> {
    const client = this.#newClient(request);
    let cleanupImages: (() => Promise<void>) | null = null;
    let activeSession: RunningCodexSession | null = null;

    try {
      const started = await client.startThread(buildThreadStartParams(request));
      const threadId = started.thread.id;
      const session = this.#activateSession({
        chatId: request.chatId,
        threadId,
        nativePath: started.thread.path,
        client,
      });
      activeSession = session;
      this.emitProcessing(request.chatId, true);
      this.emitSessionCreated(request.chatId);

      const images = await writeImagesToTempFiles(request.images);
      cleanupImages = images.cleanup;
      const turn = await client.startTurn(buildTurnStartParams({
        threadId,
        command: request.command,
        imagePaths: images.paths,
        model: request.model,
        projectPath: request.projectPath,
        permissionMode: request.permissionMode,
        thinkingMode: request.thinkingMode,
      }));
      session.activeTurnId = turn.turn.id;

      const nativePath = await waitForMaterializedThread(started.thread, {
        timeoutMs: this.#materializationTimeoutMs,
      });
      session.nativePath = nativePath;
      this.#threadListCaches.clear();
      return { agentSessionId: threadId, nativePath };
    } catch (error) {
      const message = humanizeCodexAppServerError(error);
      if (activeSession) {
        this.#finishSession(activeSession, { failedMessage: message });
      } else {
        client.shutdown();
        this.emitProcessing(request.chatId, false);
        this.emitFailed(request.chatId, message);
      }
      throw error;
    } finally {
      await cleanupImages?.();
    }
  }

  async runTurn(request: ResumeTurnRequest): Promise<void> {
    const client = this.#newClient(request);
    let cleanupImages: (() => Promise<void>) | null = null;
    let activeSession: RunningCodexSession | null = null;

    try {
      const resumed = await client.resumeThread(buildThreadResumeParams(request));
      const session = this.#activateSession({
        chatId: request.chatId,
        threadId: resumed.thread.id,
        nativePath: resumed.thread.path ?? request.nativePath ?? null,
        client,
      });
      activeSession = session;
      this.emitProcessing(request.chatId, true);

      const images = await writeImagesToTempFiles(request.images);
      cleanupImages = images.cleanup;
      const turn = await client.startTurn(buildTurnStartParams({
        threadId: resumed.thread.id,
        command: request.command,
        imagePaths: images.paths,
        model: request.model,
        projectPath: request.projectPath,
        permissionMode: request.permissionMode,
        thinkingMode: request.thinkingMode,
      }));
      session.activeTurnId = turn.turn.id;
    } catch (error) {
      const message = humanizeCodexAppServerError(error);
      if (activeSession) {
        this.#finishSession(activeSession, { failedMessage: message });
      } else {
        client.shutdown();
        this.emitProcessing(request.chatId, false);
        this.emitFailed(request.chatId, message);
      }
      throw error;
    } finally {
      await cleanupImages?.();
    }
  }

  abort(agentSessionId: string): boolean {
    const session = this.#sessions.get(agentSessionId);
    if (!session) return false;
    session.status = 'aborted';

    const interrupt = session.activeTurnId
      ? session.client.interruptTurn(session.threadId, session.activeTurnId).catch((error: Error) => {
        console.warn(`codex: failed to interrupt turn ${session.activeTurnId}:`, error.message);
      })
      : Promise.resolve();

    void interrupt.finally(() => {
      this.#finishSession(session, { aborted: true });
    });
    return true;
  }

  isRunning(agentSessionId: string): boolean {
    const status = this.#sessions.get(agentSessionId)?.status;
    return status === 'running' || status === 'completing';
  }

  getRunningSessions(): Array<{ id: string; status: string; startedAt: string }> {
    return Array.from(this.#sessions.values())
      .filter((session) => session.status === 'running' || session.status === 'completing')
      .map((session) => ({ id: session.threadId, status: session.status, startedAt: session.startedAt }));
  }

  async loadMessages(session: AgentChatEntry): Promise<unknown[]> {
    if (!session.agentSessionId) return this.#loadJsonlMessages(session);

    try {
      const response = await this.#readThread(session.agentSessionId, true);
      return convertCodexAppServerThread(response.thread);
    } catch (error) {
      console.warn('codex: app-server thread/read failed, falling back to JSONL:', (error as Error).message);
      return this.#loadJsonlMessages(session);
    }
  }

  async getPreview(session: AgentChatEntry): Promise<unknown> {
    if (!session.agentSessionId) return this.#getJsonlPreview(session);

    const listedThread = await this.#listedThreadForPreview(session.agentSessionId);
    if (listedThread) return getCodexThreadPreview(listedThread);

    if (session.nativePath) {
      const jsonlPreview = await this.#getJsonlPreview(session);
      if (jsonlPreview) return jsonlPreview;
    }

    try {
      const response = await this.#readThread(session.agentSessionId, false);
      return getCodexThreadPreview(response.thread);
    } catch (error) {
      console.warn('codex: app-server preview failed, falling back to JSONL:', (error as Error).message);
      return this.#getJsonlPreview(session);
    }
  }

  async forkSession(args: CodexForkSessionRequest): Promise<StartedAgentSession | null> {
    const sourceSession = args.sourceSession;
    const sourceThreadId = sourceSession.agentSessionId;
    if (!sourceThreadId) return null;

    return this.#withOperationClient(args, async (client) => {
      const forked = await client.forkThread(buildThreadForkParams({
        agentSessionId: sourceThreadId,
        nativePath: sourceSession.nativePath,
        model: sourceSession.model,
        projectPath: sourceSession.projectPath,
        codexConfig: args.codexConfig,
      }));
      await this.#unsubscribeBestEffort(client, forked.thread.id);
      const nativePath = await waitForMaterializedThread(forked.thread, {
        timeoutMs: this.#materializationTimeoutMs,
      });
      this.#threadListCaches.clear();
      return { agentSessionId: forked.thread.id, nativePath };
    });
  }

  async resolveNativePath(session: AgentChatEntry): Promise<string | null> {
    if (!session.agentSessionId) return null;

    const threads = await this.#getThreadListCache(false);
    const nativePath = threads?.get(session.agentSessionId)?.path ?? null;
    if (!nativePath) return null;

    try {
      await fs.access(nativePath);
      return nativePath;
    } catch {
      return null;
    }
  }

  async resolvePermission(permissionRequestId: string, decision: { allow: boolean; alwaysAllow?: boolean }): Promise<void> {
    const pending = this.#pendingApprovals.get(permissionRequestId);
    if (!pending) {
      console.warn('codex: resolvePermission, no pending entry for', permissionRequestId);
      return;
    }

    this.#pendingApprovals.delete(permissionRequestId);
    pending.client.respond(pending.requestId, buildApprovalResponse(pending, decision));
    this.emitMessages(pending.chatId, [
      new PermissionResolvedMessage(new Date().toISOString(), permissionRequestId, Boolean(decision.allow)),
    ]);
  }

  startPurgeTimer(): ReturnType<typeof setInterval> {
    return setInterval(() => {
      for (const [threadId, session] of this.#sessions.entries()) {
        if (session.status !== 'running') this.#sessions.delete(threadId);
      }
    }, 5 * 60 * 1000);
  }

  shutdown(): void {
    for (const session of this.#sessions.values()) {
      session.client.shutdown();
    }
    this.#sessions.clear();
    this.#utilityClient?.shutdown();
    this.#utilityClient = null;
    this.#utilityQueue = Promise.resolve();
    this.#threadListCaches.clear();
  }

  #newClient(request: Pick<StartSessionRequest, 'envOverrides' | 'codexConfig'>): CodexAppServerClient {
    const client = this.#createClient({ env: buildCodexEnv(request.envOverrides, request.codexConfig) });
    this.#wireClient(client);
    return client;
  }

  async #withOperationClient<T>(
    request: Pick<StartSessionRequest, 'envOverrides' | 'codexConfig'>,
    operation: (client: CodexAppServerClient) => Promise<T>,
  ): Promise<T> {
    const client = this.#newClient(request);
    try {
      return await operation(client);
    } finally {
      client.shutdown();
    }
  }

  async #utility(): Promise<CodexAppServerClient> {
    if (!this.#utilityClient) {
      const client = this.#createClient();
      this.#utilityClient = client;
      this.#wireClient(client);
      client.on('exit', () => {
        if (this.#utilityClient === client) this.#utilityClient = null;
      });
    }
    await this.#utilityClient.connect();
    return this.#utilityClient;
  }

  async #readThread(threadId: string, includeTurns: boolean): Promise<ThreadReadResponse> {
    return this.#withUtilityClient((client) => client.readThread(threadId, includeTurns));
  }

  async #listedThreadForPreview(threadId: string): Promise<CodexThread | null> {
    return Promise.race([
      this.#getThreadListCache()
        .then((threads) => threads.get(threadId) ?? null)
        .catch((error) => {
          console.warn('codex: app-server thread/list preview cache failed:', (error as Error).message);
          return null;
        }),
      delay(500).then(() => null),
    ]);
  }

  #getThreadListCache(useStateDbOnly = true): Promise<Map<string, CodexThread>> {
    const cached = this.#threadListCaches.get(useStateDbOnly);
    if (cached) return cached;

    const pending = this.#loadThreadListCache(useStateDbOnly).catch((error) => {
      this.#threadListCaches.delete(useStateDbOnly);
      throw error;
    });
    this.#threadListCaches.set(useStateDbOnly, pending);
    return pending;
  }

  async #loadThreadListCache(useStateDbOnly: boolean): Promise<Map<string, CodexThread>> {
    const threads = new Map<string, CodexThread>();
    let cursor: string | null = null;
    let pageCount = 0;

    do {
      const response = await this.#withUtilityClient((client) => client.listThreads({
        cursor,
        limit: 500,
        sortKey: 'updated_at',
        sortDirection: 'desc',
        archived: false,
        useStateDbOnly,
      }));
      for (const thread of response.data ?? []) {
        threads.set(thread.id, thread);
      }
      cursor = response.nextCursor ?? null;
      pageCount += 1;
    } while (cursor && pageCount < 20);

    void this.#sampleUtilityLoadedThreads();
    return threads;
  }

  async #withUtilityClient<T>(operation: (client: CodexAppServerClient) => Promise<T>): Promise<T> {
    const scheduled = this.#utilityQueue
      .catch(() => undefined)
      .then(() => this.#runUtilityOperation(operation));
    this.#utilityQueue = scheduled.catch(() => undefined);
    return scheduled;
  }

  async #runUtilityOperation<T>(operation: (client: CodexAppServerClient) => Promise<T>): Promise<T> {
    let attempt = 0;

    while (true) {
      const client = await this.#utility();
      try {
        return await operation(client);
      } catch (error) {
        if (!isUtilityOverload(error) || attempt >= 3) throw error;
        attempt += 1;
        await delay(25 * attempt);
      }
    }
  }

  async #sampleUtilityLoadedThreads(): Promise<void> {
    const client = this.#utilityClient;
    if (!client) return;
    try {
      const response = await client.loadedThreads();
      const metric: CodexAppServerMetric = {
        name: 'codex.app_server.loaded_threads',
        loadedThreadCount: response.data.length,
      };
      this.emit('metric', metric);
    } catch (error) {
      console.warn('codex: failed to sample loaded app-server threads:', (error as Error).message);
    }
  }

  async #unsubscribeBestEffort(client: CodexAppServerClient, threadId: string): Promise<void> {
    try {
      await client.unsubscribeThread(threadId);
    } catch (error) {
      console.warn(`codex: failed to unsubscribe app-server thread ${threadId}:`, (error as Error).message);
    }
  }

  #activateSession(args: {
    chatId: string;
    threadId: string;
    nativePath: string | null;
    client: CodexAppServerClient;
  }): RunningCodexSession {
    const session: RunningCodexSession = {
      chatId: args.chatId,
      threadId: args.threadId,
      nativePath: args.nativePath,
      client: args.client,
      activeTurnId: null,
      messageDeduper: new CodexTurnMessageDeduper(),
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    this.#sessions.set(args.threadId, session);
    return session;
  }

  #wireClient(client: CodexAppServerClient): void {
    client.on('notification', (notification: JsonRpcNotification) => this.#handleNotification(client, notification));
    client.on('serverRequest', (request: JsonRpcServerRequest) => this.#handleServerRequest(client, request));
    client.on('stderr', (line: string) => console.warn('codex app-server:', line));
    client.on('warning', (message: string) => console.warn(message));
    client.on('metric', (metric: unknown) => this.emit('metric', metric));
    client.on('exit', (code: number) => this.#handleClientExit(client, code));
  }

  #handleNotification(client: CodexAppServerClient, notification: JsonRpcNotification): void {
    switch (notification.method) {
      case 'turn/started':
        this.#handleTurnStarted(notification.params as TurnStartedNotification);
        break;
      case 'item/completed':
        this.#handleItemCompleted(notification.params as ItemCompletedNotification);
        break;
      case 'turn/completed':
        this.#handleTurnCompleted(notification.params as TurnCompletedNotification);
        break;
      case 'error':
        this.#handleErrorNotification(client, notification.params as ErrorNotification);
        break;
    }
  }

  #handleTurnStarted(params: TurnStartedNotification): void {
    const session = this.#sessions.get(params.threadId);
    if (!session) return;
    session.activeTurnId = params.turn.id;
    session.status = 'running';
  }

  #handleItemCompleted(params: ItemCompletedNotification): void {
    const session = this.#sessions.get(params.threadId);
    if (!session) return;
    const messages = convertCodexAppServerLiveItem(params.item);
    session.messageDeduper.recordItem(params.item, messages);
    if (messages.length) this.emitMessages(session.chatId, messages);
  }

  #handleTurnCompleted(params: TurnCompletedNotification): void {
    void this.#completeTurn(params).catch((error) => {
      const session = this.#sessions.get(params.threadId);
      if (!session) return;
      this.#finishSession(session, { failedMessage: humanizeCodexAppServerError(error) });
    });
  }

  async #completeTurn(params: TurnCompletedNotification): Promise<void> {
    const session = this.#sessions.get(params.threadId);
    if (!session) return;
    if (params.turn.status === 'failed') {
      this.#finishSession(session, {
        failedMessage: params.turn.error?.message || 'Codex turn failed',
      });
      return;
    }
    const aborted = params.turn.status === 'interrupted' || session.status === 'aborted';
    session.status = 'completing';
    this.#threadListCaches.clear();
    const turnId = params.turn.id ?? session.activeTurnId;
    if (!aborted && turnId) {
      await this.#backfillCompletedTurn(session, turnId).catch((error) => {
        console.warn('codex: terminal thread/read backfill failed:', (error as Error).message);
      });
    }
    this.#finishSession(session, { aborted });
  }

  async #backfillCompletedTurn(session: RunningCodexSession, turnId: string): Promise<void> {
    const response = await this.#readThreadForTerminalBackfill(session);
    const turn = response.thread.turns?.find((candidate) => candidate.id === turnId);
    if (!turn) return;

    for (const item of turn.items ?? []) {
      const messages = convertCodexAppServerTurnMissingItems({ ...turn, items: [item] }, new Set(), {
        includeUserMessages: false,
      });
      if (session.messageDeduper.shouldEmitItem(item, messages)) {
        this.emitMessages(session.chatId, messages);
      }
      session.messageDeduper.recordItem(item, messages);
    }
  }

  async #readThreadForTerminalBackfill(session: RunningCodexSession): Promise<ThreadReadResponse> {
    try {
      return await withTimeout(
        session.client.readThread(session.threadId, true),
        this.#terminalBackfillTimeoutMs,
        `active thread/read timed out for ${session.threadId}`,
      );
    } catch (error) {
      console.warn('codex: active app-server terminal backfill failed, retrying utility app-server:', (error as Error).message);
      return withTimeout(
        this.#readThread(session.threadId, true),
        this.#terminalBackfillTimeoutMs,
        `utility thread/read timed out for ${session.threadId}`,
      );
    }
  }

  #handleErrorNotification(client: CodexAppServerClient, params: ErrorNotification): void {
    const message = params.error?.message || params.error?.additionalDetails || 'Codex app-server error';
    const session = params.threadId ? this.#sessions.get(params.threadId) : this.#sessionForClient(client);
    if (!session) return;
    this.emitMessages(session.chatId, [new ErrorMessage(new Date().toISOString(), message)]);
    this.#finishSession(session, { failedMessage: message });
  }

  #handleServerRequest(client: CodexAppServerClient, request: JsonRpcServerRequest): void {
    if (!isApprovalRequest(request)) {
      client.reject(request.id, -32601, `Unsupported Codex app-server request: ${request.method}`);
      return;
    }

    const params = request.params && typeof request.params === 'object' ? request.params as Record<string, unknown> : {};
    const threadId = typeof params.threadId === 'string'
      ? params.threadId
      : typeof params.conversationId === 'string'
        ? params.conversationId
        : null;
    const session = threadId ? this.#sessions.get(threadId) : this.#sessionForClient(client);
    if (!session) {
      client.respond(request.id, denialResponseForRequest(request.method));
      return;
    }

    const pending = { ...createPendingApproval(session.chatId, request), client };
    this.#pendingApprovals.set(pending.permissionRequestId, pending);
    this.emitMessages(session.chatId, [buildApprovalMessage(pending)]);
  }

  #handleClientExit(client: CodexAppServerClient, code: number): void {
    const session = this.#sessionForClient(client);
    if (!session || session.status !== 'running') return;
    this.#finishSession(session, { failedMessage: `Codex app-server exited with code ${code}` });
  }

  #finishSession(session: RunningCodexSession, opts: { failedMessage?: string; aborted?: boolean } = {}): void {
    if (!this.#sessions.has(session.threadId)) return;

    this.#sessions.delete(session.threadId);
    this.#threadListCaches.clear();
    session.status = opts.failedMessage ? 'failed' : opts.aborted ? 'aborted' : 'completed';
    this.#cancelPendingApprovals(session.chatId, opts.aborted ? 'aborted' : 'session-complete');
    this.emitProcessing(session.chatId, false);

    if (opts.failedMessage) {
      this.emitFailed(session.chatId, opts.failedMessage);
    } else if (!opts.aborted) {
      this.emitFinished(session.chatId);
    }

    session.client.shutdown();
  }

  #cancelPendingApprovals(chatId: string, reason: 'cancelled' | 'session-complete' | 'aborted'): void {
    const messages: PermissionCancelledMessage[] = [];
    for (const [permissionRequestId, pending] of this.#pendingApprovals.entries()) {
      if (pending.chatId !== chatId) continue;
      this.#pendingApprovals.delete(permissionRequestId);
      messages.push(new PermissionCancelledMessage(new Date().toISOString(), permissionRequestId, reason));
    }
    this.emitMessages(chatId, messages);
  }

  #sessionForClient(client: CodexAppServerClient): RunningCodexSession | null {
    for (const session of this.#sessions.values()) {
      if (session.client === client) return session;
    }
    return null;
  }

  #loadJsonlMessages(session: AgentChatEntry): Promise<unknown[]> {
    return loadCodexChatMessages(session.nativePath);
  }

  #getJsonlPreview(session: AgentChatEntry): Promise<unknown> {
    return getCodexPreviewFromNativePath(session.nativePath);
  }
}

function denialResponseForRequest(method: string): unknown {
  if (method === 'item/commandExecution/requestApproval') return { decision: 'decline' };
  if (method === 'item/fileChange/requestApproval') return { decision: 'decline' };
  if (method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
  return { decision: 'denied' };
}

function humanizeCodexAppServerError(error: unknown): string {
  const raw = String((error as Error)?.message || error || '');
  if (/not found|ENOENT.*codex|spawn codex/i.test(raw)) {
    return 'Codex CLI is not installed or not in PATH. Install it with: npm i -g @openai/codex';
  }
  if (/authentication|unauthorized|401|api.?key/i.test(raw)) {
    return 'Codex authentication failed. Run "codex" in your terminal to sign in.';
  }
  if (/rate.?limit|429/i.test(raw)) {
    return 'Codex rate limit exceeded. Please wait a moment and try again.';
  }
  if (/model.*not.?found|invalid.*model|does not exist/i.test(raw)) {
    return 'Codex model not available. Check your model selection or Codex configuration.';
  }
  if (/ECONNREFUSED|ENOTFOUND|network|timeout|ETIMEDOUT/i.test(raw)) {
    return 'Codex could not connect to the API. Check your network connection.';
  }
  return `Codex error: ${raw}`;
}

function isUtilityOverload(error: unknown): boolean {
  if (error instanceof CodexAppServerRpcError && error.code === -32001) return true;
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  if (record.code === -32001) return true;
  return /overloaded/i.test(String((error as Error)?.message || error || ''));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}
