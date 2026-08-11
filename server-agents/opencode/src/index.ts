import { PERMISSION_MODE_VALUES, THINKING_MODE_VALUES } from '@garcon/common/chat-modes';
import { retargetNativeSeedReceipt } from '@garcon/common/transcript-seed';
import {
  AgentIntegrationError,
  type AgentChatReference,
  type AgentHost,
  type AgentIntegrationV4,
} from '@garcon/server-agent-interface';
import type { AgentNativeEvidenceSource } from '@garcon/server-agent-common/transcript-projection/evidence-source';
import { createModelCatalog } from '@garcon/server-agent-common/catalog/model-catalog';
import { resolveAgentStandaloneEntrypoint } from '@garcon/server-agent-common/build/standalone-entrypoint';
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
import { createAgentOwnedProjection } from '@garcon/server-agent-common/transcript-projection/owned-projection';
import { createOpenCodeConfig } from './config.js';
import { OpenCodeExecution } from './agents/opencode/execution.js';
import { loadOpenCodeChatMessages } from './agents/opencode/history-loader.js';
import { getOpenCodeAuthStatus } from './agents/opencode/opencode-auth.js';
import { OpenCodeRuntime } from './agents/opencode/opencode.js';

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

export default class OpenCodeAgentIntegration implements AgentIntegrationV4 {
  static readonly integrationId = 'opencode';
  static readonly apiVersion = 4 as const;
  static readonly transcriptIndex = {
    apiVersion: 2,
    moduleUrl: resolveAgentStandaloneEntrypoint({
      integrationId: 'opencode',
      name: 'transcript-index-source',
      sourceUrl: new URL('./transcript-index-source.ts', import.meta.url),
    }),
  } as const;

  readonly descriptor = OPENCODE_DESCRIPTOR;
  readonly attachments = null;
  readonly execution;
  readonly transcript;
  readonly catalog;
  readonly settings;
  readonly lifecycle;
  readonly migration;
  readonly auth: NonNullable<AgentIntegrationV4['auth']>;
  readonly commands = null;
  readonly compaction = null;
  readonly forking: NonNullable<AgentIntegrationV4['forking']>;
  readonly steering: NonNullable<AgentIntegrationV4['steering']>;
  readonly goals = null;
  readonly endpoints = null;
  readonly singleQuery: NonNullable<AgentIntegrationV4['singleQuery']>;
  readonly transientControls = { protocol: 'ordered-stream-v1' as const };

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
    const nativeEvidence = createOpenCodeNativeEvidence(runtime, nativeSessions, sessionId, logger);
    const projection = createAgentOwnedProjection({
      ownerId: 'opencode',
      host,
      execution: providerExecution,
      nativeEvidence,
    });
    this.execution = projection.execution;
    this.transcript = projection.transcript;
    this.steering = {
      captureTarget: (request) => runtime.steering.captureTarget(request.agentSessionId),
      steer: (request) => projection.deliverSteer(
        request.chatId,
        request.operation,
        () => runtime.steering.steer(request),
      ),
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
    this.forking = {
      supportsAtMessage: false,
      supportsWhileRunning: false,
      async resolvePoint() {
        return { kind: 'unavailable', reason: 'no-native-source' } as const;
      },
      async fork(request) {
        request.admission.signal.throwIfAborted();
        if (request.point) {
          throw new AgentIntegrationError(
            'OPERATION_UNSUPPORTED',
            'OpenCode does not support message-point forks',
            false,
          );
        }
        const sourceSessionId = sessionId(request.source)?.trim();
        if (!sourceSessionId) {
          throw new AgentIntegrationError(
            'TRANSCRIPT_UNAVAILABLE',
            'Cannot fork OpenCode session without a source session ID',
            false,
          );
        }
        const agentSessionId = await runtime.forkSession(sourceSessionId, {
          projectPath: request.source.projectPath,
        });
        return {
          kind: 'materialized',
          session: {
            agentSessionId,
            nativeSession: nativeSessions.encode({
              path: createArtificialNativePath('opencode', agentSessionId),
              agentSessionId,
              modelEndpointId: null,
            }),
            nativeSeedReceipt: retargetNativeSeedReceipt(
              request.source.nativeSeedReceipt,
              agentSessionId,
            ),
          },
        };
      },
      // OpenCode exposes no safe API for deleting an uncommitted fork.
      async discard(_session, signal) {
        signal.throwIfAborted();
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
