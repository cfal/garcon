import { PERMISSION_MODE_VALUES, THINKING_MODE_VALUES } from '@garcon/common/chat-modes';
import { PI_MODELS } from '@garcon/common/models';
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
  isArtificialNativePath,
} from '@garcon/server-agent-common/chats/artificial-native-path';
import { createIntegrationLifecycle } from '@garcon/server-agent-common/lifecycle/integration-lifecycle';
import { createScopedAgentLogger } from '@garcon/server-agent-common/logging/scoped-agent-logger';
import { createVersion1RecordMigration } from '@garcon/server-agent-common/migration/version-1-record-migration';
import { createPathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import { createVersionedSettings } from '@garcon/server-agent-common/settings/versioned-settings';
import { singleQueryRuntimeOptions } from '@garcon/server-agent-common/shared/single-query-control';
import { createAgentProducerAdapter } from '@garcon/server-agent-common/execution/producer-adapter';
import { createNativeHistoryImport } from '@garcon/server-agent-common/native-session/native-history-import';
import { createPiNativeActivityProbe } from './agents/pi/native-activity.js';
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
  static readonly apiVersion = 5 as const;
  readonly descriptor = PI_DESCRIPTOR;
  readonly attachments = null;
  readonly execution;
  readonly nativeHistoryImport;
  readonly nativeActivity;
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
  readonly steering: NonNullable<AgentIntegration['steering']>;
  readonly goals = null;
  readonly endpoints = null;
  readonly singleQuery: NonNullable<AgentIntegration['singleQuery']>;

  constructor(host: AgentHost) {
    const config = createPiConfig(host.environment);
    const logger = createScopedAgentLogger(host.logger, 'pi');
    const models = createLazyPiModels(config);
    const nativeSessions = createPathNativeSessionCodec('pi');
    const runtime = new LazyPiRuntime(async () => {
      const { PiRpcRuntime } = await import('./agents/pi/pi-rpc-runtime.js');
      return new PiRpcRuntime({ config, logger, models });
    });

    this.settings = createVersionedSettings({
      ownerId: 'pi',
      schemaVersion: 1,
      defaults: {},
      descriptors: [],
    });
    const providerExecution = new PiExecution(runtime, nativeSessions);
    this.projectPathUpdates = {
      prepare: (request) => providerExecution.prepareProjectPathUpdate(request),
    };
    const nativeEvidence = createPiNativeEvidence(config, nativeSessions);
    this.nativeSessions = nativeEvidence;
    this.execution = createAgentProducerAdapter(providerExecution, logger).execution;
    this.nativeHistoryImport = createNativeHistoryImport(nativeEvidence);
    this.nativeActivity = createPiNativeActivityProbe(nativeSessions);
    this.catalog = createModelCatalog({
      logger: host.logger,
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
    this.singleQuery = {
      async run(request) {
        request.signal.throwIfAborted();
        try {
          const { runSingleQuery } = await import('./agents/pi/pi-cli.js');
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
    this.steering = {
      captureTarget: (request) => runtime.captureSteerTarget(request.agentSessionId),
      steer: (request) => runtime.steer(request),
    };
    this.lifecycle = createIntegrationLifecycle({
      start: () => runtime.startPurgeTimer(),
      stop: async () => {
        await runtime.shutdown();
      },
    });
  }
}

type PiConfig = ReturnType<typeof createPiConfig>;
type NativeSessionCodec = ReturnType<typeof createPathNativeSessionCodec>;
type PiReferenceInput = Pick<AgentChatReference, 'projectPath' | 'nativeSession'> & {
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

function createPiNativeEvidence(
  config: PiConfig,
  nativeSessions: NativeSessionCodec,
): AgentNativeEvidenceSource {
  const resolvePath = async (chat: AgentChatReference) => {
    const reference = piReference(chat, nativeSessions);
    if (hasRealPiPath(reference)) return reference.nativePath!;
    if (!reference.agentSessionId) return null;
    const { findPiSessionFileBySessionId } = await import('./agents/pi/pi-session-paths.js');
    return findPiSessionFileBySessionId(
      reference.agentSessionId,
      reference.projectPath,
      config,
    );
  };
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
      return { messages: await loadPiMessages(piReference(chat, nativeSessions), config) };
    },
    async describeSource({ chat, signal }) {
      signal.throwIfAborted();
      const nativePath = await resolvePath(chat);
      if (nativePath) return { kind: 'filesystem-path', value: nativePath };
      const reference = piReference(chat, nativeSessions);
      return reference.agentSessionId
        ? { kind: 'provider-reference', value: reference.agentSessionId }
        : null;
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
