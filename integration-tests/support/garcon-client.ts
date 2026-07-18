import {
  DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
  type AgentCatalog,
} from '../../common/agents.js';
import type { ApiProviderCatalogEntry } from '../../common/api-providers.js';
import type {
  AgentInterruptAndSendCommandRequest,
  AgentInterruptAndSendResponse,
  AgentRunCommandRequest,
  AgentStopCommandRequest,
  AgentStopResponse,
  CommandAcceptedResponse,
  ForkChatResponse,
  QueueEntryCommandResponse,
  QueueEntryCreateCommandRequest,
  QueueEntryDeleteCommandRequest,
  QueueEntryDeleteResponse,
  QueueEntryReplaceCommandRequest,
  QueueMutationResponse,
  StartChatCommandRequest,
  StartChatCommandResponse,
} from '../../common/chat-command-contracts.js';
import type { ChatListResponse } from '../../common/chat-list.js';
import { parseChatViewMessages, type ChatViewMessage } from '../../common/chat-view.js';
import { normalizePendingUserInput, type PendingUserInput } from '../../common/pending-user-input.js';
import { parseQueueState, type QueueState } from '../../common/queue-state.js';
import type {
  RemoteSettingsSnapshot,
  UpdateRemoteSettingsInput,
} from '../../common/settings.js';
import {
  parseServerWsMessage,
  type AgentRunFailedMessage,
  type AgentRunFinishedMessage,
  type ChatProcessingUpdatedMessage,
  type ChatSubscribedMessage,
  type ReconnectStateMessage,
  type ServerWsMessage,
  type WsPongMessage,
} from '../../common/ws-events.js';
import {
  ChatSubscribeRequest,
  ReconnectStateQueryRequest,
  WsPingRequest,
  type ClientWsMessage,
} from '../../common/ws-requests.js';
import { Deferred, withTimeout } from './deferred.js';
import { INTEGRATION_OPENAI_API_KEY } from './openai-test-contract.js';

export interface HttpExchange {
  method: string;
  path: string;
  status: number;
  requestBody?: unknown;
  responseBody?: unknown;
}

export interface ConfiguredTestProvider {
  providerId: string;
  endpointId: string;
  model: string;
  protocol: 'openai-compatible';
}

export interface ChatMessagesPage {
  chatId: string;
  messages: ChatViewMessage[];
  generationId: string;
  lastSeq: number;
  pageOldestSeq: number;
  pendingUserInputs: PendingUserInput[];
  hasMore: boolean;
  limit: number;
}

interface EventRecord {
  raw: unknown;
  parsed: ServerWsMessage;
  receivedAt: number;
}

interface EventWaiter {
  afterIndex: number;
  predicate: (message: ServerWsMessage) => boolean;
  resolve(message: ServerWsMessage): void;
  reject(error: unknown): void;
}

interface GarconWebSocket {
  readonly readyState: number;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void;
  close(code?: number, reason?: string): void;
  send(data: string): void;
}

export interface GarconTestClientOptions {
  createWebSocket?: (url: string) => GarconWebSocket;
}

const WEB_SOCKET_OPEN = 1;
const WEB_SOCKET_CLOSED = 3;

