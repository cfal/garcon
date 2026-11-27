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
import { createPathNativeSessionCodec, type PathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import { createVersionedSettings } from '@garcon/server-agent-common/settings/versioned-settings';
import { runIsolatedSingleQuery, singleQueryRuntimeOptions } from '@garcon/server-agent-common/shared/single-query-control';
import { createAgentProducerAdapter } from '@garcon/server-agent-common/execution/producer-adapter';
import { createAgentProjectPathUpdates } from '@garcon/server-agent-common/execution/project-path-adapter';
import { createAgentSteering } from '@garcon/server-agent-common/execution/control-adapters';
import {
  createHistoryImport,
  createNativeHistoryImport,
} from '@garcon/server-agent-common/native-session/native-history-import';
import { hasNodeErrorCode } from '@garcon/server-agent-common/lib/errors';
import { createPiNativeActivityProbe } from './agents/pi/native-activity.js';
import { createPiConfig, type PiConfig } from './config.js';
import { PiExecution } from './agents/pi/execution.js';
import { loadPiChatMessages } from './agents/pi/history-loader.js';
import { LazyPiRuntime } from './agents/pi/lazy-runtime.js';
import { getPiAuthStatus } from './agents/pi/pi-auth.js';
import { runSingleQuery } from './agents/pi/pi-cli.js';
import { PiModelCatalogService } from './agents/pi/pi-models.js';
import { findPiSessionFileBySessionId } from './agents/pi/pi-session-paths.js';

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
    { key: 'PI_CODING_AGENT_DIR', source: 'environment' as const, description: 'Pi agent directory.' },
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
  readonly configurationValidation = null;
  static readonly integrationId = 'pi';
  static readonly apiVersion = 5 as const;
  readonly descriptor = PI_DESCRIPTOR;
  readonly literalExecution = null;
  readonly liveTurnRows = null;
  readonly readiness = null;
  readonly attachments = null;
  readonly execution;
  readonly producers;
  readonly permissions;
  readonly legacyHistoryImport;
  readonly nativeHistoryImport;
  readonly nativeActivity;
  readonly nativeSessions;
  readonly sessionConfiguration = null;
  readonly projectPathUpdates: NonNullable<AgentIntegration['projectPathUpdates']>;
  readonly usageHistory = null;
  readonly cliUpdates = null;
  readonly catalog;
  readonly settings;
  readonly lifecycle;
  readonly migration;
  readonly auth: NonNullable<AgentIntegration['auth']>;
  readonly commands = null;
  readonly compaction = null;
  readonly forking = null;
  readonly steering: NonNullable<AgentIntegration['steering']>;
  readonly endpoints = null;
  readonly singleQuery: NonNullable<AgentIntegration['singleQuery']>;

  constructor(host: AgentHost) {
    const config = createPiConfig(host.environment);
    const logger = createScopedAgentLogger(host.logger, 'pi');
    const models = new PiModelCatalogService(config);
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
    this.projectPathUpdates = createAgentProjectPathUpdates(host.scope,
      (request) => providerExecution.prepareProjectPathUpdate(request));
    const nativeEvidence = createPiNativeEvidence(config, nativeSessions, runtime);
    this.nativeSessions = nativeEvidence;
    const producer = createAgentProducerAdapter(providerExecution, host);
    this.execution = producer.execution;
    this.producers = producer.producers;
    this.permissions = producer.permissions;
    this.legacyHistoryImport = createHistoryImport({ load: nativeEvidence.loadLegacy });
    this.nativeHistoryImport = createNativeHistoryImport(nativeEvidence);
    this.nativeActivity = createPiNativeActivityProbe(nativeSessions);
    this.catalog = createModelCatalog({
      logger: host.logger,
      defaultModel: PI_MODELS.DEFAULT,
      fallbackModels: PI_MODELS.OPTIONS,
      requiresStrictModelDiscovery: true,
      generation: null,
      discover: ({ strict, signal }) => strict ? models.getModelsStrict(signal) : models.getModels(signal),
    });
    this.migration = createVersion1RecordMigration({ settings: this.settings, nativeSessions });
    this.auth = {
      async status(signal) {
        signal.throwIfAborted();
        const status = await getPiAuthStatus(models, signal);
        return {
          ...status,
          source: status.authenticated ? 'cli' : 'none',
        };
      },
    };
    this.singleQuery = {
      run: (request) => runIsolatedSingleQuery(request, (directory) => runSingleQuery(request.prompt, {
        model: request.model,
        ...singleQueryRuntimeOptions(request),
        projectPath: directory,
      }, config)),
    };
    this.steering = createAgentSteering(producer, {
      captureTarget: (agentSessionId) => runtime.captureSteerTarget(agentSessionId),
      steer: (request) => runtime.steer(request),
    });
    this.lifecycle = createIntegrationLifecycle({
      start: () => {
        models.start();
        runtime.startPurgeTimer();
      },
      stop: async () => {
        const stopped = await Promise.allSettled([models.stop(), runtime.shutdown()]);
        for (const result of stopped) {
          if (result.status === 'rejected') throw result.reason;
        }
      },
    });
  }
}

