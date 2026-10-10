import { AgentIntegrationError, type AgentHost, type AgentIntegration } from '@garcon/server-agent-interface';
import { createVersionedSettings } from '@garcon/server-agent-common/settings/versioned-settings';
import { createVersion1RecordMigration } from '@garcon/server-agent-common/migration/version-1-record-migration';
import { createIntegrationLifecycle } from '@garcon/server-agent-common/lifecycle/integration-lifecycle';
import { createAgentProjectPathUpdates } from '@garcon/server-agent-common/execution/project-path-adapter';
import { createShellCatalog, discoverShells, requireShell } from './catalog.js';
import { ShellExecution } from './execution.js';
import { ShellNativeStore } from './native-store.js';

export default class ShellIntegration implements AgentIntegration {
  static readonly integrationId = 'shell';
  static readonly apiVersion = 5 as const;
  readonly descriptor = {
    id: 'shell', label: 'Shell', icon: null, supportedPermissionModes: [], supportedThinkingModes: [],
    supportsImages: false, supportsProjectPathUpdate: true, requiresNativePathForProjectPathUpdate: false,
    supportedEndpointProtocols: [], configuration: [
      { key: 'PATH', source: 'environment', description: 'Executor executable search path.' },
      { key: 'SHELL', source: 'environment', description: 'Executor account default shell.' },
      { key: 'GARCON_TERMINAL_SHELL', source: 'environment', description: 'Executor preferred shell override.' },
    ],
  } as const;
  readonly literalExecution = { selectionLabel: 'Shell' };
  readonly readiness;
  readonly attachments = null;
  readonly auth = null;
  readonly compaction = null;
  readonly forking = null;
  readonly steering = null;
  readonly endpoints = null;
  readonly singleQuery = null;
  readonly legacyHistoryImport = null;
  readonly nativeActivity = null;
  readonly sessionConfiguration = null;
  readonly commands: NonNullable<AgentIntegration['commands']> = {
    async discover(_projectPath, signal) {
      signal.throwIfAborted();
      return [{ name: 'markdown', source: 'command', description: 'Render command stdout as Markdown' }, { name: 'md', source: 'command', description: 'Render command stdout as Markdown' }];
    },
  };
  readonly catalog;
  readonly settings;
  readonly migration;
  readonly lifecycle;
  readonly execution;
  readonly producers;
  readonly permissions;
  readonly projectPathUpdates;
  readonly configurationValidation: NonNullable<AgentIntegration['configurationValidation']>;
  readonly nativeHistoryImport: NonNullable<AgentIntegration['nativeHistoryImport']>;
  readonly nativeSessions: NonNullable<AgentIntegration['nativeSessions']>;

  constructor(host: AgentHost) {
    const store = new ShellNativeStore(host);
    const runtime = new ShellExecution(host, store);
    this.execution = runtime.execution;
    this.producers = runtime.producers;
    this.permissions = runtime.permissions;
    this.catalog = createShellCatalog(host);
    this.readiness = { async status(signal: AbortSignal) {
      signal.throwIfAborted();
      const ready = discoverShells(host).length > 0;
      return { ready, reason: ready ? 'A supported shell is available on this executor.' : 'No supported shell was found on this executor.' };
    } };
    this.configurationValidation = { async validate(configuration, options) {
      options?.signal?.throwIfAborted();
      requireShell(host, configuration.model);
      if (configuration.endpoint) throw new AgentIntegrationError('INVALID_ENDPOINT', 'Shell does not accept API endpoints.', false);
    } };
    this.settings = createVersionedSettings({ ownerId: 'shell', schemaVersion: 1, defaults: {}, descriptors: [] });
    this.migration = createVersion1RecordMigration({ settings: this.settings, nativeSessions: null });
    this.lifecycle = createIntegrationLifecycle({ start: () => store.initialize(), stop: () => runtime.stop() });
    this.projectPathUpdates = createAgentProjectPathUpdates(host.scope, async () => ({
      async commit() {}, async rollback() {},
    }));
    this.nativeHistoryImport = { load: ({ chat, signal }) => runtime.history(chat.chatId, store.sessionId(chat.nativeSession, chat.agentSessionId), signal) };
    this.nativeSessions = {
      async resolveNativeSession({ chat, signal }) {
        signal.throwIfAborted();
        const id = store.sessionId(chat.nativeSession, chat.agentSessionId);
        const log = await store.load(id, chat.chatId);
        log.close();
        return store.reference(id);
      },
      async describeSource({ chat, signal }) {
        signal.throwIfAborted();
        return { kind: 'filesystem-path', value: await store.path(store.sessionId(chat.nativeSession, chat.agentSessionId)) };
      },
      async release({ chat, signal }) {
        signal.throwIfAborted();
        if (chat.nativeSession) await runtime.release(chat.chatId, store.sessionId(chat.nativeSession, chat.agentSessionId));
      },
    };
  }
}
