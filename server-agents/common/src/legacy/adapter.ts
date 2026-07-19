import type {
  AgentCatalog,
  AgentChatReference,
  AgentExecution,
  AgentExecutionContext,
  AgentExecutionEvent,
  AgentHost,
  AgentIntegration,
  AgentLifecycle,
  AgentMigration,
  AgentNativeSessionRef,
  AgentSettings,
  AgentTranscript,
  AgentTranscriptPreview,
  AgentTranscriptSearch,
  AgentSearchChat,
} from '@garcon/server-agent-interface';
import {
  AgentIntegrationError,
  computeAgentTranscriptRevision,
} from '@garcon/server-agent-interface';
import type { AgentSettingsEnvelope } from '@garcon/common/agent-integration';
import type { AgentDescriptor } from '@garcon/common/agent-integration';
import type { AgentEndpointSelection } from '@garcon/common/agent-execution';
import type { AgentModelOption } from '@garcon/common/agents';
import type { JsonObject, JsonValue } from '@garcon/common/json';
import type {
  Agent,
  AgentEndpointSelection as LegacyEndpointSelection,
  StoredApiProvider,
  StoredApiProviderEndpoint,
} from './types.js';
import type {
  AgentChatEntry,
  AgentEventMetadata,
  AgentSessionSettingsPatch,
  ResumeTurnRequest,
  StartSessionRequest,
} from './session-types.js';
import { createTranscriptSearch } from '../search/transcript-search.js';

export interface LegacyIntegrationOptions {
  readonly host: AgentHost;
  readonly descriptor: AgentDescriptor;
  readonly agent: Agent;
  readonly transcriptSearch: AgentTranscriptSearch;
  readonly defaultModel: string;
  readonly models?: readonly AgentModelOption[];
  readonly defaultSettings?: JsonObject;
  readonly onEndpointSelection?: (
    selection: AgentEndpointSelection,
    credential: string,
  ) => void;
}

export class LegacyAgentIntegrationBase implements AgentIntegration {
  readonly descriptor: AgentIntegration['descriptor'];
  readonly execution: AgentIntegration['execution'];
  readonly transcript: AgentIntegration['transcript'];
  readonly transcriptSearch: AgentIntegration['transcriptSearch'];
  readonly catalog: AgentIntegration['catalog'];
  readonly settings: AgentIntegration['settings'];
  readonly lifecycle: AgentIntegration['lifecycle'];
  readonly migration: AgentIntegration['migration'];
  readonly auth: AgentIntegration['auth'];
  readonly commands: AgentIntegration['commands'];
  readonly forking: AgentIntegration['forking'];
  readonly endpoints: AgentIntegration['endpoints'];
  readonly singleQuery: AgentIntegration['singleQuery'];

  constructor(options: Omit<LegacyIntegrationOptions, 'transcriptSearch'>) {
    const transcriptSearch = createLegacyTranscriptSearch(
      options.host,
      options.descriptor.id,
      options.agent,
    );
    const integration = createLegacyAgentIntegration({ ...options, transcriptSearch });
    this.descriptor = integration.descriptor;
    this.execution = integration.execution;
    this.transcript = integration.transcript;
    this.transcriptSearch = integration.transcriptSearch;
    this.catalog = integration.catalog;
    this.settings = integration.settings;
    this.lifecycle = integration.lifecycle;
    this.migration = integration.migration;
    this.auth = integration.auth;
    this.commands = integration.commands;
    this.forking = integration.forking;
    this.endpoints = integration.endpoints;
    this.singleQuery = integration.singleQuery;
  }
}

export function createLegacyTranscriptSearch(
  host: AgentHost,
  agentId: string,
  agent: Agent,
): AgentTranscriptSearch {
  return createTranscriptSearch({
    host,
    agentId,
    loadTranscript: ({ chat, signal }) => {
      signal.throwIfAborted();
      return agent.transcript.loadMessages(searchChatEntry(agentId, chat), { chatId: chat.chatId });
    },
  });
}

