import { PERMISSION_MODE_VALUES, THINKING_MODE_VALUES } from '@garcon/common/chat-modes';
import { retargetNativeSeedReceipt } from '@garcon/common/transcript-seed';
import {
  AgentIntegrationError,
  type AgentChatReference,
  type AgentHost,
  type AgentIntegration,
} from '@garcon/server-agent-interface';
import type { AgentNativeEvidenceSource } from '@garcon/server-agent-common/native-session/evidence-source';
import { createModelCatalog } from '@garcon/server-agent-common/catalog/model-catalog';
import {
  createArtificialNativePath,
  getArtificialAgentSessionId,
} from '@garcon/server-agent-common/chats/artificial-native-path';
import { createIntegrationLifecycle } from '@garcon/server-agent-common/lifecycle/integration-lifecycle';
import { createScopedAgentLogger } from '@garcon/server-agent-common/logging/scoped-agent-logger';
import { createVersion1RecordMigration } from '@garcon/server-agent-common/migration/version-1-record-migration';
import { createPathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import { createVersionedSettings } from '@garcon/server-agent-common/settings/versioned-settings';
import { singleQueryRuntimeOptions } from '@garcon/server-agent-common/shared/single-query-control';
import { createAgentProducerAdapter } from '@garcon/server-agent-common/execution/producer-adapter';
import { createNativeHistoryImport } from '@garcon/server-agent-common/native-session/native-history-import';
import { createOpenCodeConfig } from './config.js';
import { OpenCodeExecution } from './agents/opencode/execution.js';
import { loadOpenCodeChatMessages } from './agents/opencode/history-loader.js';
import { getOpenCodeAuthStatus } from './agents/opencode/opencode-auth.js';
import { OpenCodeRuntime } from './agents/opencode/opencode.js';
import { createOpenCodeNativeActivityProbe } from './agents/opencode/native-activity.js';

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
  static readonly apiVersion = 5 as const;
  readonly descriptor = OPENCODE_DESCRIPTOR;
  readonly attachments = null;
  readonly execution;
  readonly nativeHistoryImport;
  readonly nativeActivity;
  readonly nativeSessions;
  readonly sessionConfiguration: NonNullable<AgentIntegration['sessionConfiguration']>;
  readonly projectPathUpdates = null;
  readonly catalog;
  readonly settings;
  readonly lifecycle;
  readonly migration;
  readonly auth: NonNullable<AgentIntegration['auth']>;
  readonly commands = null;
  readonly compaction = null;
  readonly forking = null;
  readonly steering: NonNullable<AgentIntegration['steering']>;
  readonly goals = null;
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
    const providerExecution = new OpenCodeExecution(runtime, nativeSessions);
    this.sessionConfiguration = {
      apply: (agentSessionId, configuration) => (
        providerExecution.applySessionConfiguration(agentSessionId, configuration)
      ),
    };
    const nativeEvidence = createOpenCodeNativeEvidence(runtime, nativeSessions, sessionId, logger);
    this.nativeSessions = nativeEvidence;
    this.execution = createAgentProducerAdapter(providerExecution, logger).execution;
    this.nativeHistoryImport = createNativeHistoryImport(nativeEvidence);
    this.nativeActivity = createOpenCodeNativeActivityProbe({
      nativeSessions,
      logger,
      withClient: (operation) => runtime.withClientLease((client) => operation(async () => client)),
    });
    this.steering = {
      captureTarget: (request) => runtime.steering.captureTarget(request.agentSessionId),
      steer: (request) => runtime.steering.steer(request),
    };
    this.catalog = createModelCatalog({
      logger: host.logger,
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
    this.singleQuery = {
      async run(request) {
        request.signal.throwIfAborted();
        try {
          return await runtime.runSingleQuery(request.prompt, {
            projectPath: request.projectPath,
            model: request.model,
            ...singleQueryRuntimeOptions(request),
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
        await runtime.shutdown();
      },
    });
  }
}

type NativeSessionCodec = ReturnType<typeof createPathNativeSessionCodec>;
type SessionReference = Pick<AgentChatReference, 'nativeSession'> & {
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

function createOpenCodeNativeEvidence(
  runtime: OpenCodeRuntime,
  nativeSessions: NativeSessionCodec,
  sessionId: (chat: SessionReference) => string | null,
  logger: AgentHost['logger'],
): AgentNativeEvidenceSource {
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
      const id = sessionId(chat);
      if (!id) return { messages: [] };
      return {
        messages: await runtime.withClientLease((client) => (
          loadOpenCodeChatMessages(id, async () => client, {
            directory: chat.projectPath,
            signal,
            logger,
          })
        )),
      };
    },
    async describeSource({ chat, signal }) {
      signal.throwIfAborted();
      const id = sessionId(chat);
      return id ? { kind: 'provider-reference', value: id } : null;
    },
    async release({ signal }) {
      signal.throwIfAborted();
    },
  };
}
