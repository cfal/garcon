import type {
  AgentChatReference,
  AgentExecution,
  AgentExecutionContext,
  AgentExecutionEvent,
  AgentForkRequest,
  AgentHost,
  AgentIntegration,
  AgentNativeSessionRef,
  AgentTranscript,
  AgentTranscriptPreview,
  AgentTranscriptSearch,
  AgentSearchChat,
} from '@garcon/server-agent-interface';
import {
  AgentIntegrationError,
  computeAgentTranscriptRevision,
  getNativeMessageRevisionSource,
} from '@garcon/server-agent-interface';
import type { AgentSettingsEnvelope } from '@garcon/common/agent-integration';
import type { AgentDescriptor, AgentSettingDescriptor } from '@garcon/common/agent-integration';
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
  StartedAgentSession,
} from './session-types.js';
import { createTranscriptSearch } from '../search/transcript-search.js';
import { renderTranscriptSeed } from '@garcon/common/transcript-seed';
import { forkJsonlTranscript } from './fork-jsonl.js';
import { promises as fs } from 'node:fs';
import { createModelCatalog } from '../catalog/model-catalog.js';
import { createIntegrationLifecycle } from '../lifecycle/integration-lifecycle.js';
import { createVersion1RecordMigration } from '../migration/version-1-record-migration.js';
import { createPathNativeSessionCodec } from '../native-session/path-native-session.js';
import { createVersionedSettings } from '../settings/versioned-settings.js';

export interface LegacyIntegrationOptions {
  readonly host: AgentHost;
  readonly descriptor: AgentDescriptor;
  readonly agent: Agent;
  readonly transcriptSearch: AgentTranscriptSearch;
  readonly defaultModel: string;
  readonly models?: readonly AgentModelOption[];
  readonly generation?: { readonly priority: number; readonly model?: string } | null;
  readonly defaultSettings?: JsonObject;
  readonly settingDescriptors?: readonly AgentSettingDescriptor[];
  readonly toLegacySettings?: (
    settings: AgentSettingsEnvelope,
  ) => AgentSessionSettingsPatch;
  readonly prepareStart?: (
    request: Parameters<AgentExecution['start']>[0],
    legacy: StartSessionRequest,
  ) => StartSessionRequest;
  readonly prepareResume?: (
    request: Parameters<AgentExecution['resume']>[0],
    legacy: ResumeTurnRequest,
  ) => ResumeTurnRequest;
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
  const settings = createVersionedSettings({
    ownerId: options.descriptor.id,
    schemaVersion: 1,
    defaults: options.defaultSettings ?? {},
    descriptors: options.settingDescriptors ?? [],
  });
  const execution = new LegacyExecution(
    options.host,
    options.agent,
    options.descriptor.id,
    options,
  );
  const transcript = createTranscript(
    options.agent,
    options.descriptor.id,
    options.toLegacySettings,
  );
  const catalog = createModelCatalog({
    defaultModel: options.defaultModel,
    fallbackModels: options.models ?? [],
    requiresStrictModelDiscovery: options.agent.capabilities.requiresStrictModelDiscovery,
    generation: options.agent.runSingleQuery && options.generation
      ? {
        priority: options.generation.priority,
        model: options.generation.model || options.defaultModel,
      }
      : null,
    discover: options.agent.capabilities.getModels
      ? ({ strict }) => options.agent.capabilities.getModels!({ strict })
      : undefined,
  });
  const lifecycle = createIntegrationLifecycle({
    start: () => options.agent.runtime.startPurgeTimer?.(),
    stop: async () => {
      options.agent.runtime.shutdown?.();
      if ('close' in options.transcriptSearch && typeof options.transcriptSearch.close === 'function') {
        await options.transcriptSearch.close();
      }
    },
  });
  const migration = createVersion1RecordMigration({
    settings,
    nativeSessions: createPathNativeSessionCodec(options.descriptor.id),
  });

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
    forking: options.agent.capabilities.supportsFork ? {
      supportsAtMessage: options.agent.capabilities.supportsForkAtMessage,
      supportsWhileRunning: options.agent.capabilities.supportsForkWhileRunning,
      async fork(request) {
        request.admission.signal.throwIfAborted();
        const result = await forkLegacySession(options, request);
        if (!result) {
          throw new AgentIntegrationError('OPERATION_UNSUPPORTED', 'Agent fork did not create a session', false);
        }
        return {
          agentSessionId: result.agentSessionId,
          nativeSession: nativeSession(
            options.descriptor.id,
            result.nativePath,
            result.agentSessionId,
            request.endpoint?.endpointId,
          ),
        };
      },
    } : null,
    endpoints: options.agent.capabilities.acceptsApiProviderEndpoints ? {
      async validate(selection) {
        if (!options.agent.capabilities.supportedProtocols.includes(selection.protocol)) {
          throw new AgentIntegrationError('INVALID_ENDPOINT', 'Endpoint protocol is not supported', false);
        }
      },
    } : null,
    singleQuery: options.agent.runSingleQuery ? {
      async run({ prompt, projectPath, model, settings: envelope, endpoint, signal }) {
        signal.throwIfAborted();
        try {
          const endpointRuntime = await resolveLegacyEndpointRuntime(
            options.host,
            options.agent,
            options.onEndpointSelection,
            endpoint,
            signal,
          );
          return await options.agent.runSingleQuery!(prompt, {
            projectPath,
            model,
            ...envelope.values,
            ...endpointRuntime,
          });
        } catch (error) {
          if (error instanceof AgentIntegrationError) throw error;
          throw classifyLegacySingleQueryError(error);
        }
      },
    } : null,
  };
}