export function createLegacyAgentIntegration(
  options: LegacyIntegrationOptions,
): AgentIntegration {
  const settings = createSettings(options.descriptor.id, options.defaultSettings ?? {});
  const execution = new LegacyExecution(
    options.host,
    options.agent,
    options.descriptor.id,
    options.onEndpointSelection,
  );
  const transcript = createTranscript(options.agent, options.descriptor.id);
  const catalog = createCatalog(options.agent, options.defaultModel, options.models ?? []);
  const lifecycle = createLifecycle(options.agent, options.transcriptSearch);
  const migration = createMigration(options.descriptor.id);

  return {
    descriptor: options.descriptor,
    execution,
    transcript,
    transcriptSearch: options.transcriptSearch,
    catalog,
    settings,
    lifecycle,
    migration,
    auth: {
      async status() {
        const raw = await options.agent.auth.getAuthStatus();
        const value = isRecord(raw) ? raw : {};
        return {
          authenticated: value.authenticated === true,
          canReauth: options.agent.capabilities.authLoginSupported,
          label: typeof value.label === 'string' ? value.label : options.descriptor.label,
          source: value.authenticated === true ? 'cli' : 'none',
          ...(typeof value.detail === 'string' ? { detail: value.detail } : {}),
        };
      },
      ...(options.agent.auth.launchLogin ? { launchLogin: () => options.agent.auth.launchLogin!() } : {}),
      ...(options.agent.auth.completeLogin ? {
        completeLogin: (sessionId: string, code: string) => options.agent.auth.completeLogin!(sessionId, code),
      } : {}),
      ...(options.agent.auth.loginStatus ? {
        loginStatus: (expectedSessionId?: string) => options.agent.auth.loginStatus!(expectedSessionId),
      } : {}),
    },
    commands: options.agent.discoverSlashCommands ? {
      discover: (projectPath, signal) => {
        signal.throwIfAborted();
        return options.agent.discoverSlashCommands!(projectPath);
      },
    } : null,
    forking: options.agent.forkSession ? {
      supportsAtMessage: options.agent.capabilities.supportsForkAtMessage,
      supportsWhileRunning: options.agent.capabilities.supportsForkWhileRunning,
      async fork(request) {
        request.admission.signal.throwIfAborted();
        const source = toLegacyChat(request.source);
        const result = await options.agent.forkSession!({
          sourceSession: source,
          sourceChatId: request.source.chatId,
          targetChatId: request.chatId,
        });
        if (!result) {
          throw new AgentIntegrationError('OPERATION_UNSUPPORTED', 'Agent fork did not create a session', false);
        }
        return {
          agentSessionId: result.agentSessionId,
          nativeSession: nativeSession(options.descriptor.id, result.nativePath, result.agentSessionId),
        };
      },
    } : null,
    endpoints: options.agent.capabilities.acceptsApiProviderEndpoints ? {
      async validate(selection) {
        if (!options.agent.capabilities.supportedProtocols.includes(selection.protocol)) {
          throw new AgentIntegrationError('INVALID_ENDPOINT', 'Endpoint protocol is not supported', false);
        }
      },
      modelSupportsImages(selection) {
        return options.agent.capabilities.supportsImages || selection.protocol === 'openai-compatible';
      },
    } : null,
    singleQuery: options.agent.runSingleQuery ? {
      run: ({ prompt, projectPath, model, settings: envelope, signal }) => {
        signal.throwIfAborted();
        return options.agent.runSingleQuery!(prompt, {
          projectPath,
          model,
          ...envelope.values,
        });
      },
    } : null,
  };
}

class LegacyExecution implements AgentExecution {
  readonly #host: AgentHost;
  readonly #agent: Agent;
  readonly #agentId: string;
  readonly #onEndpointSelection: LegacyIntegrationOptions['onEndpointSelection'];
  readonly #listeners = new Set<(event: AgentExecutionEvent) => void>();
  readonly #operations = new Map<string, AgentExecutionContext['operation']>();

