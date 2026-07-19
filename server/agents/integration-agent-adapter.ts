import crypto from 'node:crypto';
import type {
  AgentChatReference,
  AgentExecutionEvent,
  AgentIntegration,
  AgentNativeSessionRef,
  AgentOperationIdentity,
} from '@garcon/server-agent-interface';
import type { AgentEndpointSelection as IntegrationEndpointSelection } from '@garcon/common/agent-execution';
import type { AgentSettingsEnvelope } from '@garcon/common/agent-integration';
import type { ChatMessage } from '@garcon/common/chat-types';
import type { JsonObject } from '@garcon/common/json';
import type {
  Agent,
  AgentEndpointRuntimeConfig,
  AgentTranscriptPage,
} from './types.js';
import type {
  AgentChatEntry,
  AgentEventMetadata,
  AgentExecutionConfig,
  AgentSessionSettingsPatch,
  PrepareProjectPathUpdateRequest,
  ResumeTurnRequest,
  StartSessionRequest,
} from './session-types.js';
import type { IntegrationRegistry } from './integration-registry.js';

type MessageListener = (chatId: string, messages: ChatMessage[], metadata?: AgentEventMetadata) => void;
type ProcessingListener = (chatId: string, processing: boolean) => void;
type SessionListener = (chatId: string) => void;
type FinishedListener = (chatId: string, exitCode: number, metadata?: AgentEventMetadata) => void;
type FailedListener = (chatId: string, message: string, metadata?: AgentEventMetadata) => void;

export function createIntegrationAgentAdapters(registry: IntegrationRegistry): Agent[] {
  return registry.list().map(createIntegrationAgentAdapter);
}

