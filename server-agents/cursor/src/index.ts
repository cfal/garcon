import { PERMISSION_MODE_VALUES, THINKING_MODE_VALUES } from '@garcon/common/chat-modes';
import {
  AgentIntegrationError,
  computeAgentTranscriptRevision,
  type AgentHost,
  type AgentIntegration,
  type AgentTranscript,
  type AgentTranscriptPreview,
} from '@garcon/server-agent-interface';
import { createModelCatalog } from '@garcon/server-agent-common/catalog/model-catalog';
import { resolveAgentStandaloneEntrypoint } from '@garcon/server-agent-common/build/standalone-entrypoint';
import { createIntegrationLifecycle } from '@garcon/server-agent-common/lifecycle/integration-lifecycle';
import { createScopedAgentLogger } from '@garcon/server-agent-common/logging/scoped-agent-logger';
import { createVersion1RecordMigration } from '@garcon/server-agent-common/migration/version-1-record-migration';
import { createPathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import { createVersionedSettings } from '@garcon/server-agent-common/settings/versioned-settings';
import { createCursorConfig } from './config.js';
import { AcpAgentRuntime } from './agents/shared/acp-agent-runtime.js';
import { createCursorAcpPolicy } from './agents/cursor/cursor-acp-policy.js';
import { getCursorAuthStatus } from './agents/cursor/cursor-auth.js';
import { CursorAcpEventConverter } from './agents/cursor/cursor-acp-event-converter.js';
import { CursorExecution } from './agents/cursor/execution.js';
import { cursorStoreDbPath } from './agents/cursor/history-loader.js';
import { getCursorModels } from './agents/cursor/cursor-models.js';
import {
  createCursorAcpNativePath,
  getCursorAgentSessionIdFromNativePath,
} from './agents/cursor/cursor-native-path.js';
import { CursorRequestIdentityStore } from './agents/cursor/cursor-request-identities.js';
import { forkCursorAcpSession } from './agents/cursor/cursor-session-store.js';
import { createCursorTranscriptSource } from './agents/cursor/cursor-transcript-source.js';
import { runSingleQuery } from './agents/cursor/run-single-query.js';

const CURSOR_DESCRIPTOR = {
  id: 'cursor',
  label: 'Cursor',
  icon: null,
  supportedPermissionModes: PERMISSION_MODE_VALUES.filter((mode) => mode !== 'plan'),
  supportedThinkingModes: THINKING_MODE_VALUES,
  supportsImages: false,
  supportsProjectPathUpdate: true,
  requiresNativePathForProjectPathUpdate: false,
  supportedEndpointProtocols: [],
  configuration: [
    {
      key: 'GARCON_CURSOR_BINARY',
      source: 'environment' as const,
      description: 'Garcon Cursor CLI binary.',
    },
    {
      key: 'CURSOR_BINARY',
      source: 'environment' as const,
      description: 'Cursor CLI binary.',
    },
    {
      key: 'CURSOR_API_KEY',
      source: 'environment' as const,
      description: 'Cursor API key.',
    },
  ],
} as const;

export default class CursorAgentIntegration implements AgentIntegration {
  static readonly integrationId = 'cursor';
  static readonly apiVersion = 2 as const;
  static readonly transcriptIndex = {
    apiVersion: 1,
    moduleUrl: resolveAgentStandaloneEntrypoint({
      integrationId: 'cursor',
      name: 'transcript-index-source',
      sourceUrl: new URL('./transcript-index-source.ts', import.meta.url),
    }),
  } as const;

  readonly descriptor = CURSOR_DESCRIPTOR;
  readonly execution;
  readonly transcript: AgentTranscript;
  readonly catalog;
  readonly settings;
  readonly lifecycle;
  readonly migration;
  readonly auth: NonNullable<AgentIntegration['auth']>;
  readonly commands = null;
  readonly forking: NonNullable<AgentIntegration['forking']>;
  readonly endpoints = null;
  readonly singleQuery: NonNullable<AgentIntegration['singleQuery']>;

  constructor(host: AgentHost) {
    const config = createCursorConfig(host.environment);
    const logger = createScopedAgentLogger(host.logger, 'cursor');
    const nativeSessions = createPathNativeSessionCodec('cursor');
    const requestIdentities = new CursorRequestIdentityStore(host.storage.rootDirectory, logger);
    const transcriptReader = createCursorTranscriptSource(requestIdentities);
    const runtime = new AcpAgentRuntime(createCursorAcpPolicy(config, logger), {
      converter: new CursorAcpEventConverter(),
    });

    this.settings = createVersionedSettings({
      ownerId: 'cursor',
      schemaVersion: 1,
      defaults: {},
      descriptors: [],
    });
    this.execution = new CursorExecution(runtime, nativeSessions);
    this.transcript = createCursorTranscript(transcriptReader, nativeSessions);
    this.catalog = createModelCatalog({
      logger: host.logger,
      defaultModel: '',
      fallbackModels: [],
      requiresStrictModelDiscovery: false,
      generation: null,
      discover: () => getCursorModels(config, logger),
    });
    this.migration = createVersion1RecordMigration({ settings: this.settings, nativeSessions });
    this.auth = {
      async status(signal) {
        signal.throwIfAborted();
        return getCursorAuthStatus(config);
      },
    };
    this.forking = {
      supportsAtMessage: false,
      supportsWhileRunning: false,
      async fork(request) {
        request.admission.signal.throwIfAborted();
        if (request.point) {
          throw new AgentIntegrationError(
            'OPERATION_UNSUPPORTED',
            'Cursor does not support message-point forks',
            false,
          );
        }
        const forked = await forkCursorAcpSession(
          cursorReference(request.source, nativeSessions),
        );
        return {
          agentSessionId: forked.agentSessionId,
          nativeSession: nativeSessions.encode({
            path: forked.nativePath,
            agentSessionId: forked.agentSessionId,
            modelEndpointId: null,
          }),
        };
      },
    };
    this.singleQuery = {
      async run(request) {
        request.signal.throwIfAborted();
        try {
          return await runSingleQuery(request.prompt, {
            projectPath: request.projectPath,
            model: request.model,
            ...request.settings.values,
          }, config);
        } catch (error) {
          if (error instanceof AgentIntegrationError) throw error;
          throw new AgentIntegrationError(
            'PROVIDER_FAILURE',
            error instanceof Error ? error.message : String(error),
            false,
          );
        }
      },
    };
    this.lifecycle = createIntegrationLifecycle({
      start: () => runtime.startPurgeTimer(),
      stop: async () => {
        runtime.shutdown();
      },
    });
  }
}

type NativeSessionCodec = ReturnType<typeof createPathNativeSessionCodec>;
type ChatReference = Parameters<AgentTranscript['load']>[0]['chat'];
type CursorReferenceInput = Pick<ChatReference, 'projectPath' | 'nativeSession'> & {
  readonly agentSessionId?: string | null;
};

function cursorReference(chat: CursorReferenceInput, nativeSessions: NativeSessionCodec) {
  const nativePath = nativeSessions.decode(chat.nativeSession).path;
  return {
    projectPath: chat.projectPath,
    nativePath,
    agentSessionId: chat.agentSessionId
      ?? getCursorAgentSessionIdFromNativePath(nativePath),
  };
}

function createCursorTranscript(
  reader: ReturnType<typeof createCursorTranscriptSource>,
  nativeSessions: NativeSessionCodec,
): AgentTranscript {
  const loadMessages = (chat: ChatReference) => reader.loadMessages(
    cursorReference(chat, nativeSessions),
    { chatId: chat.chatId },
  );
  const resolveIndexSource = (chat: ChatReference) => {
    const reference = cursorReference(chat, nativeSessions);
    if (!reference.agentSessionId) return null;
    return {
      ownerId: 'cursor',
      schemaVersion: 1,
      value: {
        sessionId: reference.agentSessionId,
        projectPath: reference.projectPath,
        storePath: cursorStoreDbPath(reference.agentSessionId, reference.projectPath),
      },
    } as const;
  };
  return {
    async resolveNativeSession({ chat, signal }) {
      signal.throwIfAborted();
      const reference = cursorReference(chat, nativeSessions);
      if (!reference.agentSessionId) return null;
      return nativeSessions.encode({
        path: createCursorAcpNativePath(reference.agentSessionId),
        agentSessionId: reference.agentSessionId,
        modelEndpointId: null,
      });
    },
    async load({ chat, signal }) {
      signal.throwIfAborted();
      const messages = await loadMessages(chat);
      return { messages, revision: computeAgentTranscriptRevision(messages) };
    },
    async preview({ chat, signal }) {
      signal.throwIfAborted();
      return normalizePreview(await reader.getPreview(cursorReference(chat, nativeSessions)));
    },
    async revision({ chat, signal }) {
      signal.throwIfAborted();
      return computeAgentTranscriptRevision(await loadMessages(chat));
    },
    async resolveIndexSource({ chat, signal }) {
      signal.throwIfAborted();
      return resolveIndexSource(chat);
    },
    async refreshIndexSource({ chat, signal }) {
      signal.throwIfAborted();
      return resolveIndexSource(chat);
    },
    async describeSource({ chat, signal }) {
      signal.throwIfAborted();
      const source = resolveIndexSource(chat);
      const storePath = source?.value.storePath;
      return typeof storePath === 'string'
        ? { kind: 'filesystem-path', value: storePath }
        : null;
    },
    async release({ signal }) {
      signal.throwIfAborted();
    },
  };
}

function normalizePreview(value: unknown): AgentTranscriptPreview | null {
  if (!value || typeof value !== 'object') return null;
  const preview = value as Record<string, unknown>;
  if (typeof preview.firstMessage !== 'string') return null;
  return {
    firstMessage: preview.firstMessage,
    lastMessage: typeof preview.lastMessage === 'string'
      ? preview.lastMessage
      : preview.firstMessage,
    createdAt: typeof preview.createdAt === 'string' ? preview.createdAt : null,
    lastActivity: typeof preview.lastActivity === 'string' ? preview.lastActivity : null,
  };
}