function piReference(chat: AgentChatReference, nativeSessions: PathNativeSessionCodec) {
  const native = nativeSessions.decode(chat.nativeSession);
  return {
    projectPath: chat.projectPath,
    nativePath: native.path,
    agentSessionId: chat.agentSessionId
      ?? native.agentSessionId
      ?? getArtificialAgentSessionId(native.path, 'pi'),
  };
}

async function resolvePiHistoryPath(
  { nativePath, agentSessionId, projectPath }: ReturnType<typeof piReference>,
  config: PiConfig,
): Promise<string | null> {
  if (nativePath && !isArtificialNativePath(nativePath)) return nativePath;
  if (!agentSessionId) return null;
  return findPiSessionFileBySessionId(agentSessionId, projectPath, config);
}

function createPiNativeEvidence(
  config: PiConfig,
  nativeSessions: PathNativeSessionCodec,
  runtime: LazyPiRuntime,
): AgentNativeEvidenceSource & {
  readonly loadLegacy: AgentNativeEvidenceSource['load'];
} {
  return {
    async resolveNativeSession({ chat, signal }) {
      signal.throwIfAborted();
      const reference = piReference(chat, nativeSessions);
      const path = await resolvePiHistoryPath(reference, config)
        ?? createArtificialNativePath('pi', reference.agentSessionId);
      return nativeSessions.encode({
        path,
        agentSessionId: reference.agentSessionId,
        modelEndpointId: null,
      });
    },
    async load({ chat, signal }) {
      signal.throwIfAborted();
      const nativePath = await resolvePiHistoryPath(piReference(chat, nativeSessions), config);
      signal.throwIfAborted();
      if (!nativePath) {
        throw new AgentIntegrationError(
          'TRANSCRIPT_UNAVAILABLE',
          'Pi native transcript has no selected session',
          false,
        );
      }
      return { messages: await loadPiChatMessages(nativePath) };
    },
    async loadLegacy({ chat, signal }) {
      signal.throwIfAborted();
      try {
        const nativePath = await resolvePiHistoryPath(piReference(chat, nativeSessions), config);
        return { messages: nativePath ? await loadPiChatMessages(nativePath) : [] };
      } catch (error) {
        if (hasNodeErrorCode(error, 'ENOENT')) {
          return { messages: [] };
        }
        throw error;
      }
    },
    async describeSource({ chat, signal }) {
      signal.throwIfAborted();
      const reference = piReference(chat, nativeSessions);
      const nativePath = await resolvePiHistoryPath(reference, config);
      if (nativePath) return { kind: 'filesystem-path', value: nativePath };
      return reference.agentSessionId
        ? { kind: 'provider-reference', value: reference.agentSessionId }
        : null;
    },
    async release({ chat, signal }) {
      signal.throwIfAborted();
      await runtime.releaseSession(chat.chatId, piReference(chat, nativeSessions).agentSessionId);
    },
  };
}
