import {
  type AgentCatalog,
  type AgentId,
} from '../../common/agents.js';
import type { AgentSettingsEnvelope } from '../../common/agent-integration.js';
import type { ApiProtocol, ApiProviderCatalogEntry } from '../../common/api-providers.js';
import type {
  AgentInterruptAndSendCommandRequest,
  AgentInterruptAndSendResponse,
  AgentRunCommandRequest,
  AgentStopCommandRequest,
  AgentStopResponse,
  ActiveInputCommandRequest,
  ActiveInputCommandResponse,
  CommandAcceptedResponse,
  ForkChatResponse,
  ForkRunCommandRequest,
  ForkRunCommandResponse,
  QueueEntryCommandResponse,
  QueueEntryCreateCommandRequest,
  QueueEntryDeleteCommandRequest,
  QueueEntryDeleteResponse,
  QueueEntryReplaceCommandRequest,
  QueueMutationResponse,
  StartChatCommandRequest,
  StartChatCommandResponse,
} from '../../common/chat-command-contracts.js';
import type {
  ChatListResponse,
  MarkChatsReadEntry,
  MarkChatsReadRequest,
  MarkChatsReadResponse,
} from '../../common/chat-list.js';
import type { ChatSearchRequest, ChatSearchResponse } from '../../common/chat-search.js';
import {
  normalizeScheduledPromptsSnapshot,
  type CreateScheduledPromptRequest,
  type ScheduledPromptsMutationResponse,
  type ScheduledPromptsSnapshot,
} from '../../common/scheduled-prompts.js';
import {
  parseChatExecutionControlState,
	type ChatExecutionControlState,
} from '../../common/chat-execution-control.js';
import { parseChatViewMessages, type ChatViewMessage } from '../../common/chat-view.js';
import { normalizePendingUserInput, type PendingUserInput } from '../../common/pending-user-input.js';
import type {
  RemoteSettingsSnapshot,
  UpdateRemoteSettingsInput,
} from '../../common/settings.js';
import {
  parseServerWsMessage,
  type AgentRunFailedMessage,
  type AgentRunFinishedMessage,
  type ChatReloadedMessage,
  type ChatProcessingUpdatedMessage,
  type ChatSubscribedMessage,
  type ClientRequestErrorMessage,
  type ReconnectStateMessage,
  type ServerWsMessage,
  type WsPongMessage,
} from '../../common/ws-events.js';
import {
  ChatReloadRequest,
  ChatSubscribeRequest,
  ReconnectStateQueryRequest,
  WsPingRequest,
  type ClientWsMessage,
} from '../../common/ws-requests.js';
import { Deferred, withTimeout } from './deferred.js';
import { INTEGRATION_ANTHROPIC_API_KEY } from './anthropic-test-contract.js';
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
  protocol: ApiProtocol;
}

export interface ConfiguredDirectTestAgent {
  agentId: AgentId;
  agentSettings: AgentSettingsEnvelope;
  provider: ConfiguredTestProvider;
}

export interface DirectTestAgents {
  openAi: ConfiguredDirectTestAgent;
  anthropic: ConfiguredDirectTestAgent;
}

export interface DirectStartInput {
  chatId: string;
  content: string;
  projectPath: string;
  agent: ConfiguredDirectTestAgent;
  clientRequestId?: string;
  clientMessageId?: string;
}