export function createIntegrationAgentAdapter(integration: AgentIntegration): Agent {
  const events = new IntegrationEventAdapter(integration);
  const settingsFor = (entry: Pick<AgentChatEntry, 'claudeThinkingMode' | 'ampAgentMode'>): AgentSettingsEnvelope => {
    const defaults = integration.settings.defaults();
    return integration.settings.applyPatch(defaults, legacySettings(entry));
  };

  return {
    id: integration.descriptor.id,
    label: integration.descriptor.label,
    runtime: {
      async startSession(request) {
        const result = await integration.execution.start({
          ...executionContext(integration, request),
          prompt: request.command,
          attachments: attachments(request),
          carryOver: [],
        });
        return {
          agentSessionId: result.agentSessionId,
          nativePath: nativePath(result.nativeSession),
        };
      },
      async runTurn(request) {
        await integration.execution.resume({
          ...executionContext(integration, request),
          agentSessionId: request.agentSessionId,
          nativeSession: nativeSession(integration.descriptor.id, request.nativePath, request.agentSessionId),
          prompt: request.command,
          attachments: attachments(request),
        });
      },
      ...(integration.execution.submitActiveInput ? {
        async submitActiveInput(request, beforeDelivery) {
          return integration.execution.submitActiveInput!({
            ...executionContext(integration, request),
            agentSessionId: request.agentSessionId,
            nativeSession: nativeSession(integration.descriptor.id, request.nativePath, request.agentSessionId),
            prompt: request.command,
            attachments: attachments(request),
            beforeDelivery,
          });
        },
      } : {}),
      ...(integration.execution.compact ? {
        async compact(request) {
          await integration.execution.compact!({
            ...executionContext(integration, request),
            agentSessionId: request.agentSessionId,
            nativeSession: nativeSession(integration.descriptor.id, request.nativePath, request.agentSessionId),
            prompt: request.command,
            attachments: attachments(request),
          });
        },
      } : {}),
      abort: (agentSessionId) => integration.execution.abort(agentSessionId),
      isRunning: (agentSessionId) => integration.execution.isRunning(agentSessionId),
      getRunningSessions: () => integration.execution.runningSessions().map((session) => ({
        id: session.agentSessionId,
        ...(session.status ? { status: session.status } : {}),
        ...(session.startedAt ? { startedAt: session.startedAt } : {}),
      })),
      ...(integration.execution.applySessionConfiguration ? {
        async updateSessionSettings(agentSessionId, patch) {
          await integration.execution.applySessionConfiguration!(agentSessionId, {
            model: patch.model ?? '',
            permissionMode: patch.permissionMode ?? 'default',
            thinkingMode: patch.thinkingMode ?? 'none',
            settings: integration.settings.applyPatch(integration.settings.defaults(), legacySettings(patch)),
            endpoint: null,
          });
        },
      } : {}),
      ...(integration.execution.respondToPermission ? {
        resolvePermission: (requestId, decision) => integration.execution.respondToPermission!(requestId, decision),
      } : {}),
      ...(integration.execution.prepareProjectPathUpdate ? {
        async prepareProjectPathUpdate(request) {
          await integration.execution.prepareProjectPathUpdate!({
            chat: chatReference(integration, {
              agentId: integration.descriptor.id,
              agentSessionId: request.agentSessionId,
              projectPath: request.previousProjectPath,
              model: '',
              nativePath: request.nativePath,
            }, request.chatId),
            nextProjectPath: request.nextProjectPath,
            signal: new AbortController().signal,
          });
        },
      } : {}),
      onMessages: (listener) => events.messages.add(listener),
      onProcessing: (listener) => events.processing.add(listener),
      onSessionCreated: (listener) => events.sessionCreated.add(listener),
      onFinished: (listener) => events.finished.add(listener),
      onFailed: (listener) => events.failed.add(listener),
    },
    transcript: {
      async loadMessages(entry, context) {
        return [...(await integration.transcript.load({
          chat: chatReference(integration, entry, context?.chatId),
          signal: new AbortController().signal,
        })).messages];
      },
      ...(integration.transcript.loadPage ? {
        async loadMessagePage(entry, page, context): Promise<AgentTranscriptPage | null> {
          const result = await integration.transcript.loadPage!({
            chat: chatReference(integration, entry, context?.chatId),
            page,
            signal: new AbortController().signal,
          });
          return result ? { ...result, messages: [...result.messages] } : null;
        },
      } : {}),
      async getPreview(entry) {
        return integration.transcript.preview({
          chat: chatReference(integration, entry),
          signal: new AbortController().signal,
        });
      },
      async resolveNativePath(entry) {
        const reference = await integration.transcript.resolveNativeSession({
          chat: chatReference(integration, entry),
          signal: new AbortController().signal,
        });
        return nativePath(reference);
      },
    },
    auth: integration.auth ? {
      getAuthStatus: () => integration.auth!.status(new AbortController().signal),
      ...(integration.auth.launchLogin ? { launchLogin: () => integration.auth!.launchLogin!() } : {}),
      ...(integration.auth.completeLogin ? {
        completeLogin: (sessionId, code) => integration.auth!.completeLogin!(sessionId, code),
      } : {}),
      ...(integration.auth.loginStatus ? {
        loginStatus: (sessionId) => integration.auth!.loginStatus!(sessionId),
      } : {}),
    } : { getAuthStatus: async () => ({ authenticated: false }) },
    capabilities: {
      getModels: async ({ strict = false } = {}) => [...(await integration.catalog.snapshot({
        strict,
        signal: new AbortController().signal,
      })).models],
      supportsFork: integration.forking !== null,
      supportsForkAtMessage: integration.forking?.supportsAtMessage ?? false,
      supportsForkWhileRunning: integration.forking?.supportsWhileRunning ?? false,
      supportsUpdateProjectPath: integration.descriptor.supportsProjectPathUpdate,
      requiresNativePathForProjectPathUpdate: integration.descriptor.requiresNativePathForProjectPathUpdate,
      supportsImages: integration.descriptor.supportsImages,
      acceptsApiProviderEndpoints: integration.endpoints !== null,
      supportedProtocols: integration.descriptor.supportedEndpointProtocols.filter(
        (protocol): protocol is 'anthropic-messages' | 'openai-compatible' => (
          protocol === 'anthropic-messages' || protocol === 'openai-compatible'
        ),
      ),
      authLoginSupported: Boolean(integration.auth?.launchLogin),
      requiresStrictModelDiscovery: false,
    },
    prepareEndpointRuntime: (selection): AgentEndpointRuntimeConfig => ({
      integrationEndpoint: endpointSelection(selection),
    }),
    ...(integration.forking ? {
      async forkSession(args) {
        const source = chatReference(integration, args.sourceSession, args.sourceChatId);
        const result = await integration.forking!.fork({
          ...executionContext(integration, {
            chatId: args.targetChatId,
            projectPath: source.projectPath,
            model: source.model,
            permissionMode: args.sourceSession.permissionMode ?? 'default',
            thinkingMode: args.sourceSession.thinkingMode ?? 'none',
            claudeThinkingMode: args.sourceSession.claudeThinkingMode,
            ampAgentMode: args.sourceSession.ampAgentMode,
            integrationEndpoint: args.integrationEndpoint,
          }),
          source,
          point: null,
        });
        return { agentSessionId: result.agentSessionId, nativePath: nativePath(result.nativeSession) };
      },
    } : {}),
    ...(integration.singleQuery ? {
      runSingleQuery: (prompt, options = {}) => integration.singleQuery!.run({
        prompt,
        projectPath: typeof options.projectPath === 'string' ? options.projectPath : process.cwd(),
        model: typeof options.model === 'string' ? options.model : '',
        settings: integration.settings.applyPatch(integration.settings.defaults(), legacySettings(options)),
        endpoint: isEndpoint(options.integrationEndpoint) ? options.integrationEndpoint : null,
        signal: new AbortController().signal,
      }),
    } : {}),
    ...(integration.commands ? {
      discoverSlashCommands: (projectPath) => integration.commands!.discover(
        projectPath,
        new AbortController().signal,
      ).then((commands) => [...commands]),
    } : {}),
  };
}