class LegacyExecution implements AgentExecution {
  readonly #host: AgentHost;
  readonly #agent: Agent;
  readonly #agentId: string;
  readonly #options: LegacyIntegrationOptions;
  readonly #listeners = new Set<(event: AgentExecutionEvent) => void>();
  readonly #operations = new Map<string, AgentExecutionContext['operation']>();

  constructor(
    host: AgentHost,
    agent: Agent,
    agentId: string,
    options: LegacyIntegrationOptions,
  ) {
    this.#host = host;
    this.#agent = agent;
    this.#agentId = agentId;
    this.#options = options;
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
    const carryOver = request.carryOver.length > 0
      ? `${renderTranscriptSeed([...request.carryOver])}\n\n`
      : '';
    const legacy = {
      ...legacyExecutionConfig(request, this.#options.toLegacySettings),
      command: `${carryOver}${request.prompt}`,
      images: request.attachments.map((attachment) => ({
        data: attachment.data,
        ...(attachment.name ? { name: attachment.name } : {}),
        mimeType: attachment.mimeType,
      })),
      ...endpoint,
      onAbortable: () => request.admission.markAbortable(),
    } satisfies StartSessionRequest;
    const result = await this.#agent.runtime.startSession(
      this.#options.prepareStart?.(request, legacy) ?? legacy,
    );
    const session = {
      agentSessionId: result.agentSessionId,
      nativeSession: nativeSession(
        this.#agentId,
        result.nativePath,
        result.agentSessionId,
        request.endpoint?.endpointId,
      ),
    };
    this.#emit({ type: 'session-created', chatId: request.chatId, session, operation: request.operation });
    return session;
  }

