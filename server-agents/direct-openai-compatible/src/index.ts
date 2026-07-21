import { PERMISSION_MODE_VALUES, THINKING_MODE_VALUES } from '@garcon/common/chat-modes';
import {
  DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
  DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_LABEL,
} from '@garcon/common/agents';
import {
  AgentIntegrationError,
  type AgentHost,
  type AgentIntegration,
} from '@garcon/server-agent-interface';
import { createModelCatalog } from '@garcon/server-agent-common/catalog/model-catalog';
import { resolveAgentStandaloneEntrypoint } from '@garcon/server-agent-common/build/standalone-entrypoint';
import { classifyDirectIntegrationError } from '@garcon/server-agent-common/direct/errors';
import { DirectExecution } from '@garcon/server-agent-common/direct/execution';
import { relocateLegacySessionDirectory } from '@garcon/server-agent-common/direct/legacy-session-relocation';
import { createDirectOpenAiChatRuntime } from '@garcon/server-agent-common/direct/router';
import { createDirectSessionPaths } from '@garcon/server-agent-common/direct/session-paths';
import {
  createDirectTranscript,
} from '@garcon/server-agent-common/direct/transcript';
import { createDirectCompatibleTranscriptSource } from '@garcon/server-agent-common/direct/transcript-source';
import { resolveAgentEndpoint } from '@garcon/server-agent-common/execution/resolve-endpoint';
import { createJsonlForking } from '@garcon/server-agent-common/forking/jsonl-forking';
import { createIntegrationLifecycle } from '@garcon/server-agent-common/lifecycle/integration-lifecycle';
import { createVersion1RecordMigration } from '@garcon/server-agent-common/migration/version-1-record-migration';
import { createPathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import { createVersionedSettings } from '@garcon/server-agent-common/settings/versioned-settings';
import { singleQueryRuntimeOptions } from '@garcon/server-agent-common/shared/single-query-control';

const SESSIONS_LABEL = 'openai-compatible-sessions';

const DESCRIPTOR = {
  id: DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
  label: DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_LABEL,
  icon: null,
  supportedPermissionModes: PERMISSION_MODE_VALUES.filter((mode) => mode !== 'plan'),
  supportedThinkingModes: THINKING_MODE_VALUES,
  supportsImages: true,
  supportsProjectPathUpdate: true,
  requiresNativePathForProjectPathUpdate: false,
  supportedEndpointProtocols: ['openai-compatible'],
  configuration: [],
} as const;

export default class DirectOpenAiCompatibleIntegration implements AgentIntegration {
  static readonly integrationId = DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID;
  static readonly apiVersion = 2 as const;
  static readonly transcriptIndex = {
    apiVersion: 1,
    moduleUrl: resolveAgentStandaloneEntrypoint({
      integrationId: DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
      name: 'transcript-index-source',
      sourceUrl: new URL('./transcript-index-source.ts', import.meta.url),
    }),
  } as const;

  readonly descriptor = DESCRIPTOR;
  readonly execution;
  readonly transcript;
  readonly catalog;
  readonly settings;
  readonly lifecycle;
  readonly migration;
  readonly auth: NonNullable<AgentIntegration['auth']>;
  readonly commands = null;
  readonly forking;
  readonly endpoints: NonNullable<AgentIntegration['endpoints']>;
  readonly singleQuery: NonNullable<AgentIntegration['singleQuery']>;

  constructor(host: AgentHost) {
    const nativeSessions = createPathNativeSessionCodec(
      DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
    );
    const sessionPaths = createDirectSessionPaths(
      host.storage.rootDirectory,
      SESSIONS_LABEL,
    );
    const runtime = createDirectOpenAiChatRuntime({
      runtimeId: DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
      runtimeLabel: DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_LABEL,
      sessionPaths,
      logger: host.logger,
    });
    const reader = createDirectCompatibleTranscriptSource({
      agentId: DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
      sessionLabel: DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_LABEL,
      findSessionFilePath: sessionPaths.findSessionFilePath,
      logger: host.logger,
    });

    this.settings = createVersionedSettings({
      ownerId: DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
      schemaVersion: 1,
      defaults: {},
      descriptors: [],
    });
    this.execution = new DirectExecution(host, runtime, nativeSessions);
    this.transcript = createDirectTranscript({
      ownerId: DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
      reader,
      nativeSessions,
    });
    this.catalog = createModelCatalog({
      logger: host.logger,
      defaultModel: '',
      fallbackModels: [],
      requiresStrictModelDiscovery: false,
      generation: { priority: 50, model: '' },
    });
    this.migration = createVersion1RecordMigration({ settings: this.settings, nativeSessions });
    this.auth = {
      async status(signal) {
        signal.throwIfAborted();
        return { authenticated: false, canReauth: false, label: '', source: 'none' };
      },
    };
    this.forking = createJsonlForking({
      host,
      supportsAtMessageWhileRunning: false,
      transcript: this.transcript,
      nativeSessions,
    });
    this.endpoints = {
      async validate(selection) {
        if (selection.protocol !== 'openai-compatible') {
          throw new AgentIntegrationError(
            'INVALID_ENDPOINT',
            'OpenAI Compatible requires an OpenAI-compatible endpoint',
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
            'OpenAI Compatible requires an API provider endpoint',
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
