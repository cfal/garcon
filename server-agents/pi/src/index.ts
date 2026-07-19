import { PERMISSION_MODE_VALUES, THINKING_MODE_VALUES } from '@garcon/common/chat-modes';
import { PI_MODELS } from '@garcon/common/models';
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
  isArtificialNativePath,
} from '@garcon/server-agent-common/chats/artificial-native-path';
import { createIntegrationLifecycle } from '@garcon/server-agent-common/lifecycle/integration-lifecycle';
import { createScopedAgentLogger } from '@garcon/server-agent-common/logging/scoped-agent-logger';
import { createVersion1RecordMigration } from '@garcon/server-agent-common/migration/version-1-record-migration';
import { createPathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import { createTranscriptSearch } from '@garcon/server-agent-common/search/transcript-search';
import { createVersionedSettings } from '@garcon/server-agent-common/settings/versioned-settings';
import { createPiConfig } from './config.js';
import { PiExecution } from './agents/pi/execution.js';
import { LazyPiRuntime } from './agents/pi/lazy-runtime.js';
import { getPiAuthStatus } from './agents/pi/pi-auth.js';

const PI_DESCRIPTOR = {
  id: 'pi',
  label: 'Pi',
  icon: null,
  supportedPermissionModes: PERMISSION_MODE_VALUES.filter((mode) => mode !== 'plan'),
  supportedThinkingModes: THINKING_MODE_VALUES,
  supportsImages: false,
  supportsProjectPathUpdate: true,
  requiresNativePathForProjectPathUpdate: true,
  supportedEndpointProtocols: [],
  configuration: [
    { key: 'GARCON_PI_BINARY', source: 'environment' as const, description: 'Garcon Pi CLI binary.' },
    { key: 'PI_BINARY', source: 'environment' as const, description: 'Pi CLI binary.' },
    {
      key: 'PI_CODING_AGENT_SESSION_DIR',
      source: 'environment' as const,
      description: 'Pi session directory.',
    },
    { key: 'HOME', source: 'environment' as const, description: 'User home directory.' },
    { key: 'NODE_ENV', source: 'environment' as const, description: 'Runtime environment.' },
  ],
} as const;

export default class PiAgentIntegration implements AgentIntegration {
  static readonly integrationId = 'pi';
  static readonly apiVersion = 1 as const;

  readonly descriptor = PI_DESCRIPTOR;
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
    const config = createPiConfig(host.environment);
    const logger = createScopedAgentLogger(host.logger, 'pi');
    const models = createLazyPiModels(config);
    const nativeSessions = createPathNativeSessionCodec('pi');
    const runtime = new LazyPiRuntime(async () => {
      const { PiCliRuntime } = await import('./agents/pi/pi-cli.js');
      return new PiCliRuntime({ config, logger, models });
    });

    this.settings = createVersionedSettings({
      ownerId: 'pi',
      schemaVersion: 1,
      defaults: {},
      descriptors: [],
    });
    this.execution = new PiExecution(runtime, nativeSessions);
    this.transcript = createPiTranscript(config, nativeSessions);
    const search = createTranscriptSearch({
      host,
      agentId: 'pi',
      loadTranscript: async ({ chat, signal }) => {
        signal.throwIfAborted();
        return loadPiMessages(piReference(chat, nativeSessions), config);
      },
    });
    this.transcriptSearch = search;
    this.catalog = createModelCatalog({
      defaultModel: PI_MODELS.DEFAULT,
      fallbackModels: PI_MODELS.OPTIONS,
      requiresStrictModelDiscovery: true,
      generation: null,
      discover: ({ strict }) => strict ? models.getModelsStrict() : models.getModels(),
    });
    this.migration = createVersion1RecordMigration({ settings: this.settings, nativeSessions });
    this.auth = {
      async status(signal) {
        signal.throwIfAborted();
        const status = await getPiAuthStatus(models);
        return {
          ...status,
          source: status.authenticated ? 'cli' : 'none',
        };
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
            'Pi does not support message-point forks',
            false,
          );
        }
        const { forkPiSession } = await import('./agents/pi/pi-fork.js');
        const forked = await forkPiSession(
          piReference(request.source, nativeSessions),
          config,
        );
        return {
          agentSessionId: forked.agentSessionId,
          nativeSession: nativeSessions.encode({
            path: forked.nativePath,
            agentSessionId: forked.agentSessionId,
            modelEndpointId: null,
          }),
        };
      },
    };
    this.singleQuery = {
      async run(request) {
        request.signal.throwIfAborted();
        try {
          const { runSingleQuery } = await import('./agents/pi/pi-cli.js');
          return await runSingleQuery(request.prompt, {
            projectPath: request.projectPath,
            model: request.model,
            ...request.settings.values,
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
        await search.close();
      },
    });
  }
}

