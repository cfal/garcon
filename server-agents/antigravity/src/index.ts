import { homedir } from 'node:os';
import { join } from 'node:path';
import { PERMISSION_MODE_VALUES } from '@garcon/common/chat-modes';
import type { AgentAuthStatus } from '@garcon/common/agent-execution';
import {
  AgentIntegrationError,
  type AgentChatReference,
  type AgentHost,
  type AgentIntegration,
  type AgentNativeSessionAccess,
} from '@garcon/server-agent-interface';
import { AcpAgentRuntime } from '@garcon/server-agent-common/acp/agent-runtime';
import { AcpExecution } from '@garcon/server-agent-common/acp/execution';
import { CliLoginController } from '@garcon/server-agent-common/auth/cli-login-controller';
import { getArtificialAgentSessionId } from '@garcon/server-agent-common/chats/artificial-native-path';
import { createModelCatalog } from '@garcon/server-agent-common/catalog/model-catalog';
import { createAgentProducerAdapter } from '@garcon/server-agent-common/execution/producer-adapter';
import { createAgentProjectPathUpdates } from '@garcon/server-agent-common/execution/project-path-adapter';
import { createIntegrationLifecycle } from '@garcon/server-agent-common/lifecycle/integration-lifecycle';
import { createScopedAgentLogger } from '@garcon/server-agent-common/logging/scoped-agent-logger';
import { createVersion1RecordMigration } from '@garcon/server-agent-common/migration/version-1-record-migration';
import { createPathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import { createVersionedSettings } from '@garcon/server-agent-common/settings/versioned-settings';
import {
  singleQueryRuntimeOptions,
  runIsolatedSingleQuery,
} from '@garcon/server-agent-common/shared/single-query-control';
import { createAntigravityConfig } from './config.js';
import { AntigravityAcpEventConverter } from './agents/antigravity/antigravity-acp-event-converter.js';
import {
  ANTIGRAVITY_AGENT_ID,
  createAntigravityAcpPolicy,
  createAntigravityNativePath,
} from './agents/antigravity/antigravity-acp-policy.js';
import {
  antigravityLoginCommand,
  antigravityLoginEnvironment,
  getAntigravityAuthStatus,
  validateAntigravityLoginCode,
} from './agents/antigravity/antigravity-auth.js';
import { getAntigravityModels } from './agents/antigravity/antigravity-models.js';
import { runAntigravitySingleQuery } from './agents/antigravity/run-single-query.js';

const ANTIGRAVITY_DESCRIPTOR = {
  id: ANTIGRAVITY_AGENT_ID,
  label: 'Antigravity',
  icon: null,
  supportedPermissionModes: PERMISSION_MODE_VALUES,
  // Thinking levels are part of each model ID reported by `agy models`.
  supportedThinkingModes: [],
  supportsImages: true,
  supportsProjectPathUpdate: true,
  requiresNativePathForProjectPathUpdate: false,
  supportedEndpointProtocols: [],
  configuration: [
    {
      key: 'GARCON_ANTIGRAVITY_BINARY',
      source: 'environment' as const,
      description: 'Antigravity CLI (agy) binary.',
    },
    {
      key: 'GARCON_ANTIGRAVITY_AUTH_METHOD',
      source: 'environment' as const,
      description: 'Antigravity ACP auth method: oauth-personal, oauth-business, gemini-api-key, or agent-platform.',
    },
    {
      key: 'GEMINI_API_KEY',
      source: 'environment' as const,
      description: 'Gemini API key; selects the gemini-api-key auth method unless one is configured.',
    },
  ],
} as const;

export default class AntigravityAgentIntegration implements AgentIntegration {
  static readonly integrationId = ANTIGRAVITY_AGENT_ID;
  static readonly apiVersion = 5 as const;
  readonly descriptor = ANTIGRAVITY_DESCRIPTOR;
  readonly configurationValidation = null;
  readonly literalExecution = null;
  readonly readiness = null;
  readonly attachments = null;
  readonly execution;
  readonly producers;
  readonly permissions;
  readonly legacyHistoryImport = null;
  readonly nativeHistoryImport = null;
  readonly nativeActivity = null;
  readonly nativeSessions: AgentNativeSessionAccess;
  readonly sessionConfiguration: NonNullable<AgentIntegration['sessionConfiguration']>;
  readonly projectPathUpdates: NonNullable<AgentIntegration['projectPathUpdates']>;
  readonly usageHistory = null;
  readonly catalog;
  readonly settings;
  readonly lifecycle;
  readonly migration;
  readonly auth: NonNullable<AgentIntegration['auth']>;
  readonly commands = null;
  readonly compaction = null;
  readonly forking = null;
  readonly steering = null;
  readonly endpoints = null;
  readonly singleQuery: NonNullable<AgentIntegration['singleQuery']>;

  constructor(host: AgentHost) {
    const config = createAntigravityConfig(host.environment);
    const logger = createScopedAgentLogger(host.logger, ANTIGRAVITY_AGENT_ID);
    const nativeSessions = createPathNativeSessionCodec(ANTIGRAVITY_AGENT_ID);
    const runtime = new AcpAgentRuntime(createAntigravityAcpPolicy(config), {
      converter: new AntigravityAcpEventConverter(),
      logger,
    });
    const login = new CliLoginController({
      command: () => antigravityLoginCommand(config),
      mode: 'browser-code',
      logger,
      environment: () => antigravityLoginEnvironment(config),
      validateCode: validateAntigravityLoginCode,
    });

    this.settings = createVersionedSettings({
      ownerId: ANTIGRAVITY_AGENT_ID,
      schemaVersion: 1,
      defaults: {},
      descriptors: [],
    });
    const providerExecution = new AcpExecution(runtime, nativeSessions);
    this.sessionConfiguration = {
      apply: (agentSessionId, configuration) => (
        providerExecution.applySessionConfiguration(agentSessionId, configuration)
      ),
    };
    this.projectPathUpdates = createAgentProjectPathUpdates(host.scope,
      (request) => providerExecution.prepareProjectPathUpdate(request));
    const producer = createAgentProducerAdapter(providerExecution, host);
    this.execution = producer.execution;
    this.producers = producer.producers;
    this.permissions = producer.permissions;
    this.nativeSessions = createAntigravityNativeSessions(nativeSessions, runtime);
    this.catalog = createModelCatalog({
      logger: host.logger,
      defaultModel: '',
      fallbackModels: [],
      requiresStrictModelDiscovery: false,
      // Each one-shot query opens a session that agy keeps in the user's
      // conversation history, so Antigravity is not a default generation agent.
      generation: null,
      discover: () => getAntigravityModels(config, logger),
    });
    this.migration = createVersion1RecordMigration({ settings: this.settings, nativeSessions });
    let lastProbed: AgentAuthStatus | null = null;
    this.auth = {
      async status(signal) {
        const signInRunning = login.status().state === 'running';
        const status = await getAntigravityAuthStatus(config, { signal, signInRunning, lastProbed });
        if (!signInRunning) lastProbed = status;
        return status;
      },
      launchLogin: () => login.launch(),
      completeLogin: (sessionId, code) => login.complete(sessionId, code),
      loginStatus: async (expectedSessionId) => login.status(expectedSessionId),
    };
    this.singleQuery = {
      run: (request) => runIsolatedSingleQuery(request, (directory) => runAntigravitySingleQuery(
        request.prompt,
        { ...singleQueryRuntimeOptions(request), model: request.model, projectPath: directory },
        config,
      )),
    };
    this.lifecycle = createIntegrationLifecycle({
      start: () => runtime.startPurgeTimer(),
      stop: async () => {
        login.stop();
        runtime.shutdown();
      },
    });
  }
}

type NativeSessionCodec = ReturnType<typeof createPathNativeSessionCodec>;

function antigravitySessionId(
  chat: Pick<AgentChatReference, 'nativeSession'> & { readonly agentSessionId?: string | null },
  nativeSessions: NativeSessionCodec,
): string | null {
  const native = nativeSessions.decode(chat.nativeSession);
  return chat.agentSessionId
    ?? native.agentSessionId
    ?? getArtificialAgentSessionId(native.path, ANTIGRAVITY_AGENT_ID);
}

// `agy acp` keeps conversations under its default app-data directory.
function antigravityConversationPath(agentSessionId: string): string {
  return join(homedir(), '.gemini', 'antigravity-cli', 'conversations', `${agentSessionId}.db`);
}

function createAntigravityNativeSessions(
  nativeSessions: NativeSessionCodec,
  runtime: AcpAgentRuntime,
): AgentNativeSessionAccess {
  return {
    async resolveNativeSession({ chat, signal }) {
      signal.throwIfAborted();
      const id = antigravitySessionId(chat, nativeSessions);
      if (!id) return null;
      return nativeSessions.encode({
        path: createAntigravityNativePath(id),
        agentSessionId: id,
        modelEndpointId: null,
      });
    },
    async describeSource({ chat, signal }) {
      signal.throwIfAborted();
      const id = antigravitySessionId(chat, nativeSessions);
      return id ? { kind: 'filesystem-path', value: antigravityConversationPath(id) } : null;
    },
    async release({ chat, signal }) {
      signal.throwIfAborted();
      runtime.releaseSession(chat.chatId, antigravitySessionId(chat, nativeSessions));
    },
  };
}
