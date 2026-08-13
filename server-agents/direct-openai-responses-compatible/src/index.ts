import { PERMISSION_MODE_VALUES, THINKING_MODE_VALUES } from '@garcon/common/chat-modes';
import { TEXT_FILE_ATTACHMENT_MIME_TYPES } from '@garcon/common/attachments';
import {
  DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
  DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_LABEL,
} from '@garcon/common/agents';
import {
  AgentIntegrationError,
  type AgentHost,
  type AgentIntegrationV4,
} from '@garcon/server-agent-interface';
import { createModelCatalog } from '@garcon/server-agent-common/catalog/model-catalog';
import { classifyDirectIntegrationError } from '@garcon/server-agent-common/direct/errors';
import { DirectExecution } from '@garcon/server-agent-common/direct/execution';
import { relocateLegacySessionDirectory } from '@garcon/server-agent-common/direct/legacy-session-relocation';
import { createDirectOpenAiResponsesRuntime } from '@garcon/server-agent-common/direct/router';
import { createDirectSessionPaths } from '@garcon/server-agent-common/direct/session-paths';
import { createDirectNativeEvidence } from '@garcon/server-agent-common/direct/transcript';
import { createDirectCompatibleTranscriptSource } from '@garcon/server-agent-common/direct/transcript-source';
import { resolveAgentEndpoint } from '@garcon/server-agent-common/execution/resolve-endpoint';
import { createIntegrationLifecycle } from '@garcon/server-agent-common/lifecycle/integration-lifecycle';
import { createVersion1RecordMigration } from '@garcon/server-agent-common/migration/version-1-record-migration';
import { createPathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import { createVersionedSettings } from '@garcon/server-agent-common/settings/versioned-settings';
import { singleQueryRuntimeOptions } from '@garcon/server-agent-common/shared/single-query-control';
import { createAgentOwnedProjection } from '@garcon/server-agent-common/transcript-projection/owned-projection';
import { createAgentProducerAdapter } from '@garcon/server-agent-common/execution/producer-adapter';

const SESSIONS_LABEL = 'openai-compatible-responses-sessions';

const DESCRIPTOR = {
  id: DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
  label: DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_LABEL,
  icon: null,
  supportedPermissionModes: PERMISSION_MODE_VALUES.filter((mode) => mode !== 'plan'),
  supportedThinkingModes: THINKING_MODE_VALUES,
  supportsImages: true,
  supportsProjectPathUpdate: true,
  requiresNativePathForProjectPathUpdate: false,
  supportedEndpointProtocols: ['openai-compatible'],
  configuration: [],
} as const;

export default class DirectOpenAiResponsesCompatibleIntegration implements AgentIntegrationV4 {
  static readonly integrationId = DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID;
  static readonly apiVersion = 4 as const;
  readonly descriptor = DESCRIPTOR;
  readonly attachments = {
    fileMimeTypes: TEXT_FILE_ATTACHMENT_MIME_TYPES,
  } as const;
  readonly execution;
  readonly producerExecution;
  readonly transcript;
  readonly nativeHistoryImport = null;
  readonly nativeActivity = null;
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
  readonly endpoints: NonNullable<AgentIntegrationV4['endpoints']>;
  readonly singleQuery: NonNullable<AgentIntegrationV4['singleQuery']>;
  readonly transientControls = null;

  constructor(host: AgentHost) {
    const nativeSessions = createPathNativeSessionCodec(
      DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
    );
    const sessionPaths = createDirectSessionPaths(
      host.storage.rootDirectory,
      SESSIONS_LABEL,
    );
    const runtime = createDirectOpenAiResponsesRuntime({
      runtimeId: DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
      runtimeLabel: DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_LABEL,
      sessionPaths,
      logger: host.logger,
    });
    const reader = createDirectCompatibleTranscriptSource({
      agentId: DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
      sessionLabel: DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_LABEL,
      findSessionFilePath: sessionPaths.findSessionFilePath,
      logger: host.logger,
    });

    this.settings = createVersionedSettings({
      ownerId: DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
      schemaVersion: 1,
      defaults: {},
      descriptors: [],
    });
    const providerExecution = new DirectExecution(host, runtime);
    this.producerExecution = createAgentProducerAdapter(providerExecution).execution;
    const nativeEvidence = createDirectNativeEvidence({
      reader,
      nativeSessions,
    });
    const projection = createAgentOwnedProjection({
      ownerId: DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
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
      generation: { priority: 40, model: '' },
    });
    this.migration = createVersion1RecordMigration({ settings: this.settings, nativeSessions });
    this.auth = {
      async status(signal) {
        signal.throwIfAborted();
        return { authenticated: false, canReauth: false, label: '', source: 'none' };
      },
    };
    this.endpoints = {
      async validate(selection) {
        if (selection.protocol !== 'openai-compatible') {
          throw new AgentIntegrationError(
            'INVALID_ENDPOINT',
            'OpenAI Responses Compatible requires an OpenAI-compatible endpoint',
            false,
          );
        }
      },
    };
    this.singleQuery = {
      async run(request) {
        const endpoint = await resolveAgentEndpoint(host, request.endpoint, request.signal);
        if (!endpoint) {
          throw new AgentIntegrationError(
            'INVALID_ENDPOINT',
            'OpenAI Responses Compatible requires an API provider endpoint',
            false,
          );
        }
        try {
          return await runtime.runSingleQuery(request.prompt, endpoint, {
            projectPath: request.projectPath,
            model: request.model,
            ...singleQueryRuntimeOptions(request),
          });
        } catch (error) {
          throw classifyDirectIntegrationError(error);
        }
      },
    };
    this.lifecycle = createIntegrationLifecycle({
      migrateOwnedStorage: (store) => relocateLegacySessionDirectory(host, store, SESSIONS_LABEL),
      start: () => runtime.startPurgeTimer(),
      stop: async () => {
        runtime.shutdown();
      },
    });
  }
}