export interface DirectRunInput {
  chatId: string;
  content: string;
  agent: ConfiguredDirectTestAgent;
  clientRequestId?: string;
  clientMessageId?: string;
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

export class GarconWsRequestError extends Error {
  constructor(readonly response: ClientRequestErrorMessage) {
    super(`${response.requestType} failed with ${response.code}: ${response.message}`);
    this.name = 'GarconWsRequestError';
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

  eventsSince(index: number): readonly ServerWsMessage[] {
    return this.#eventRecords.slice(index).map((record) => record.parsed);
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

  async createAnthropicProvider(providerBaseUrl: string): Promise<ConfiguredTestProvider> {
    const model = 'integration-anthropic-echo';
    const created = await this.post<ApiProviderCatalogEntry>('/api/v1/api-providers', {
      templateId: 'custom',
      label: 'Integration Fake Anthropic',
      endpoint: {
        protocol: 'anthropic-messages',
        baseUrl: `${providerBaseUrl.replace(/\/$/, '')}/v1`,
        apiKey: INTEGRATION_ANTHROPIC_API_KEY,
        defaultModel: model,
        models: [{ value: model, label: 'Integration Anthropic Echo' }],
        supportsImages: true,
        modelDiscovery: 'anthropic-models',
      },
    });
    const endpoint = created.endpoints[0];
    if (!endpoint) throw new Error('Created Anthropic provider did not contain an endpoint');
    return {
      providerId: created.id,
      endpointId: endpoint.id,
      model,
      protocol: 'anthropic-messages',
    };
  }

  listAgentCatalog(): Promise<AgentCatalog> {
    return this.get<AgentCatalog>('/api/v1/agents');
  }

  listChats(): Promise<ChatListResponse> {
    return this.get<ChatListResponse>('/api/v1/chats');
  }

  async getScheduledPrompts(): Promise<ScheduledPromptsSnapshot> {
    const response = await this.get<unknown>('/api/v1/scheduled-prompts');
    const snapshot = normalizeScheduledPromptsSnapshot(response);
    if (!snapshot) throw new Error(`Invalid scheduled prompts response: ${JSON.stringify(response)}`);
    return snapshot;
  }

  async createScheduledPrompt(
    request: CreateScheduledPromptRequest,
  ): Promise<ScheduledPromptsMutationResponse> {
    const response = await this.post<unknown>('/api/v1/scheduled-prompts', request);
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      throw new Error(`Invalid scheduled prompt mutation response: ${JSON.stringify(response)}`);
    }
    const raw = response as Record<string, unknown>;
    const snapshot = normalizeScheduledPromptsSnapshot(raw.snapshot);
    if (raw.success !== true || !snapshot) {
      throw new Error(`Invalid scheduled prompt mutation response: ${JSON.stringify(response)}`);
    }
    return { success: true, snapshot };
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

  startDirectChat(input: DirectStartInput): Promise<StartChatCommandResponse> {
    return this.startChat(this.directStartRequest(input));
  }

  directStartRequest(input: DirectStartInput): StartChatCommandRequest {
    return {
      clientRequestId: input.clientRequestId ?? crypto.randomUUID(),
      clientMessageId: input.clientMessageId ?? crypto.randomUUID(),
      chatId: input.chatId,
      agentId: input.agent.agentId,
      projectPath: input.projectPath,
      model: input.agent.provider.model,
      apiProviderId: input.agent.provider.providerId,
      modelEndpointId: input.agent.provider.endpointId,
      modelProtocol: input.agent.provider.protocol,
      permissionMode: 'default',
      thinkingMode: 'none',
      agentSettings: input.agent.agentSettings,
      command: input.content,
    };
  }

  runChat(request: AgentRunCommandRequest): Promise<CommandAcceptedResponse> {
    return this.post<CommandAcceptedResponse>('/api/v1/chats/run', request);
  }

  runDirectChat(input: DirectRunInput): Promise<CommandAcceptedResponse> {
    return this.runChat(this.directRunRequest(input));
  }

  directRunRequest(input: DirectRunInput): AgentRunCommandRequest {
    return {
      clientRequestId: input.clientRequestId ?? crypto.randomUUID(),
      clientMessageId: input.clientMessageId ?? crypto.randomUUID(),
      chatId: input.chatId,
      command: input.content,
      permissionMode: 'default',
      thinkingMode: 'none',
      agentSettings: input.agent.agentSettings,
      model: input.agent.provider.model,
      apiProviderId: input.agent.provider.providerId,
      modelEndpointId: input.agent.provider.endpointId,
      modelProtocol: input.agent.provider.protocol,
    };
  }

  forkChat(request: { sourceChatId: string; chatId: string; upToSeq?: number }): Promise<ForkChatResponse> {
    return this.post<ForkChatResponse>('/api/v1/chats/fork', request);
  }

  forkRunChat(request: ForkRunCommandRequest): Promise<ForkRunCommandResponse> {
    return this.post<ForkRunCommandResponse>('/api/v1/chats/fork-run', request);
  }

  deleteChat(chatId: string): Promise<{ success: boolean }> {
    return this.delete<{ success: boolean }>('/api/v1/chats', { chatId });
  }

  searchChats(request: ChatSearchRequest): Promise<ChatSearchResponse> {
    return this.post<ChatSearchResponse>('/api/v1/chats/search', request);
  }

  async waitForChatSearch(
    request: ChatSearchRequest,
    predicate: (response: ChatSearchResponse) => boolean,
    options: { timeoutMs?: number } = {},
  ): Promise<ChatSearchResponse> {
    const deadline = Date.now() + (options.timeoutMs ?? 10_000);
    let last: ChatSearchResponse | null = null;
    while (Date.now() < deadline) {
      last = await this.searchChats(request);
      if (predicate(last)) return last;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(
      `Timed out waiting for chat search ${JSON.stringify(request)}. Last response: ${JSON.stringify(last)}`,
    );
  }

  markChatsRead(entries: MarkChatsReadEntry[]): Promise<MarkChatsReadResponse> {
    const request: MarkChatsReadRequest = { entries };
    return this.post<MarkChatsReadResponse>('/api/v1/chats/read', request);
  }

  enqueue(request: QueueEntryCreateCommandRequest): Promise<QueueEntryCommandResponse> {
    return this.post<QueueEntryCommandResponse>('/api/v1/chats/queue/entries', request);
  }

  sendActiveInput(request: ActiveInputCommandRequest): Promise<ActiveInputCommandResponse> {
    return this.post<ActiveInputCommandResponse>('/api/v1/chats/active-input', request);
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

  async getExecutionControl(chatId: string): Promise<ChatExecutionControlState> {
    const response = await this.get<Record<string, unknown>>(
      `/api/v1/chats/queue?chatId=${encodeURIComponent(chatId)}`,
    );
    const control = parseChatExecutionControlState(response.control);
    if (!control) throw new Error(`Invalid execution control response: ${JSON.stringify(response)}`);
    return control;
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

  async reconnectState(controlChatIds: string[]): Promise<ReconnectStateMessage> {
    const clientRequestId = crypto.randomUUID();
    const afterIndex = this.markEvents();
    this.sendWs(new ReconnectStateQueryRequest(clientRequestId, controlChatIds));
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

  async reloadChat(chatId: string): Promise<ChatReloadedMessage> {
    const clientRequestId = crypto.randomUUID();
    const afterIndex = this.markEvents();
    this.sendWs(new ChatReloadRequest(clientRequestId, chatId));
    const outcome = await this.waitForEvent(
      (message): message is ChatReloadedMessage | ClientRequestErrorMessage =>
        (message.type === 'chat-reloaded' && message.clientRequestId === clientRequestId)
        || (
          message.type === 'client-request-error'
          && message.clientRequestId === clientRequestId
          && message.requestType === 'chat-reload'
        ),
      `chat-reload ${clientRequestId}`,
      { afterIndex },
    );
    if (outcome.type === 'client-request-error') throw new GarconWsRequestError(outcome);
    return outcome;
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

  async waitForEventCount<T extends ServerWsMessage>(
    predicate: (message: ServerWsMessage) => message is T,
    count: number,
    description: string,
    options: { afterIndex?: number; timeoutMs?: number } = {},
  ): Promise<T[]> {
    if (!Number.isSafeInteger(count) || count < 1) throw new Error('Event count must be positive.');
    const deadline = Date.now() + (options.timeoutMs ?? 10_000);
    const matches: T[] = [];
    let cursor = options.afterIndex ?? 0;

    while (matches.length < count) {
      const available = this.#eventRecords.length;
      for (; cursor < available; cursor += 1) {
        const message = this.#eventRecords[cursor].parsed;
        if (predicate(message)) matches.push(message);
      }
      if (matches.length >= count) return matches.slice(0, count);

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`Timed out waiting for ${description}.\n${this.describeEvents()}`);
      }
      await this.waitForEvent(predicate, description, { afterIndex: cursor, timeoutMs: remaining });
    }

    return matches;
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
