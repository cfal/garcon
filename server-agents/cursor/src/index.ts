import { PERMISSION_MODE_VALUES, THINKING_MODE_VALUES } from '@garcon/common/chat-modes';
import { retargetNativeSeedReceipt } from '@garcon/common/transcript-seed';
import {
  AgentIntegrationError,
  type AgentChatReference,
  type AgentHost,
  type AgentIntegrationV4,
} from '@garcon/server-agent-interface';
import type { AgentNativeEvidenceSource } from '@garcon/server-agent-common/native-session/evidence-source';
import { createModelCatalog } from '@garcon/server-agent-common/catalog/model-catalog';
import { createIntegrationLifecycle } from '@garcon/server-agent-common/lifecycle/integration-lifecycle';
import { createScopedAgentLogger } from '@garcon/server-agent-common/logging/scoped-agent-logger';
import { createVersion1RecordMigration } from '@garcon/server-agent-common/migration/version-1-record-migration';
import { createPathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import { createVersionedSettings } from '@garcon/server-agent-common/settings/versioned-settings';
import { singleQueryRuntimeOptions } from '@garcon/server-agent-common/shared/single-query-control';
import { createAgentOwnedProjection } from '@garcon/server-agent-common/transcript-projection/owned-projection';
import { createAgentProducerAdapter } from '@garcon/server-agent-common/execution/producer-adapter';
import { createNativeHistoryImport } from '@garcon/server-agent-common/native-session/native-history-import';
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

export default class CursorAgentIntegration implements AgentIntegrationV4 {
  static readonly integrationId = 'cursor';
  static readonly apiVersion = 4 as const;
  readonly descriptor = CURSOR_DESCRIPTOR;
  readonly attachments = null;
  readonly execution;
  readonly producerExecution;
  readonly transcript;
  readonly nativeHistoryImport;
  readonly nativeActivity = null;
  readonly nativeSessions;
  readonly sessionConfiguration: NonNullable<AgentIntegrationV4['sessionConfiguration']>;
  readonly permissionDecisions: NonNullable<AgentIntegrationV4['permissionDecisions']>;
  readonly projectPathUpdates: NonNullable<AgentIntegrationV4['projectPathUpdates']>;
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
    const providerExecution = new CursorExecution(runtime, nativeSessions);
    this.sessionConfiguration = {
      apply: (agentSessionId, configuration) => (
        providerExecution.applySessionConfiguration(agentSessionId, configuration)
      ),
    };
    this.permissionDecisions = {
      respond: (permissionRequestId, decision) => (
        providerExecution.respondToPermission(permissionRequestId, decision)
      ),
    };
    this.projectPathUpdates = {
      prepare: (request) => providerExecution.prepareProjectPathUpdate(request),
    };
    const nativeEvidence = createCursorNativeEvidence(transcriptReader, nativeSessions);
    this.nativeSessions = nativeEvidence;
    this.producerExecution = createAgentProducerAdapter(providerExecution).execution;
    this.nativeHistoryImport = createNativeHistoryImport(nativeEvidence);
    const projection = createAgentOwnedProjection({
      ownerId: 'cursor',
      host,
      execution: providerExecution,
      nativeEvidence,
    });
    this.execution = projection.execution;
    this.transcript = projection.transcript;
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
    this.singleQuery = {
      async run(request) {
        request.signal.throwIfAborted();
        try {
          return await runSingleQuery(request.prompt, {
            projectPath: request.projectPath,
            model: request.model,
            ...singleQueryRuntimeOptions(request),
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
type CursorReferenceInput = Pick<AgentChatReference, 'projectPath' | 'nativeSession'> & {
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

function createCursorNativeEvidence(
  reader: ReturnType<typeof createCursorTranscriptSource>,
  nativeSessions: NativeSessionCodec,
): AgentNativeEvidenceSource {
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
      return {
        messages: await reader.loadMessages(
          cursorReference(chat, nativeSessions),
          { chatId: chat.chatId },
        ),
      };
    },
    async describeSource({ chat, signal }) {
      signal.throwIfAborted();
      const reference = cursorReference(chat, nativeSessions);
      if (!reference.agentSessionId) return null;
      return {
        kind: 'filesystem-path',
        value: cursorStoreDbPath(reference.agentSessionId, reference.projectPath),
      };
    },
    async release({ signal }) {
      signal.throwIfAborted();
    },
  };
}
