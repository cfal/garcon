import { PERMISSION_MODE_VALUES, THINKING_MODE_VALUES } from '@garcon/common/chat-modes';
import { FACTORY_MODELS } from '@garcon/common/models';
import {
  AgentIntegrationError,
  type AgentChatReference,
  type AgentHost,
  type AgentIntegrationV4,
} from '@garcon/server-agent-interface';
import type { AgentNativeEvidenceSource } from '@garcon/server-agent-common/transcript-projection/evidence-source';
import { createModelCatalog } from '@garcon/server-agent-common/catalog/model-catalog';
import { resolveAgentStandaloneEntrypoint } from '@garcon/server-agent-common/build/standalone-entrypoint';
import { createIntegrationLifecycle } from '@garcon/server-agent-common/lifecycle/integration-lifecycle';
import { createScopedAgentLogger } from '@garcon/server-agent-common/logging/scoped-agent-logger';
import { createVersion1RecordMigration } from '@garcon/server-agent-common/migration/version-1-record-migration';
import { createPathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import { createVersionedSettings } from '@garcon/server-agent-common/settings/versioned-settings';
import { singleQueryRuntimeOptions } from '@garcon/server-agent-common/shared/single-query-control';
import { createAgentOwnedProjection } from '@garcon/server-agent-common/transcript-projection/owned-projection';
import { createAgentProducerAdapter } from '@garcon/server-agent-common/execution/producer-adapter';
import { createNativeHistoryImport } from '@garcon/server-agent-common/transcript-projection/native-history-import';
import { createFactoryConfig } from './config.js';
import { getFactoryAuthStatus } from './agents/factory/factory-auth.js';
import { FactoryCliRuntime, runSingleQuery } from './agents/factory/factory-cli.js';
import { FactoryExecution } from './agents/factory/execution.js';
import { FactoryModelCatalogService } from './agents/factory/factory-models.js';
import { createFactoryTranscriptSource } from './agents/factory/factory-transcript-source.js';
import { createFactoryNativeActivityProbe } from './agents/factory/native-activity.js';

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

export default class FactoryAgentIntegration implements AgentIntegrationV4 {
  static readonly integrationId = 'factory';
  static readonly apiVersion = 4 as const;
  static readonly transcriptIndex = {
    apiVersion: 2,
    moduleUrl: resolveAgentStandaloneEntrypoint({
      integrationId: 'factory',
      name: 'transcript-index-source',
      sourceUrl: new URL('./transcript-index-source.ts', import.meta.url),
    }),
  } as const;

  readonly descriptor = FACTORY_DESCRIPTOR;
  readonly attachments = null;
  readonly execution;
  readonly producerExecution;
  readonly transcript;
  readonly nativeHistoryImport;
  readonly nativeActivity;
  readonly catalog;
  readonly settings;
  readonly lifecycle;
  readonly migration;
  readonly auth: NonNullable<AgentIntegrationV4['auth']>;
  readonly commands = null;
  readonly compaction = null;
  readonly forking = null;
  readonly steering = null;
  readonly goals = null;
  readonly endpoints = null;
  readonly singleQuery: NonNullable<AgentIntegrationV4['singleQuery']>;
  readonly transientControls = { protocol: 'ordered-stream-v1' as const };

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
    const providerExecution = new FactoryExecution(runtime, nativeSessions);
    const nativeEvidence = createFactoryNativeEvidence(transcriptReader, nativeSessions);
    this.producerExecution = createAgentProducerAdapter(providerExecution).execution;
    this.nativeHistoryImport = createNativeHistoryImport(nativeEvidence);
    this.nativeActivity = createFactoryNativeActivityProbe(nativeSessions);
    const projection = createAgentOwnedProjection({
      ownerId: 'factory',
      host,
      execution: providerExecution,
      nativeEvidence,
    });
    this.execution = projection.execution;
    this.transcript = projection.transcript;
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

function createFactoryNativeEvidence(
  reader: ReturnType<typeof createFactoryTranscriptSource>,
  nativeSessions: ReturnType<typeof createPathNativeSessionCodec>,
): AgentNativeEvidenceSource {
  const reference = (chat: AgentChatReference) => ({
    agentSessionId: chat.agentSessionId,
    nativePath: nativeSessions.decode(chat.nativeSession).path,
  });
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
      return { messages: await reader.loadMessages(reference(chat)) };
    },
    async describeSource({ chat, signal }) {
      signal.throwIfAborted();
      const current = reference(chat);
      const nativePath = current.nativePath ?? await reader.resolveNativePath(current);
      return nativePath ? { kind: 'filesystem-path', value: nativePath } : null;
    },
    async release({ signal }) {
      signal.throwIfAborted();
    },
  };
}