  constructor(
    host: AgentHost,
    agent: Agent,
    agentId: string,
    onEndpointSelection: LegacyIntegrationOptions['onEndpointSelection'],
  ) {
    this.#host = host;
    this.#agent = agent;
    this.#agentId = agentId;
    this.#onEndpointSelection = onEndpointSelection;
    agent.runtime.onMessages((chatId, messages, metadata) => {
      const operation = this.#operation(chatId, metadata);
      if (operation) this.#emit({ type: 'messages', chatId, messages, operation });
    });
    agent.runtime.onProcessing((chatId, processing) => {
      const operation = this.#operations.get(chatId);
      if (operation) this.#emit({ type: 'processing', chatId, processing, operation });
    });
    agent.runtime.onSessionCreated(() => {});
    agent.runtime.onFinished((chatId, exitCode, metadata) => {
      const operation = this.#operation(chatId, metadata);
      if (!operation) return;
      this.#emit({ type: 'finished', chatId, exitCode, operation });
      this.#operations.delete(chatId);
    });
    agent.runtime.onFailed((chatId, message, metadata) => {
      const operation = this.#operation(chatId, metadata);
      if (!operation) return;
      this.#emit({
        type: 'failed',
        chatId,
        error: new AgentIntegrationError('PROVIDER_FAILURE', message, false),
        operation,
      });
      this.#operations.delete(chatId);
    });
  }

  async start(request: Parameters<AgentExecution['start']>[0]) {
    this.#operations.set(request.chatId, request.operation);
    request.admission.signal.throwIfAborted();
    const endpoint = await this.#endpointRuntime(request.endpoint, request.admission.signal);
    const result = await this.#agent.runtime.startSession({
      ...legacyExecutionConfig(request),
      command: request.prompt,
      images: request.attachments.map((attachment) => ({
        data: attachment.data,
        ...(attachment.name ? { name: attachment.name } : {}),
        mimeType: attachment.mimeType,
      })),
      ...endpoint,
      onAbortable: () => request.admission.markAbortable(),
    });
    const session = {
      agentSessionId: result.agentSessionId,
      nativeSession: nativeSession(this.#agentId, result.nativePath, result.agentSessionId),
    };
    this.#emit({ type: 'session-created', chatId: request.chatId, session, operation: request.operation });
    return session;
  }

  async resume(request: Parameters<AgentExecution['resume']>[0]): Promise<void> {
    this.#operations.set(request.chatId, request.operation);
    request.admission.signal.throwIfAborted();
    const endpoint = await this.#endpointRuntime(request.endpoint, request.admission.signal);
    await this.#agent.runtime.runTurn({
      ...legacyExecutionConfig(request),
      agentSessionId: request.agentSessionId,
      command: request.prompt,
      images: request.attachments.map((attachment) => ({
        data: attachment.data,
        ...(attachment.name ? { name: attachment.name } : {}),
        mimeType: attachment.mimeType,
      })),
      nativePath: nativePath(request.nativeSession),
      ...endpoint,
      onAbortable: () => request.admission.markAbortable(),
    });
  }

  async abort(agentSessionId: string): Promise<boolean> {
    return this.#agent.runtime.abort(agentSessionId);
  }

  isRunning(agentSessionId: string): boolean {
    return this.#agent.runtime.isRunning(agentSessionId);
  }

  runningSessions() {
    return this.#agent.runtime.getRunningSessions().map((session) => ({
      agentSessionId: session.id,
      status: session.status ?? null,
      startedAt: session.startedAt ?? null,
    }));
  }

  async submitActiveInput(request: Parameters<NonNullable<AgentExecution['submitActiveInput']>>[0]) {
    if (!this.#agent.runtime.submitActiveInput) return false;
    this.#operations.set(request.chatId, request.operation);
    const endpoint = await this.#endpointRuntime(request.endpoint, request.admission.signal);
    return this.#agent.runtime.submitActiveInput({
      ...legacyExecutionConfig(request),
      agentSessionId: request.agentSessionId,
      command: request.prompt,
      nativePath: nativePath(request.nativeSession),
      ...endpoint,
      onAbortable: () => request.admission.markAbortable(),
    }, request.beforeDelivery);
  }

  async compact(request: Parameters<NonNullable<AgentExecution['compact']>>[0]): Promise<void> {
    this.#operations.set(request.chatId, request.operation);
    const endpoint = await this.#endpointRuntime(request.endpoint, request.admission.signal);
    const legacy = {
      ...legacyExecutionConfig(request),
      agentSessionId: request.agentSessionId,
      command: request.prompt,
      nativePath: nativePath(request.nativeSession),
      ...endpoint,
      onAbortable: () => request.admission.markAbortable(),
    } satisfies ResumeTurnRequest;
    if (this.#agent.runtime.compact) await this.#agent.runtime.compact(legacy);
    else await this.#agent.runtime.runTurn(legacy);
  }

  async applySessionConfiguration(agentSessionId: string, configuration: Parameters<NonNullable<AgentExecution['applySessionConfiguration']>>[1]): Promise<void> {
    if (!this.#agent.runtime.updateSessionSettings) return;
    await this.#agent.runtime.updateSessionSettings(agentSessionId, {
      model: configuration.model,
      permissionMode: configuration.permissionMode,
      thinkingMode: configuration.thinkingMode,
      ...settingsPatch(configuration.settings),
    });
  }

  async respondToPermission(permissionRequestId: string, decision: Parameters<NonNullable<AgentExecution['respondToPermission']>>[1]): Promise<void> {
    if (!this.#agent.runtime.resolvePermission) {
      throw new AgentIntegrationError('OPERATION_UNSUPPORTED', 'Permission responses are unsupported', false);
    }
    await this.#agent.runtime.resolvePermission(permissionRequestId, decision);
  }

  async prepareProjectPathUpdate(request: Parameters<NonNullable<AgentExecution['prepareProjectPathUpdate']>>[0]): Promise<void> {
    if (!this.#agent.runtime.prepareProjectPathUpdate) return;
    await this.#agent.runtime.prepareProjectPathUpdate({
      chatId: request.chat.chatId,
      agentSessionId: request.chat.agentSessionId,
      previousProjectPath: request.chat.projectPath,
      nextProjectPath: request.nextProjectPath,
      nativePath: nativePath(request.chat.nativeSession),
    });
  }

  subscribe(listener: (event: AgentExecutionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event: AgentExecutionEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  #operation(chatId: string, metadata?: AgentEventMetadata) {
    const active = this.#operations.get(chatId);
    if (!active) return null;
    if (metadata?.turnId && metadata.turnId !== active.turnId) return null;
    if (metadata?.clientRequestId && metadata.clientRequestId !== active.clientRequestId) return null;
    return active;
  }

  async #endpointRuntime(endpoint: AgentEndpointSelection | null, signal: AbortSignal) {
    if (!endpoint || !this.#agent.prepareEndpointRuntime) return {};
    const resolved = endpoint.credential
      ? await this.#host.apiProviders.resolveCredential({ reference: endpoint.credential, signal })
      : null;
    const storedEndpoint: StoredApiProviderEndpoint = {
      id: endpoint.endpointId,
      protocol: endpoint.protocol,
      baseUrl: endpoint.baseUrl,
      apiKey: resolved?.value ?? '',
      defaultModel: endpoint.model,
      models: [{ value: endpoint.model, label: endpoint.model }],
      supportsImages: false,
      modelDiscovery: 'none',
    };
    const apiProvider: StoredApiProvider = {
      id: endpoint.apiProviderId,
      label: endpoint.apiProviderId,
      endpoints: [storedEndpoint],
      createdAt: '',
      updatedAt: '',
    };
    this.#onEndpointSelection?.(endpoint, resolved?.value ?? '');
    const legacySelection: LegacyEndpointSelection = {
      model: endpoint.model,
      apiProviderId: endpoint.apiProviderId,
      modelEndpointId: endpoint.endpointId,
      modelProtocol: endpoint.protocol,
      isLocal: endpoint.isLocal,
      apiProvider,
      endpoint: storedEndpoint,
    };
    return this.#agent.prepareEndpointRuntime(legacySelection) ?? {};
  }
}

