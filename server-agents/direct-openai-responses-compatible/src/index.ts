import { PERMISSION_MODE_VALUES, THINKING_MODE_VALUES } from '@garcon/common/chat-modes';
import { TEXT_FILE_ATTACHMENT_MIME_TYPES } from '@garcon/common/attachments';
import {
  DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
  DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_LABEL,
} from '@garcon/common/agents';
import {
  AgentIntegrationError,
  type AgentHost,
  type AgentIntegration,
} from '@garcon/server-agent-interface';
import { createModelCatalog } from '@garcon/server-agent-common/catalog/model-catalog';
import { classifyDirectIntegrationError } from '@garcon/server-agent-common/direct/errors';
import { DirectExecution } from '@garcon/server-agent-common/direct/execution';
import {
  createDirectNativeHistoryImport,
  createDirectNativeSessionAccess,
} from '@garcon/server-agent-common/direct/native-session';
import { createDirectOpenAiResponsesRuntime } from '@garcon/server-agent-common/direct/router';
import { DirectSessionStore } from '@garcon/server-agent-common/direct/session-store';
import { resolveAgentEndpoint } from '@garcon/server-agent-common/execution/resolve-endpoint';
import { createIntegrationLifecycle } from '@garcon/server-agent-common/lifecycle/integration-lifecycle';
import { createVersion1RecordMigration } from '@garcon/server-agent-common/migration/version-1-record-migration';
import { createVersionedSettings } from '@garcon/server-agent-common/settings/versioned-settings';
import { singleQueryRuntimeOptions } from '@garcon/server-agent-common/shared/single-query-control';
import { createAgentProducerAdapter } from '@garcon/server-agent-common/execution/producer-adapter';

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

export default class DirectOpenAiResponsesCompatibleIntegration implements AgentIntegration {
  static readonly integrationId = DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID;
  static readonly apiVersion = 5 as const;
  readonly descriptor = DESCRIPTOR;
  readonly attachments = {
    fileMimeTypes: TEXT_FILE_ATTACHMENT_MIME_TYPES,
  } as const;
  readonly execution;
  readonly legacyHistoryImport = null;
  readonly nativeHistoryImport;
  readonly nativeActivity = null;
  readonly nativeSessions;
  readonly sessionConfiguration = null;
  readonly projectPathUpdates: NonNullable<AgentIntegration['projectPathUpdates']>;
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
  readonly endpoints: NonNullable<AgentIntegration['endpoints']>;
  readonly singleQuery: NonNullable<AgentIntegration['singleQuery']>;

  constructor(host: AgentHost) {
    const sessions = new DirectSessionStore({ host });
    const runtime = createDirectOpenAiResponsesRuntime({
      runtimeLabel: DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_LABEL,
      sessions,
    });
    this.nativeHistoryImport = createDirectNativeHistoryImport(sessions);
    this.nativeSessions = createDirectNativeSessionAccess(sessions);

    this.settings = createVersionedSettings({
      ownerId: DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
      schemaVersion: 1,
      defaults: {},
      descriptors: [],
    });
    const providerExecution = new DirectExecution(host, runtime);
    this.projectPathUpdates = {
      prepare: (request) => providerExecution.prepareProjectPathUpdate(request),
    };
    this.execution = createAgentProducerAdapter(providerExecution, host.logger).execution;
    this.catalog = createModelCatalog({
      logger: host.logger,
      defaultModel: '',
      fallbackModels: [],
      requiresStrictModelDiscovery: false,
      generation: { priority: 40, model: '' },
    });
    this.migration = createVersion1RecordMigration({ settings: this.settings, nativeSessions: null });
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
      start: () => runtime.startPurgeTimer(),
      stop: async () => {
        runtime.shutdown();
      },
    });
  }
}
