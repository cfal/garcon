import { PERMISSION_MODE_VALUES, THINKING_MODE_VALUES } from '@garcon/common/chat-modes';
import { FACTORY_MODELS } from '@garcon/common/models';
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
import { singleQueryRuntimeOptions } from '@garcon/server-agent-common/shared/single-query-control';
import { createFactoryConfig } from './config.js';
import { getFactoryAuthStatus } from './agents/factory/factory-auth.js';
import { FactoryCliRuntime, runSingleQuery } from './agents/factory/factory-cli.js';
import { FactoryExecution } from './agents/factory/execution.js';
import { FactoryModelCatalogService } from './agents/factory/factory-models.js';
import { createFactoryTranscriptSource } from './agents/factory/factory-transcript-source.js';

const FACTORY_DESCRIPTOR = {
  id: 'factory',
  label: 'Factory',
  icon: null,
  supportedPermissionModes: PERMISSION_MODE_VALUES.filter((mode) => mode !== 'plan'),
  supportedThinkingModes: THINKING_MODE_VALUES,
  supportsImages: false,
  supportsProjectPathUpdate: false,
  requiresNativePathForProjectPathUpdate: false,
  supportedEndpointProtocols: [],
  configuration: [
    { key: 'FACTORY_BINARY', source: 'environment' as const, description: 'Factory Droid CLI binary.' },
    { key: 'FACTORY_API_KEY', source: 'environment' as const, description: 'Factory API key.' },
    { key: 'FACTORY_HOME_OVERRIDE', source: 'environment' as const, description: 'Factory home override.' },
  ],
} as const;

export default class FactoryAgentIntegration implements AgentIntegration {
  static readonly integrationId = 'factory';
  static readonly apiVersion = 2 as const;
  static readonly transcriptIndex = {
    apiVersion: 1,
    moduleUrl: resolveAgentStandaloneEntrypoint({
      integrationId: 'factory',
      name: 'transcript-index-source',
      sourceUrl: new URL('./transcript-index-source.ts', import.meta.url),
    }),
  } as const;

  readonly descriptor = FACTORY_DESCRIPTOR;
  readonly execution;
  readonly transcript: AgentTranscript;
  readonly catalog;
  readonly settings;
  readonly lifecycle;
  readonly migration;
  readonly auth: NonNullable<AgentIntegration['auth']>;
  readonly commands = null;
  readonly forking = null;
  readonly endpoints = null;
  readonly singleQuery: NonNullable<AgentIntegration['singleQuery']>;

  constructor(host: AgentHost) {
    const config = createFactoryConfig(host.environment);
    const logger = createScopedAgentLogger(host.logger, 'factory');
    const models = new FactoryModelCatalogService(config);
    const nativeSessions = createPathNativeSessionCodec('factory');
    const runtime = new FactoryCliRuntime({ config, logger, models });
    const transcriptReader = createFactoryTranscriptSource({}, logger);

    this.settings = createVersionedSettings({
      ownerId: 'factory',
      schemaVersion: 1,
      defaults: {},
      descriptors: [],
    });
    this.execution = new FactoryExecution(runtime, nativeSessions);
    this.transcript = createFactoryTranscript(transcriptReader, nativeSessions);
    this.catalog = createModelCatalog({
      logger: host.logger,
      defaultModel: FACTORY_MODELS.DEFAULT,
      fallbackModels: FACTORY_MODELS.OPTIONS,
      requiresStrictModelDiscovery: false,
      generation: { priority: 80, model: FACTORY_MODELS.DEFAULT },
      discover: () => models.getModels(),
    });
    this.migration = createVersion1RecordMigration({ settings: this.settings, nativeSessions });
    this.auth = {
      async status(signal) {
        signal.throwIfAborted();
        const status = await getFactoryAuthStatus(config);
        return {
          authenticated: status.authenticated,
          canReauth: false,
          label: status.label || 'Factory',
          source: status.authenticated ? 'cli' : 'none',
        };
      },
    };
    this.singleQuery = {
      async run(request) {
        request.signal.throwIfAborted();
        try {
          return await runSingleQuery(request.prompt, {
            cwd: request.projectPath,
            model: request.model,
            ...singleQueryRuntimeOptions(request),
          }, config, models);
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

function createFactoryTranscript(
  reader: ReturnType<typeof createFactoryTranscriptSource>,
  nativeSessions: ReturnType<typeof createPathNativeSessionCodec>,
): AgentTranscript {
  const reference = (chat: Parameters<AgentTranscript['load']>[0]['chat']) => ({
    agentSessionId: chat.agentSessionId,
    nativePath: nativeSessions.decode(chat.nativeSession).path,
  });
  const loadMessages = (chat: Parameters<AgentTranscript['load']>[0]['chat']) => (
    reader.loadMessages(reference(chat))
  );
  const resolvePath = async (chat: Parameters<AgentTranscript['load']>[0]['chat']) => {
    const current = reference(chat);
    return current.nativePath ?? reader.resolveNativePath(current);
  };
  const resolveIndexSource = async (chat: Parameters<AgentTranscript['load']>[0]['chat']) => {
    const nativePath = await resolvePath(chat);
    return nativePath ? {
      ownerId: 'factory',
      schemaVersion: 1,
      value: { nativePath },
    } as const : null;
  };
  return {
    async resolveNativeSession({ chat, signal }) {
      signal.throwIfAborted();
      const current = nativeSessions.decode(chat.nativeSession);
      if (current.path) return chat.nativeSession;
      const path = await reader.resolveNativePath(reference(chat));
      return nativeSessions.encode({
        path,
        agentSessionId: chat.agentSessionId,
        modelEndpointId: current.modelEndpointId,
      });
    },
    async load({ chat, signal }) {
      signal.throwIfAborted();
      const messages = await loadMessages(chat);
      return { messages, revision: computeAgentTranscriptRevision(messages) };
    },
    async preview({ chat, signal }) {
      signal.throwIfAborted();
      return normalizePreview(await reader.getPreview(reference(chat)));
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
      const nativePath = await resolvePath(chat);
      return nativePath ? { kind: 'filesystem-path', value: nativePath } : null;
    },
    async release({ signal }) {
      signal.throwIfAborted();
    },
  };
}

function normalizePreview(value: unknown): AgentTranscriptPreview | null {
  if (!value || typeof value !== 'object' || !('firstMessage' in value)) return null;
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