function createTranscript(agent: Agent, agentId: string): AgentTranscript {
  const load = async (chat: AgentChatReference) => {
    const messages = await agent.transcript.loadMessages(toLegacyChat(chat), { chatId: chat.chatId });
    return { messages, revision: computeAgentTranscriptRevision(messages) };
  };
  return {
    async resolveNativeSession({ chat, signal }) {
      signal.throwIfAborted();
      if (!agent.transcript.resolveNativePath) return chat.nativeSession;
      const resolved = await agent.transcript.resolveNativePath(toLegacyChat(chat));
      return nativeSession(agentId, resolved);
    },
    async load({ chat, signal }) {
      signal.throwIfAborted();
      return load(chat);
    },
    ...(agent.transcript.loadMessagePage ? {
      async loadPage({ chat, page, signal }) {
        signal.throwIfAborted();
        const result = await agent.transcript.loadMessagePage!(
          toLegacyChat(chat),
          page,
          { chatId: chat.chatId },
        );
        if (!result) return null;
        return {
          ...result,
          revision: result.revision ?? computeAgentTranscriptRevision(result.messages),
        };
      },
    } : {}),
    async preview({ chat, signal }) {
      signal.throwIfAborted();
      if (!agent.transcript.getPreview) return null;
      return normalizePreview(await agent.transcript.getPreview(toLegacyChat(chat)));
    },
    async revision({ chat, signal }) {
      signal.throwIfAborted();
      return (await load(chat)).revision;
    },
    async release() {},
  };
}

function createCatalog(
  agent: Agent,
  defaultModel: string,
  fallbackModels: readonly AgentModelOption[],
): AgentCatalog {
  return {
    async snapshot({ strict, signal }) {
      signal.throwIfAborted();
      const discovered = await agent.capabilities.getModels?.({ strict }) ?? [];
      const models = [...discovered, ...fallbackModels].filter((model, index, all) => (
        all.findIndex((candidate) => candidate.value === model.value) === index
      ));
      return {
        models,
        defaultModel,
        requiresStrictModelDiscovery: agent.capabilities.requiresStrictModelDiscovery,
        generation: agent.runSingleQuery ? { priority: 0, model: defaultModel } : null,
        availability: { state: 'ready', reason: 'Integration is registered.' },
      };
    },
  };
}