  async resume(request: Parameters<AgentExecution['resume']>[0]): Promise<void> {
    this.#operations.set(request.chatId, request.operation);
    request.admission.signal.throwIfAborted();
    const endpoint = await this.#endpointRuntime(request.endpoint, request.admission.signal);
    const legacy = {
      ...legacyExecutionConfig(request, this.#options.toLegacySettings),
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
    } satisfies ResumeTurnRequest;
    await this.#agent.runtime.runTurn(this.#options.prepareResume?.(request, legacy) ?? legacy);
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
    const legacy = {
      ...legacyExecutionConfig(request, this.#options.toLegacySettings),
      agentSessionId: request.agentSessionId,
      command: request.prompt,
      nativePath: nativePath(request.nativeSession),
      ...endpoint,
      onAbortable: () => request.admission.markAbortable(),
    } satisfies ResumeTurnRequest;
    return this.#agent.runtime.submitActiveInput(
      this.#options.prepareResume?.(request, legacy) ?? legacy,
      request.beforeDelivery,
    );
  }

  async compact(request: Parameters<NonNullable<AgentExecution['compact']>>[0]): Promise<void> {
    this.#operations.set(request.chatId, request.operation);
    const endpoint = await this.#endpointRuntime(request.endpoint, request.admission.signal);
    const legacy = {
      ...legacyExecutionConfig(request, this.#options.toLegacySettings),
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
      ...mapLegacySettings(configuration.settings, this.#options.toLegacySettings),
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
    return resolveLegacyEndpointRuntime(
      this.#host,
      this.#agent,
      this.#options.onEndpointSelection,
      endpoint,
      signal,
    );
  }
}

async function resolveLegacyEndpointRuntime(
  host: AgentHost,
  agent: Agent,
  onEndpointSelection: LegacyIntegrationOptions['onEndpointSelection'],
  endpoint: AgentEndpointSelection | null,
  signal: AbortSignal,
) {
  if (!endpoint) return {};
  const resolved = endpoint.credential
    ? await host.apiProviders.resolveCredential({ reference: endpoint.credential, signal })
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
  onEndpointSelection?.(endpoint, resolved?.value ?? '');
  const legacySelection: LegacyEndpointSelection = {
    model: endpoint.model,
    apiProviderId: endpoint.apiProviderId,
    modelEndpointId: endpoint.endpointId,
    modelProtocol: endpoint.protocol,
    isLocal: endpoint.isLocal,
    apiProvider,
    endpoint: storedEndpoint,
  };
  return {
    apiProviderId: endpoint.apiProviderId,
    modelEndpointId: endpoint.endpointId,
    modelProtocol: endpoint.protocol,
    ...(agent.prepareEndpointRuntime?.(legacySelection) ?? {}),
  };
}

function createTranscript(
  agent: Agent,
  agentId: string,
  toLegacySettings?: LegacyIntegrationOptions['toLegacySettings'],
): AgentTranscript {
  const load = async (chat: AgentChatReference) => {
    const messages = await agent.transcript.loadMessages(
      toLegacyChat(chat, toLegacySettings),
      { chatId: chat.chatId },
    );
    return { messages, revision: computeAgentTranscriptRevision(messages) };
  };
  return {
    async resolveNativeSession({ chat, signal }) {
      signal.throwIfAborted();
      if (!agent.transcript.resolveNativePath) return chat.nativeSession;
      const resolved = await agent.transcript.resolveNativePath(toLegacyChat(chat, toLegacySettings));
      return nativeSession(
        agentId,
        resolved,
        chat.agentSessionId,
        nativeModelEndpointId(chat.nativeSession),
      );
    },
    async load({ chat, signal }) {
      signal.throwIfAborted();
      return load(chat);
    },
    ...(agent.transcript.loadMessagePage ? {
      async loadPage({ chat, page, signal }) {
        signal.throwIfAborted();
        const result = await agent.transcript.loadMessagePage!(
          toLegacyChat(chat, toLegacySettings),
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
      return normalizePreview(await agent.transcript.getPreview(toLegacyChat(chat, toLegacySettings)));
    },
    async revision({ chat, signal }) {
      signal.throwIfAborted();
      return (await load(chat)).revision;
    },
    async release({ chat, reason, signal }) {
      signal.throwIfAborted();
      await agent.transcript.release?.(toLegacyChat(chat, toLegacySettings), reason);
    },
  };
}

async function forkLegacySession(
  options: LegacyIntegrationOptions,
  request: AgentForkRequest,
): Promise<StartedAgentSession | null> {
  const source = toLegacyChat(request.source, options.toLegacySettings);
  if (!request.point && options.agent.forkSession) {
    return options.agent.forkSession({
      sourceSession: source,
      sourceChatId: request.source.chatId,
      targetChatId: request.chatId,
    });
  }

  const sourceAgentSessionId = source.agentSessionId;
  const sourcePath = source.nativePath ?? await options.agent.transcript.resolveNativePath?.(source);
  if (!sourceAgentSessionId || !sourcePath) {
    throw new AgentIntegrationError('TRANSCRIPT_UNAVAILABLE', 'Source native transcript is unavailable', false);
  }

  let cutoffLine: number | null = null;
  let leadingLineCount = 0;
  let retainedMessageCounts: ReadonlyMap<number, number> | undefined;
  let expectedForkRevision: string | null = null;
  if (request.point) {
    if (!options.agent.capabilities.supportsForkAtMessage) {
      throw new AgentIntegrationError('OPERATION_UNSUPPORTED', 'Message-point fork is unsupported', false);
    }
    if (request.point.sourceRevision.carryOver !== request.source.carryOverRevision) {
      throw sourceRevisionChanged();
    }
    const carryOver = await options.host.carryOver.load({
      chatId: request.source.chatId,
      expectedRevision: request.point.sourceRevision.carryOver,
      currentAgentId: request.source.agentId,
      currentModel: request.source.model,
      signal: request.admission.signal,
    }).catch(() => { throw sourceRevisionChanged(); });
    const nativeMessages = await options.agent.transcript.loadMessages(source, {
      chatId: request.source.chatId,
    });
    if (computeAgentTranscriptRevision(nativeMessages) !== request.point.sourceRevision.native) {
      throw sourceRevisionChanged();
    }
    const nativeSequence = Math.max(0, request.point.messageSequence - carryOver.messages.length);
    if (nativeSequence > nativeMessages.length) {
      throw new AgentIntegrationError('TRANSCRIPT_UNAVAILABLE', 'Fork message is outside the source transcript', false);
    }
    const sourceLines = nativeMessages
      .map((message) => getNativeMessageRevisionSource(message)?.lineNumber)
      .filter((line): line is number => line !== undefined);
    leadingLineCount = sourceLines.length > 0 ? Math.max(0, Math.min(...sourceLines) - 1) : 0;
    const retainedNativeMessages = nativeMessages.slice(0, nativeSequence);
    expectedForkRevision = computeAgentTranscriptRevision(retainedNativeMessages);
    const retainedCounts = new Map<number, number>();
    for (const message of retainedNativeMessages) {
      const sourcePosition = getNativeMessageRevisionSource(message);
      if (!sourcePosition?.lineNumber) {
        throw new AgentIntegrationError(
          'TRANSCRIPT_UNAVAILABLE',
          'The selected transcript prefix has no provider-native fork position',
          false,
        );
      }
      retainedCounts.set(
        sourcePosition.lineNumber,
        (retainedCounts.get(sourcePosition.lineNumber) ?? 0) + 1,
      );
    }
    retainedMessageCounts = retainedCounts;
    if (nativeSequence === 0) {
      cutoffLine = 0;
    } else {
      cutoffLine = Math.max(...retainedCounts.keys());
    }
  }

  const result = await forkJsonlTranscript({
    sourcePath,
    sourceAgentSessionId,
    cutoffLine,
    leadingLineCount,
    retainedMessageCounts,
    rewriteEntry: options.agent.transcript.rewriteForkTranscriptEntry,
  });
  if (request.point) {
    const currentMessages = await options.agent.transcript.loadMessages(source, {
      chatId: request.source.chatId,
    });
    if (computeAgentTranscriptRevision(currentMessages) !== request.point.sourceRevision.native) {
      await fs.rm(result.nativePath, { force: true }).catch(() => undefined);
      throw sourceRevisionChanged();
    }
    const forkedMessages = await options.agent.transcript.loadMessages({
      ...source,
      agentSessionId: result.agentSessionId,
      nativePath: result.nativePath,
    }, { chatId: request.chatId });
    if (computeAgentTranscriptRevision(forkedMessages) !== expectedForkRevision) {
      await fs.rm(result.nativePath, { force: true }).catch(() => undefined);
      throw new AgentIntegrationError(
        'TRANSCRIPT_UNAVAILABLE',
        'The provider-native fork did not preserve the selected message prefix',
        false,
      );
    }
  }
  return result;
}

function sourceRevisionChanged(): AgentIntegrationError {
  return new AgentIntegrationError(
    'SOURCE_REVISION_CHANGED',
    'Source transcript changed while the fork was being created',
    true,
  );
}

function classifyLegacySingleQueryError(error: unknown): AgentIntegrationError {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  const code = normalized.includes('401')
    || normalized.includes('unauthorized')
    || normalized.includes('forbidden')
    || normalized.includes('auth')
    || normalized.includes('login')
    || normalized.includes('api key')
    ? 'AUTH_REQUIRED'
    : normalized.includes('429')
      || normalized.includes('rate limit')
      || normalized.includes('quota')
      || normalized.includes('too many requests')
      ? 'RATE_LIMITED'
      : normalized.includes('timed out')
        || normalized.includes('timeout')
        || normalized.includes('deadline')
        || normalized.includes('etimedout')
        ? 'TIMEOUT'
        : normalized.includes('service unavailable')
          || normalized.includes('unavailable')
          || normalized.includes('econnrefused')
          || normalized.includes('enotfound')
          || normalized.includes('network')
          ? 'UNAVAILABLE'
          : 'PROVIDER_FAILURE';
  return new AgentIntegrationError(code, message, code !== 'AUTH_REQUIRED');
}

function legacyExecutionConfig(
  request: AgentExecutionContext,
  toLegacySettings?: LegacyIntegrationOptions['toLegacySettings'],
) {
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
    ...mapLegacySettings(request.settings, toLegacySettings),
  };
}

function mapLegacySettings(
  settings: AgentSettingsEnvelope,
  mapper?: LegacyIntegrationOptions['toLegacySettings'],
): AgentSessionSettingsPatch {
  return mapper?.(settings) ?? {};
}

function toLegacyChat(
  chat: AgentChatReference,
  toLegacySettings?: LegacyIntegrationOptions['toLegacySettings'],
): AgentChatEntry {
  return {
    agentId: chat.agentId as AgentChatEntry['agentId'],
    projectPath: chat.projectPath,
    agentSessionId: chat.agentSessionId,
    model: chat.model,
    modelEndpointId: nativeModelEndpointId(chat.nativeSession),
    nativePath: nativePath(chat.nativeSession),
    ...mapLegacySettings(chat.settings, toLegacySettings),
  };
}

export function nativeSession(
  agentId: string,
  path: string | null | undefined,
  agentSessionId?: string | null,
  modelEndpointId?: string | null,
): AgentNativeSessionRef | null {
  if (!path && !agentSessionId && !modelEndpointId) return null;
  return {
    ownerId: agentId,
    schemaVersion: 1,
    value: {
      ...(path ? { path } : {}),
      ...(agentSessionId ? { agentSessionId } : {}),
      ...(modelEndpointId ? { modelEndpointId } : {}),
    },
  };
}

export function nativePath(reference: AgentNativeSessionRef | null): string | null {
  return typeof reference?.value.path === 'string' ? reference.value.path : null;
}

function nativeModelEndpointId(reference: AgentNativeSessionRef | null): string | null {
  return typeof reference?.value.modelEndpointId === 'string'
    ? reference.value.modelEndpointId
    : null;
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
    modelEndpointId: nativeModelEndpointId(chat.nativeSession),
    nativePath: nativePath(chat.nativeSession),
  };
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
