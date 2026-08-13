import { PERMISSION_MODE_VALUES, THINKING_MODE_VALUES } from '@garcon/common/chat-modes';
import { AMP_MODELS } from '@garcon/common/models';
import {
  AgentIntegrationError,
  type AgentChatReference,
  type AgentIntegration,
  type AgentHost,
} from '@garcon/server-agent-interface';
import type { AgentNativeEvidenceSource } from '@garcon/server-agent-common/native-session/evidence-source';
import { createModelCatalog } from '@garcon/server-agent-common/catalog/model-catalog';
import { getArtificialAgentSessionId } from '@garcon/server-agent-common/chats/artificial-native-path';
import { createIntegrationLifecycle } from '@garcon/server-agent-common/lifecycle/integration-lifecycle';
import { createScopedAgentLogger } from '@garcon/server-agent-common/logging/scoped-agent-logger';
import { createVersion1RecordMigration } from '@garcon/server-agent-common/migration/version-1-record-migration';
import { createPathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import { createVersionedSettings } from '@garcon/server-agent-common/settings/versioned-settings';
import { singleQueryRuntimeOptions } from '@garcon/server-agent-common/shared/single-query-control';
import { createAgentProducerAdapter } from '@garcon/server-agent-common/execution/producer-adapter';
import { createNativeHistoryImport } from '@garcon/server-agent-common/native-session/native-history-import';
import { createAmpConfig } from './config.js';
import { getAmpAuthStatus } from './agents/amp/amp-auth.js';
import { AmpCliRuntime, runSingleQuery } from './agents/amp/amp-cli.js';
import { AmpExecution } from './agents/amp/execution.js';
import { loadAmpChatMessages } from './agents/amp/history-loader.js';

const AMP_DESCRIPTOR = {
  id: 'amp',
  label: 'Amp',
  icon: null,
  supportedPermissionModes: PERMISSION_MODE_VALUES.filter((mode) => mode !== 'plan'),
  supportedThinkingModes: THINKING_MODE_VALUES,
  supportsImages: false,
  supportsProjectPathUpdate: false,
  requiresNativePathForProjectPathUpdate: false,
  supportedEndpointProtocols: [],
  configuration: [{ key: 'AMP_BINARY', source: 'environment' as const, description: 'Amp CLI binary.' }],
} as const;

export default class AmpAgentIntegration implements AgentIntegration {
  static readonly integrationId = 'amp';
  static readonly apiVersion = 5 as const;
  readonly descriptor = AMP_DESCRIPTOR;
  readonly attachments = null;
  readonly execution;
  readonly nativeHistoryImport;
  readonly nativeActivity = null;
  readonly nativeSessions;
  readonly sessionConfiguration = null;
  readonly permissionDecisions = null;
  readonly projectPathUpdates = null;
  readonly catalog;
  readonly settings;
  readonly lifecycle;
  readonly migration;
  readonly auth: NonNullable<AgentIntegration['auth']>;
  readonly commands = null;
  readonly compaction = null;
  readonly forking = null;
  readonly steering = null;
  readonly goals = null;
  readonly endpoints = null;
  readonly singleQuery: NonNullable<AgentIntegration['singleQuery']>;

  constructor(host: AgentHost) {
    const config = createAmpConfig(host.environment);
    const logger = createScopedAgentLogger(host.logger, 'amp');
    const nativeSessions = createPathNativeSessionCodec('amp');
    const runtime = new AmpCliRuntime({ config, logger });

    this.settings = createVersionedSettings({
      ownerId: 'amp',
      schemaVersion: 1,
      defaults: { ampAgentMode: 'smart' },
      descriptors: [{
        key: 'ampAgentMode',
        type: 'enum',
        label: 'Mode',
        labelKey: 'mode',
        options: [
          { value: 'smart', label: 'Smart', labelKey: 'smart' },
          { value: 'deep', label: 'Deep', labelKey: 'deep' },
        ],
      }],
    });
    const providerExecution = new AmpExecution(runtime, nativeSessions);
    const nativeEvidence = createAmpNativeEvidence(runtime, nativeSessions);
    this.nativeSessions = nativeEvidence;
    this.execution = createAgentProducerAdapter(providerExecution).execution;
    this.nativeHistoryImport = createNativeHistoryImport(nativeEvidence);
    this.catalog = createModelCatalog({
      logger: host.logger,
      defaultModel: AMP_MODELS.DEFAULT,
      fallbackModels: AMP_MODELS.OPTIONS,
      requiresStrictModelDiscovery: false,
      generation: { priority: 70, model: AMP_MODELS.DEFAULT },
    });
    this.migration = createVersion1RecordMigration({ settings: this.settings, nativeSessions });
    this.auth = {
      async status(signal) {
        signal.throwIfAborted();
        const status = await getAmpAuthStatus(config);
        return {
          authenticated: status.authenticated,
          canReauth: false,
          label: status.label || 'Amp',
          source: status.authenticated ? 'cli' : 'none',
        };
      },
    };
    this.singleQuery = {
      // `runSingleQuery` spawns with `--dangerously-allow-all -x` in the chat
      // project, so a prompt reaching it can act on the workspace.
      runsToolsWithoutPermission: true,
      async run(request) {
        request.signal.throwIfAborted();
        try {
          return await runSingleQuery(request.prompt, {
            cwd: request.projectPath,
            model: request.model,
            ...singleQueryRuntimeOptions(request),
          }, config, logger);
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

function createAmpNativeEvidence(
  runtime: AmpCliRuntime,
  nativeSessions: ReturnType<typeof createPathNativeSessionCodec>,
): AgentNativeEvidenceSource {
  const threadId = (chat: AgentChatReference) => {
    const native = nativeSessions.decode(chat.nativeSession);
    return chat.agentSessionId
      ?? native.agentSessionId
      ?? getArtificialAgentSessionId(native.path, 'amp');
  };
  return {
    async resolveNativeSession({ chat, signal }) {
      signal.throwIfAborted();
      const id = threadId(chat);
      return id ? nativeSessions.encode({
        path: `!amp:${id}`,
        agentSessionId: id,
        modelEndpointId: null,
      }) : null;
    },
    async load({ chat, signal }) {
      signal.throwIfAborted();
      const id = threadId(chat);
      if (!id) return { messages: [] };
      return {
        messages: loadAmpChatMessages(await runtime.exportThread(id, { cwd: chat.projectPath })),
      };
    },
    async describeSource({ chat, signal }) {
      signal.throwIfAborted();
      const id = threadId(chat);
      return id ? { kind: 'provider-reference', value: id } : null;
    },
    async release({ signal }) {
      signal.throwIfAborted();
    },
  };
}