function createSettings(agentId: string, defaults: JsonObject): AgentSettings {
  const envelope = (values: JsonObject): AgentSettingsEnvelope => ({
    ownerId: agentId,
    schemaVersion: 1,
    values,
  });
  const parse = (input: AgentSettingsEnvelope): AgentSettingsEnvelope => {
    if (input.ownerId !== agentId || input.schemaVersion !== 1 || !isRecord(input.values)) {
      throw new AgentIntegrationError('INVALID_SETTINGS', `Invalid settings for ${agentId}`, false);
    }
    return envelope(input.values);
  };
  return {
    describe: () => [],
    defaults: () => envelope(defaults),
    parse,
    migrate: async (input) => parse(input),
    applyPatch(current, patch) {
      const parsed = parse(current);
      return envelope({ ...parsed.values, ...patch });
    },
  };
}

function createLifecycle(agent: Agent, transcriptSearch: AgentTranscriptSearch): AgentLifecycle {
  let started = false;
  return {
    async start() {
      if (started) return;
      started = true;
      agent.runtime.startPurgeTimer?.();
    },
    async stop() {
      if (!started) return;
      started = false;
      agent.runtime.shutdown?.();
      if ('close' in transcriptSearch && typeof transcriptSearch.close === 'function') {
        await transcriptSearch.close();
      }
    },
    async migrateOwnedStorage() {},
  };
}

function createMigration(agentId: string): AgentMigration {
  return {
    async translateLegacyNativeSession(request) {
      return nativeSession(agentId, request.legacyNativePath);
    },
    async translateLegacySettings({ legacyValues }) {
      return { ownerId: agentId, schemaVersion: 1, values: legacyValues };
    },
  };
}

function legacyExecutionConfig(request: AgentExecutionContext) {
  return {
    chatId: request.chatId,
    projectPath: request.projectPath,
    model: request.model,
    permissionMode: request.permissionMode,
    thinkingMode: request.thinkingMode,
    clientRequestId: request.operation.clientRequestId ?? undefined,
    clientMessageId: request.operation.clientMessageId ?? undefined,
    turnId: request.operation.turnId,
    executionAdmission: {
      signal: request.admission.signal,
      markStarted: () => request.admission.markStarted(),
    },
    ...settingsPatch(request.settings),
  };
}

function settingsPatch(settings: AgentSettingsEnvelope): AgentSessionSettingsPatch {
  const values = settings.values;
  return {
    ...(typeof values.claudeThinkingMode === 'string'
      ? { claudeThinkingMode: values.claudeThinkingMode as AgentSessionSettingsPatch['claudeThinkingMode'] }
      : {}),
    ...(typeof values.ampAgentMode === 'string'
      ? { ampAgentMode: values.ampAgentMode as AgentSessionSettingsPatch['ampAgentMode'] }
      : {}),
  };
}

function toLegacyChat(chat: AgentChatReference): AgentChatEntry {
  return {
    agentId: chat.agentId as AgentChatEntry['agentId'],
    projectPath: chat.projectPath,
    agentSessionId: chat.agentSessionId,
    model: chat.model,
    nativePath: nativePath(chat.nativeSession),
    ...settingsPatch(chat.settings),
  };
}

export function nativeSession(
  agentId: string,
  path: string | null | undefined,
  agentSessionId?: string | null,
): AgentNativeSessionRef | null {
  if (!path && !agentSessionId) return null;
  return {
    ownerId: agentId,
    schemaVersion: 1,
    value: {
      ...(path ? { path } : {}),
      ...(agentSessionId ? { agentSessionId } : {}),
    },
  };
}

export function nativePath(reference: AgentNativeSessionRef | null): string | null {
  return typeof reference?.value.path === 'string' ? reference.value.path : null;
}

function normalizePreview(value: unknown): AgentTranscriptPreview | null {
  if (!isRecord(value) || typeof value.firstMessage !== 'string') return null;
  return {
    firstMessage: value.firstMessage,
    lastMessage: typeof value.lastMessage === 'string' ? value.lastMessage : value.firstMessage,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : null,
    lastActivity: typeof value.lastActivity === 'string' ? value.lastActivity : null,
  };
}

function searchChatEntry(agentId: string, chat: AgentSearchChat): AgentChatEntry {
  return {
    agentId: agentId as AgentChatEntry['agentId'],
    projectPath: chat.projectPath,
    model: chat.model,
    agentSessionId: typeof chat.nativeSession?.value.agentSessionId === 'string'
      ? chat.nativeSession.value.agentSessionId
      : null,
    nativePath: nativePath(chat.nativeSession),
  };
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
