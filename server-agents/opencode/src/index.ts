import { PERMISSION_MODE_VALUES, THINKING_MODE_VALUES } from '@garcon/common/chat-modes';
import {
  AgentIntegrationError,
  computeAgentTranscriptRevision,
  type AgentHost,
  type AgentIntegration,
  type AgentTranscript,
} from '@garcon/server-agent-interface';
import { createModelCatalog } from '@garcon/server-agent-common/catalog/model-catalog';
import {
  createArtificialNativePath,
  getArtificialAgentSessionId,
} from '@garcon/server-agent-common/chats/artificial-native-path';
import { createIntegrationLifecycle } from '@garcon/server-agent-common/lifecycle/integration-lifecycle';
import { createScopedAgentLogger } from '@garcon/server-agent-common/logging/scoped-agent-logger';
import { createVersion1RecordMigration } from '@garcon/server-agent-common/migration/version-1-record-migration';
import { createPathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import { createTranscriptSearch } from '@garcon/server-agent-common/search/transcript-search';
import { createVersionedSettings } from '@garcon/server-agent-common/settings/versioned-settings';
import { createOpenCodeConfig } from './config.js';
import { OpenCodeExecution } from './agents/opencode/execution.js';
import {
  getOpenCodePreviewFromSessionId,
  loadOpenCodeChatMessages,
} from './agents/opencode/history-loader.js';
import { getOpenCodeAuthStatus } from './agents/opencode/opencode-auth.js';
import { OpenCodeRuntime } from './agents/opencode/opencode.js';

const OPENCODE_DESCRIPTOR = {
  id: 'opencode',
  label: 'OpenCode',
  icon: null,
  supportedPermissionModes: PERMISSION_MODE_VALUES.filter((mode) => mode !== 'plan'),
  supportedThinkingModes: THINKING_MODE_VALUES,
  supportsImages: false,
  supportsProjectPathUpdate: false,
  requiresNativePathForProjectPathUpdate: false,
  supportedEndpointProtocols: [],
  configuration: [{
    key: 'NODE_ENV',
    source: 'environment' as const,
    description: 'Runtime environment.',
  }],
} as const;

export default class OpenCodeAgentIntegration implements AgentIntegration {
  static readonly integrationId = 'opencode';
  static readonly apiVersion = 1 as const;

  readonly descriptor = OPENCODE_DESCRIPTOR;
  readonly execution;
  readonly transcript: AgentTranscript;
  readonly transcriptSearch;
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
    const config = createOpenCodeConfig(host.environment);
    const logger = createScopedAgentLogger(host.logger, 'opencode');
    const nativeSessions = createPathNativeSessionCodec('opencode');
    const runtime = new OpenCodeRuntime({ config, logger });
    const sessionId = createSessionIdResolver(nativeSessions);

    this.settings = createVersionedSettings({
      ownerId: 'opencode',
      schemaVersion: 1,
      defaults: {},
      descriptors: [],
    });
    this.execution = new OpenCodeExecution(runtime, nativeSessions);
    this.transcript = createOpenCodeTranscript(runtime, nativeSessions, sessionId, logger);
    const search = createTranscriptSearch({
      host,
      agentId: 'opencode',
      loadTranscript: async ({ chat, signal }) => {
        signal.throwIfAborted();
        const id = sessionId(chat);
        if (!id) return [];
        return loadOpenCodeChatMessages(id, () => runtime.getClient(), {
          directory: chat.projectPath,
          signal,
          logger,
        });
      },
    });
    this.transcriptSearch = search;
    this.catalog = createModelCatalog({
      defaultModel: '',
      fallbackModels: [],
      requiresStrictModelDiscovery: false,
      generation: { priority: 60, model: '' },
      discover: () => runtime.getModels(),
    });
    this.migration = createVersion1RecordMigration({ settings: this.settings, nativeSessions });
    this.auth = {
      async status(signal) {
        signal.throwIfAborted();
        return getOpenCodeAuthStatus(runtime);
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
            'OpenCode does not support message-point forks',
            false,
          );
        }
        const sourceSessionId = sessionId(request.source)?.trim();
        if (!sourceSessionId) {
          throw new AgentIntegrationError(
            'TRANSCRIPT_UNAVAILABLE',
            'Cannot fork OpenCode session without a source session ID',
            false,
          );
        }
        const agentSessionId = await runtime.forkSession(sourceSessionId, {
          projectPath: request.source.projectPath,
        });
        return {
          agentSessionId,
          nativeSession: nativeSessions.encode({
            path: createArtificialNativePath('opencode', agentSessionId),
            agentSessionId,
            modelEndpointId: null,
          }),
        };
      },
    };
    this.singleQuery = {
      async run(request) {
        request.signal.throwIfAborted();
        try {
          return await runtime.runSingleQuery(request.prompt, {
            projectPath: request.projectPath,
            model: request.model,
            ...request.settings.values,
          });
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
        await search.close();
      },
    });
  }
}

type NativeSessionCodec = ReturnType<typeof createPathNativeSessionCodec>;
type ChatReference = Parameters<AgentTranscript['load']>[0]['chat'];
type SessionReference = Pick<ChatReference, 'nativeSession'> & {
  readonly agentSessionId?: string | null;
};

function createSessionIdResolver(nativeSessions: NativeSessionCodec) {
  return (chat: SessionReference): string | null => {
    const native = nativeSessions.decode(chat.nativeSession);
    return chat.agentSessionId
      ?? native.agentSessionId
      ?? getArtificialAgentSessionId(native.path, 'opencode');
  };
}

function createOpenCodeTranscript(
  runtime: OpenCodeRuntime,
  nativeSessions: NativeSessionCodec,
  sessionId: (chat: SessionReference) => string | null,
  logger: AgentHost['logger'],
): AgentTranscript {
  const loadMessages = async (chat: ChatReference, signal: AbortSignal) => {
    const id = sessionId(chat);
    if (!id) return [];
    return loadOpenCodeChatMessages(id, () => runtime.getClient(), {
      directory: chat.projectPath,
      signal,
      logger,
    });
  };
  return {
    async resolveNativeSession({ chat, signal }) {
      signal.throwIfAborted();
      const id = sessionId(chat);
      if (!id) return null;
      return nativeSessions.encode({
        path: createArtificialNativePath('opencode', id),
        agentSessionId: id,
        modelEndpointId: null,
      });
    },
    async load({ chat, signal }) {
      signal.throwIfAborted();
      const messages = await loadMessages(chat, signal);
      return { messages, revision: computeAgentTranscriptRevision(messages) };
    },
    async preview({ chat, signal }) {
      signal.throwIfAborted();
      const id = sessionId(chat);
      if (!id) return null;
      return getOpenCodePreviewFromSessionId(id, () => runtime.getClient(), {
        directory: chat.projectPath,
        signal,
        logger,
      });
    },
    async revision({ chat, signal }) {
      signal.throwIfAborted();
      return computeAgentTranscriptRevision(await loadMessages(chat, signal));
    },
    async release({ signal }) {
      signal.throwIfAborted();
    },
  };
}