export class GarconApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly method: string,
    readonly path: string,
  ) {
    super(`${method} ${path} returned ${status}: ${JSON.stringify(body)}`);
    this.name = 'GarconApiError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const normalized = key.toLowerCase();
    if (
      normalized === 'apikey'
      || normalized === 'api_key'
      || normalized === 'authorization'
      || normalized.endsWith('token')
    ) {
      return [key, '[REDACTED]'];
    }
    return [key, redact(item)];
  }));
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid response field: ${field}`);
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid response field: ${field}`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = nonNegativeInteger(value, field);
  if (parsed === 0) throw new Error(`Invalid response field: ${field}`);
  return parsed;
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${response.status} response was not JSON: ${text}`);
  }
}

export class GarconTestClient {
  readonly #baseUrl: string;
  readonly #createWebSocket: (url: string) => GarconWebSocket;
  readonly #exchanges: HttpExchange[] = [];
  readonly #eventRecords: EventRecord[] = [];
  readonly #waiters = new Set<EventWaiter>();
  readonly #receiveTasks = new Set<Promise<void>>();
  #socket: GarconWebSocket | null = null;
  #protocolError: Error | null = null;

  private constructor(baseUrl: string, options: GarconTestClientOptions) {
    this.#baseUrl = baseUrl.replace(/\/$/, '');
    this.#createWebSocket = options.createWebSocket ?? ((url) => new WebSocket(url));
  }

  static async connect(baseUrl: string, options: GarconTestClientOptions = {}): Promise<GarconTestClient> {
    const client = new GarconTestClient(baseUrl, options);
    await client.reconnect();
    return client;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  markEvents(): number {
    return this.#eventRecords.length;
  }

  events(): readonly ServerWsMessage[] {
    return this.#eventRecords.map((record) => record.parsed);
  }

  rawEvents(): readonly unknown[] {
    return this.#eventRecords.map((record) => record.raw);
  }

  eventRecords(): readonly EventRecord[] {
    return this.#eventRecords.slice();
  }

  exchanges(): readonly HttpExchange[] {
    return this.#exchanges.slice();
  }

  async reconnect(): Promise<void> {
    await this.#waitForReceives();
    this.assertProtocolHealthy();
    if (this.#socket && this.#socket.readyState === WEB_SOCKET_OPEN) return;
    const wsUrl = this.#baseUrl.replace(/^http/, 'ws') + '/ws';
    const socket = this.#createWebSocket(wsUrl);
    this.#socket = socket;
    const opened = new Deferred<void>();
    socket.addEventListener('open', () => opened.resolve());
    socket.addEventListener('error', () => opened.reject(new Error(`WebSocket failed to connect: ${wsUrl}`)));
    socket.addEventListener('message', (event) => {
      if (this.#socket !== socket) return;
      this.#scheduleReceive((event as MessageEvent).data);
    });
    await withTimeout(opened.promise, 10_000, () => `Timed out connecting WebSocket: ${wsUrl}`);
  }

  async disconnect(): Promise<void> {
    const socket = this.#socket;
    if (!socket) return;
    if (socket.readyState === WEB_SOCKET_CLOSED) {
      if (this.#socket === socket) this.#socket = null;
      return;
    }
    const closed = new Deferred<void>();
    socket.addEventListener('close', () => closed.resolve(), { once: true });
    socket.close(1000, 'integration reconnect');
    await withTimeout(closed.promise, 5_000, () => 'Timed out closing integration WebSocket');
    if (this.#socket === socket) this.#socket = null;
  }

  async close(): Promise<void> {
    await this.disconnect();
    await this.#waitForReceives();
    const error = new Error('Garcon test client closed');
    for (const waiter of this.#waiters) waiter.reject(error);
    this.#waiters.clear();
    this.assertProtocolHealthy();
  }

  assertProtocolHealthy(): void {
    if (this.#protocolError) throw this.#protocolError;
  }

  async createOpenAiProvider(providerBaseUrl: string): Promise<ConfiguredTestProvider> {
    const created = await this.post<ApiProviderCatalogEntry>('/api/v1/api-providers', {
      templateId: 'custom',
      label: 'Integration Fake OpenAI',
      endpoint: {
        protocol: 'openai-compatible',
        baseUrl: `${providerBaseUrl.replace(/\/$/, '')}/v1`,
        apiKey: INTEGRATION_OPENAI_API_KEY,
        capabilities: { chatCompletions: true, responses: false },
        defaultModel: 'integration-echo',
        models: [{ value: 'integration-echo', label: 'Integration Echo' }],
        supportsImages: false,
        modelDiscovery: 'openai-models',
      },
    });
    const endpoint = created.endpoints[0];
    if (!endpoint) throw new Error('Created provider did not contain an endpoint');
    return {
      providerId: created.id,
      endpointId: endpoint.id,
      model: 'integration-echo',
      protocol: 'openai-compatible',
    };
  }

  listAgentCatalog(): Promise<AgentCatalog> {
    return this.get<AgentCatalog>('/api/v1/agents');
  }

  listChats(): Promise<ChatListResponse> {
    return this.get<ChatListResponse>('/api/v1/chats');
  }

  updateSettings(patch: UpdateRemoteSettingsInput): Promise<{
    success: boolean;
    settings: RemoteSettingsSnapshot;
  }> {
    return this.put('/api/v1/app/settings', patch);
  }

  startChat(request: StartChatCommandRequest): Promise<StartChatCommandResponse> {
    return this.post<StartChatCommandResponse>('/api/v1/chats/start', request);
  }

  startDirectChat(input: {
    chatId: string;
    content: string;
    projectPath: string;
    provider: ConfiguredTestProvider;
    clientRequestId?: string;
    clientMessageId?: string;
  }): Promise<StartChatCommandResponse> {
    return this.startChat(this.directStartRequest(input));
  }

  directStartRequest(input: {
    chatId: string;
    content: string;
    projectPath: string;
    provider: ConfiguredTestProvider;
    clientRequestId?: string;
    clientMessageId?: string;
  }): StartChatCommandRequest {
    return {
      clientRequestId: input.clientRequestId ?? crypto.randomUUID(),
      clientMessageId: input.clientMessageId ?? crypto.randomUUID(),
      chatId: input.chatId,
      agentId: DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
      projectPath: input.projectPath,
      model: input.provider.model,
      apiProviderId: input.provider.providerId,
      modelEndpointId: input.provider.endpointId,
      modelProtocol: input.provider.protocol,
      permissionMode: 'default',
      thinkingMode: 'none',
      claudeThinkingMode: 'auto',
      ampAgentMode: 'smart',
      command: input.content,
    };
  }

  runChat(request: AgentRunCommandRequest): Promise<CommandAcceptedResponse> {
    return this.post<CommandAcceptedResponse>('/api/v1/chats/run', request);
  }

  runDirectChat(input: {
    chatId: string;
    content: string;
    provider: ConfiguredTestProvider;
    clientRequestId?: string;
    clientMessageId?: string;
  }): Promise<CommandAcceptedResponse> {
    return this.runChat(this.directRunRequest(input));
  }

  directRunRequest(input: {
    chatId: string;
    content: string;
    provider: ConfiguredTestProvider;
    clientRequestId?: string;
    clientMessageId?: string;
  }): AgentRunCommandRequest {
    return {
      clientRequestId: input.clientRequestId ?? crypto.randomUUID(),
      clientMessageId: input.clientMessageId ?? crypto.randomUUID(),
      chatId: input.chatId,
      command: input.content,
      permissionMode: 'default',
      thinkingMode: 'none',
      claudeThinkingMode: 'auto',
      ampAgentMode: 'smart',
      model: input.provider.model,
      apiProviderId: input.provider.providerId,
      modelEndpointId: input.provider.endpointId,
      modelProtocol: input.provider.protocol,
    };
  }

  forkChat(request: { sourceChatId: string; chatId: string; upToSeq?: number }): Promise<ForkChatResponse> {
    return this.post<ForkChatResponse>('/api/v1/chats/fork', request);
  }

  deleteChat(chatId: string): Promise<{ success: boolean }> {
    return this.delete<{ success: boolean }>('/api/v1/chats', { chatId });
  }

  enqueue(request: QueueEntryCreateCommandRequest): Promise<QueueEntryCommandResponse> {
    return this.post<QueueEntryCommandResponse>('/api/v1/chats/queue/entries', request);
  }

  enqueueNew(chatId: string, content: string): Promise<QueueEntryCommandResponse> {
    return this.enqueue({ chatId, content, clientRequestId: crypto.randomUUID() });
  }

  replaceQueued(request: QueueEntryReplaceCommandRequest): Promise<QueueEntryCommandResponse> {
    return this.put<QueueEntryCommandResponse>('/api/v1/chats/queue/entries', request);
  }

  deleteQueued(request: QueueEntryDeleteCommandRequest): Promise<QueueEntryDeleteResponse> {
    return this.delete<QueueEntryDeleteResponse>('/api/v1/chats/queue/entries', request);
  }

  pauseQueue(chatId: string): Promise<QueueMutationResponse> {
    return this.post<QueueMutationResponse>('/api/v1/chats/queue/pause', { chatId });
  }

  resumeQueue(chatId: string, pauseId: string): Promise<QueueMutationResponse> {
    return this.post<QueueMutationResponse>('/api/v1/chats/queue/resume', { chatId, pauseId });
  }

  clearQueue(chatId: string): Promise<QueueMutationResponse> {
    return this.post<QueueMutationResponse>('/api/v1/chats/queue/clear', { chatId });
  }

  stopChat(request: AgentStopCommandRequest): Promise<AgentStopResponse> {
    return this.post<AgentStopResponse>('/api/v1/chats/stop', request);
  }

  interruptAndSend(request: AgentInterruptAndSendCommandRequest): Promise<AgentInterruptAndSendResponse> {
    return this.post<AgentInterruptAndSendResponse>('/api/v1/chats/interrupt-and-send', request);
  }

  async getQueue(chatId: string): Promise<QueueState> {
    const response = await this.get<Record<string, unknown>>(
      `/api/v1/chats/queue?chatId=${encodeURIComponent(chatId)}`,
    );
    const queue = parseQueueState(response.queue);
    if (!queue) throw new Error(`Invalid queue response: ${JSON.stringify(response)}`);
    return queue;
  }

  async getMessages(chatId: string, options: { limit?: number; beforeSeq?: number } = {}): Promise<ChatMessagesPage> {
    const query = new URLSearchParams({
      chatId,
      limit: String(options.limit ?? 100),
    });
    if (options.beforeSeq !== undefined) query.set('beforeSeq', String(options.beforeSeq));
    const response = await this.get<Record<string, unknown>>(`/api/v1/chats/messages?${query}`);
    const messages = parseChatViewMessages(response.messages);
    if (!messages) throw new Error(`Invalid messages response: ${JSON.stringify(response)}`);
    if (!Array.isArray(response.pendingUserInputs)) {
      throw new Error(`Invalid pendingUserInputs response: ${JSON.stringify(response)}`);
    }
    const pendingUserInputs = response.pendingUserInputs.map(normalizePendingUserInput);
    if (pendingUserInputs.some((input) => input === null)) {
      throw new Error(`Invalid pending user input: ${JSON.stringify(response.pendingUserInputs)}`);
    }
    if (typeof response.hasMore !== 'boolean') throw new Error('Invalid messages response: hasMore');
    return {
      chatId: requiredString(response.chatId, 'chatId'),
      messages,
      generationId: requiredString(response.generationId, 'generationId'),
      lastSeq: nonNegativeInteger(response.lastSeq, 'lastSeq'),
      pageOldestSeq: nonNegativeInteger(response.pageOldestSeq, 'pageOldestSeq'),
      pendingUserInputs: pendingUserInputs as PendingUserInput[],
      hasMore: response.hasMore,
      limit: positiveInteger(response.limit, 'limit'),
    };
  }

  async ping(): Promise<WsPongMessage> {
    const clientRequestId = crypto.randomUUID();
    const sentAt = Date.now();
    const afterIndex = this.markEvents();
    this.sendWs(new WsPingRequest(clientRequestId, sentAt));
    return await this.waitForEvent(
      (message): message is WsPongMessage =>
        message.type === 'ws-pong' && message.clientRequestId === clientRequestId,
      `ws-pong ${clientRequestId}`,
      { afterIndex },
    );
  }

  async reconnectState(queueChatIds: string[]): Promise<ReconnectStateMessage> {
    const clientRequestId = crypto.randomUUID();
    const afterIndex = this.markEvents();
    this.sendWs(new ReconnectStateQueryRequest(clientRequestId, queueChatIds));
    return await this.waitForEvent(
      (message): message is ReconnectStateMessage =>
        message.type === 'reconnect-state' && message.clientRequestId === clientRequestId,
      `reconnect-state ${clientRequestId}`,
      { afterIndex },
    );
  }

  async subscribe(
    chatId: string,
    generationId: string,
    afterSeq: number,
  ): Promise<ChatSubscribedMessage> {
    const clientRequestId = crypto.randomUUID();
    const afterIndex = this.markEvents();
    this.sendWs(new ChatSubscribeRequest(clientRequestId, chatId, generationId, afterSeq));
    return await this.waitForEvent(
      (message): message is ChatSubscribedMessage =>
        message.type === 'chat-subscribed' && message.clientRequestId === clientRequestId,
      `chat-subscribed ${clientRequestId}`,
      { afterIndex },
    );
  }

  async waitForProcessing(
    chatId: string,
    isProcessing: boolean,
    options: { afterIndex?: number; timeoutMs?: number } = {},
  ): Promise<ChatProcessingUpdatedMessage> {
    return await this.waitForEvent(
      (message): message is ChatProcessingUpdatedMessage =>
        message.type === 'chat-processing-updated'
        && message.chatId === chatId
        && message.isProcessing === isProcessing,
      `${chatId} processing=${isProcessing}`,
      options,
    );
  }

  async waitForTurnTerminal(
    chatId: string,
    turnId?: string,
    options: { afterIndex?: number; timeoutMs?: number } = {},
  ): Promise<AgentRunFinishedMessage | AgentRunFailedMessage> {
    return await this.waitForEvent(
      (message): message is AgentRunFinishedMessage | AgentRunFailedMessage =>
        (message.type === 'agent-run-finished' || message.type === 'agent-run-failed')
        && message.chatId === chatId
        && (turnId === undefined || message.turnId === turnId),
      `${chatId} terminal turn ${turnId ?? '(any)'}`,
      options,
    );
  }

  async waitForEvent<T extends ServerWsMessage>(
    predicate: (message: ServerWsMessage) => message is T,
    description: string,
    options: { afterIndex?: number; timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.#protocolError) throw this.#protocolError;
    const afterIndex = options.afterIndex ?? 0;
    for (let index = afterIndex; index < this.#eventRecords.length; index += 1) {
      const event = this.#eventRecords[index].parsed;
      if (predicate(event)) return event;
    }

    const deferred = new Deferred<T>();
    const waiter: EventWaiter = {
      afterIndex,
      predicate,
      resolve(message) {
        if (predicate(message)) deferred.resolve(message);
      },
      reject(error) {
        deferred.reject(error);
      },
    };
    this.#waiters.add(waiter);
    try {
      return await withTimeout(
        deferred.promise,
        options.timeoutMs ?? 10_000,
        () => `Timed out waiting for ${description}.\n${this.describeEvents()}`,
      );
    } finally {
      this.#waiters.delete(waiter);
    }
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }

  delete<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('DELETE', path, body);
  }

  describeEvents(): string {
    return JSON.stringify(this.#eventRecords.map((record, index) => ({
      index,
      receivedAt: record.receivedAt,
      event: record.parsed,
    })), null, 2);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.#baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const parsed = await responseBody(response);
    this.#exchanges.push({
      method,
      path,
      status: response.status,
      ...(body === undefined ? {} : { requestBody: redact(body) }),
      responseBody: redact(parsed),
    });
    if (!response.ok) throw new GarconApiError(response.status, parsed, method, path);
    return parsed as T;
  }

  private sendWs(message: ClientWsMessage): void {
    if (!this.#socket || this.#socket.readyState !== WEB_SOCKET_OPEN) {
      throw new Error('Garcon WebSocket is not connected');
    }
    this.#socket.send(JSON.stringify(message));
  }

  #scheduleReceive(data: string | ArrayBuffer | Blob): void {
    const task = this.#receiveMessage(data).finally(() => this.#receiveTasks.delete(task));
    this.#receiveTasks.add(task);
  }

  async #waitForReceives(): Promise<void> {
    while (this.#receiveTasks.size > 0) {
      await Promise.all([...this.#receiveTasks]);
    }
  }

  async #receiveMessage(data: string | ArrayBuffer | Blob): Promise<void> {
    try {
      const text = typeof data === 'string'
        ? data
        : data instanceof ArrayBuffer
          ? new TextDecoder().decode(data)
          : await data.text();
      const raw = JSON.parse(text) as unknown;
      if (!isRecord(raw)) throw new Error(`WebSocket payload is not an object: ${text}`);
      const parsed = parseServerWsMessage(raw);
      if (!parsed) throw new Error(`Unknown or malformed WebSocket payload: ${text}`);
      const index = this.#eventRecords.length;
      this.#eventRecords.push({ raw, parsed, receivedAt: Date.now() });
      for (const waiter of this.#waiters) {
        if (index >= waiter.afterIndex && waiter.predicate(parsed)) waiter.resolve(parsed);
      }
    } catch (error) {
      this.#protocolError ??= error instanceof Error ? error : new Error(String(error));
      for (const waiter of this.#waiters) waiter.reject(this.#protocolError);
    }
  }
}