type PiConfig = ReturnType<typeof createPiConfig>;
type NativeSessionCodec = ReturnType<typeof createPathNativeSessionCodec>;
type ChatReference = Parameters<AgentTranscript['load']>[0]['chat'];
type PiReferenceInput = Pick<ChatReference, 'projectPath' | 'nativeSession'> & {
  readonly agentSessionId?: string | null;
};

function piReference(chat: PiReferenceInput, nativeSessions: NativeSessionCodec) {
  const native = nativeSessions.decode(chat.nativeSession);
  return {
    projectPath: chat.projectPath,
    nativePath: native.path,
    agentSessionId: chat.agentSessionId
      ?? native.agentSessionId
      ?? getArtificialAgentSessionId(native.path, 'pi'),
  };
}

function hasRealPiPath(reference: { readonly nativePath?: string | null }): boolean {
  return Boolean(reference.nativePath) && !isArtificialNativePath(reference.nativePath);
}

async function loadPiMessages(
  reference: ReturnType<typeof piReference>,
  config: PiConfig,
) {
  const history = await import('./agents/pi/history-loader.js');
  if (hasRealPiPath(reference)) return history.loadPiChatMessages(reference.nativePath!);
  if (!reference.agentSessionId) return [];
  return history.loadPiChatMessagesBySessionId(
    reference.agentSessionId,
    reference.projectPath,
    config,
  );
}

function createPiTranscript(
  config: PiConfig,
  nativeSessions: NativeSessionCodec,
): AgentTranscript {
  const loadMessages = (chat: ChatReference) => loadPiMessages(
    piReference(chat, nativeSessions),
    config,
  );
  return {
    async resolveNativeSession({ chat, signal }) {
      signal.throwIfAborted();
      const reference = piReference(chat, nativeSessions);
      if (hasRealPiPath(reference)) {
        return nativeSessions.encode({
          path: reference.nativePath ?? null,
          agentSessionId: reference.agentSessionId ?? null,
          modelEndpointId: null,
        });
      }
      if (!reference.agentSessionId) return null;
      const { findPiSessionFileBySessionId } = await import('./agents/pi/pi-session-paths.js');
      const path = await findPiSessionFileBySessionId(
        reference.agentSessionId,
        reference.projectPath,
        config,
      ) ?? createArtificialNativePath('pi', reference.agentSessionId);
      return nativeSessions.encode({
        path,
        agentSessionId: reference.agentSessionId,
        modelEndpointId: null,
      });
    },
    async load({ chat, signal }) {
      signal.throwIfAborted();
      const messages = await loadMessages(chat);
      return { messages, revision: computeAgentTranscriptRevision(messages) };
    },
    async preview({ chat, signal }) {
      signal.throwIfAborted();
      const reference = piReference(chat, nativeSessions);
      const history = await import('./agents/pi/history-loader.js');
      if (hasRealPiPath(reference)) {
        return history.getPiPreviewFromSessionPath(reference.nativePath!);
      }
      if (!reference.agentSessionId) return null;
      return history.getPiPreviewFromSessionId(
        reference.agentSessionId,
        reference.projectPath,
        config,
      );
    },
    async revision({ chat, signal }) {
      signal.throwIfAborted();
      return computeAgentTranscriptRevision(await loadMessages(chat));
    },
    async release({ signal }) {
      signal.throwIfAborted();
    },
  };
}

function createLazyPiModels(config: PiConfig) {
  let service: Promise<import('./agents/pi/pi-models.js').PiModelCatalogService> | null = null;
  const getService = () => {
    service ??= import('./agents/pi/pi-models.js').then(
      ({ PiModelCatalogService }) => new PiModelCatalogService(config),
    );
    return service;
  };
  return {
    async getModels() {
      return (await getService()).getModels();
    },
    async getModelsStrict() {
      return (await getService()).getModelsStrict();
    },
  };
}