class IntegrationEventAdapter {
  readonly messages = new Set<MessageListener>();
  readonly processing = new Set<ProcessingListener>();
  readonly sessionCreated = new Set<SessionListener>();
  readonly finished = new Set<FinishedListener>();
  readonly failed = new Set<FailedListener>();

  constructor(integration: AgentIntegration) {
    integration.execution.subscribe((event) => this.#dispatch(event));
  }

  #dispatch(event: AgentExecutionEvent): void {
    const metadata = eventMetadata(event.operation);
    switch (event.type) {
      case 'messages':
        for (const listener of this.messages) listener(event.chatId, [...event.messages], metadata);
        return;
      case 'processing':
        for (const listener of this.processing) listener(event.chatId, event.processing);
        return;
      case 'session-created':
        for (const listener of this.sessionCreated) listener(event.chatId);
        return;
      case 'finished':
        for (const listener of this.finished) listener(event.chatId, event.exitCode, metadata);
        return;
      case 'failed':
        for (const listener of this.failed) listener(event.chatId, event.error.message, metadata);
    }
  }
}

function executionContext(integration: AgentIntegration, request: AgentExecutionConfig) {
  return {
    chatId: request.chatId,
    projectPath: request.projectPath,
    model: request.model,
    permissionMode: request.permissionMode,
    thinkingMode: request.thinkingMode,
    settings: integration.settings.applyPatch(integration.settings.defaults(), legacySettings(request)),
    endpoint: request.integrationEndpoint ?? null,
    operation: operationIdentity(request),
    admission: {
      signal: request.executionAdmission?.signal ?? new AbortController().signal,
      markStarted: () => request.executionAdmission?.markStarted(),
      markAbortable: () => request.onAbortable?.(),
    },
  };
}

function operationIdentity(request: AgentExecutionConfig): AgentOperationIdentity {
  return {
    commandType: request.commandType ?? 'agent-run',
    clientRequestId: request.clientRequestId ?? null,
    clientMessageId: request.clientMessageId ?? null,
    turnId: request.turnId ?? crypto.randomUUID(),
  };
}

function eventMetadata(operation: AgentOperationIdentity): AgentEventMetadata {
  return {
    commandType: operation.commandType,
    ...(operation.clientRequestId ? { clientRequestId: operation.clientRequestId } : {}),
    turnId: operation.turnId,
  };
}

function attachments(request: StartSessionRequest | ResumeTurnRequest) {
  return (request.images ?? []).map((image) => ({
    kind: 'image' as const,
    data: image.data,
    name: image.name ?? null,
    mimeType: image.mimeType ?? 'application/octet-stream',
  }));
}

function legacySettings(value: {
  claudeThinkingMode?: unknown;
  ampAgentMode?: unknown;
}): JsonObject {
  return {
    ...(typeof value.claudeThinkingMode === 'string' ? { claudeThinkingMode: value.claudeThinkingMode } : {}),
    ...(typeof value.ampAgentMode === 'string' ? { ampAgentMode: value.ampAgentMode } : {}),
  };
}

function chatReference(
  integration: AgentIntegration,
  entry: AgentChatEntry,
  chatId = '',
): AgentChatReference {
  return {
    chatId,
    agentId: integration.descriptor.id,
    agentSessionId: entry.agentSessionId ?? null,
    projectPath: entry.projectPath,
    model: entry.model ?? '',
    nativeSession: nativeSession(integration.descriptor.id, entry.nativePath, entry.agentSessionId),
    carryOverRevision: 'carry-v1:0',
    settings: integration.settings.applyPatch(integration.settings.defaults(), legacySettings(entry)),
  };
}

function nativeSession(
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

function nativePath(reference: AgentNativeSessionRef | null): string | null {
  return typeof reference?.value.path === 'string' ? reference.value.path : null;
}

function endpointSelection(selection: Parameters<NonNullable<Agent['prepareEndpointRuntime']>>[0]): IntegrationEndpointSelection {
  return {
    apiProviderId: selection.apiProviderId,
    endpointId: selection.modelEndpointId,
    protocol: selection.modelProtocol,
    baseUrl: selection.endpoint.baseUrl,
    model: selection.model,
    isLocal: selection.isLocal,
    credential: {
      kind: 'api-provider-endpoint',
      apiProviderId: selection.apiProviderId,
      endpointId: selection.modelEndpointId,
    },
  };
}

function isEndpoint(value: unknown): value is IntegrationEndpointSelection {
  return value !== null && typeof value === 'object' && 'endpointId' in value;
}
