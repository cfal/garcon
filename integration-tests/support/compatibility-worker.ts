import { parseArgs } from 'node:util';
import { appendFile } from 'node:fs/promises';
import type { AgentHost, AgentIntegration, AgentIntegrationClass } from '../../server-agents/interface/src/index.js';
import { createVersionedSettings } from '../../server-agents/common/src/settings/versioned-settings.js';
import { createVersion1RecordMigration } from '../../server-agents/common/src/migration/version-1-record-migration.js';
import { createAgentProducerAdapter } from '../../server-agents/common/src/execution/producer-adapter.js';
import type { AgentRuntimeExecutionContext, AgentRuntimePublisher } from '../../server-agents/common/src/execution/runtime-events.js';
import { AssistantMessage } from '../../common/chat-types.js';
import { runExecutorWorker } from '../../server/remote/worker.js';

function integrationClass(id: string, schemaVersion: number, label: string, query: boolean): AgentIntegrationClass {
  return class implements AgentIntegration {
    static readonly integrationId = id;
    static readonly apiVersion = 5;
    readonly descriptor = {
      id, label, icon: null, supportedPermissionModes: ['default'] as const,
      supportedThinkingModes: ['none'] as const, supportedEndpointProtocols: [],
      supportsImages: false, supportsProjectPathUpdate: false,
      requiresNativePathForProjectPathUpdate: false, configuration: [],
    };
    readonly settings = createVersionedSettings({ ownerId: id, schemaVersion,
      defaults: { mode: 'synthetic' }, descriptors: [{ key: 'mode', label: 'Mode', type: 'string' }],
    });
    readonly migration = createVersion1RecordMigration({ settings: this.settings, nativeSessions: null });
    readonly catalog = { async snapshot() {
      return { models: [{ value: 'synthetic', label: 'Synthetic' }], defaultModel: 'synthetic',
        requiresStrictModelDiscovery: false, generation: null };
    } };
    readonly lifecycle = { async start() {}, async stop() {}, async migrateOwnedStorage() {} };
    readonly execution;
    readonly producers;
    readonly permissions;
    readonly singleQuery = query ? { async run() { return 'Synthetic query'; } } : null;
    readonly literalExecution = null;
    readonly readiness = null;
    readonly attachments = query ? { fileMimeTypes: ['text/plain'], inlineTextMaxBytes: 1024 } : null;
    readonly auth = null;
    readonly commands = null;
    readonly compaction = null;
    readonly forking = null;
    readonly steering = null;
    readonly endpoints = null;
    readonly legacyHistoryImport = null;
    readonly nativeHistoryImport = null;
    readonly nativeActivity = null;
    readonly nativeSessions = null;
    readonly configurationValidation = null;
    readonly sessionConfiguration = null;
    readonly projectPathUpdates = null;

    constructor(host: AgentHost) {
      const finish = async (request: AgentRuntimeExecutionContext, publish: AgentRuntimePublisher) => {
        request.admission.signal.throwIfAborted();
        if (process.env.GARCON_TEST_COMPATIBILITY_EFFECTS) {
          await appendFile(process.env.GARCON_TEST_COMPATIBILITY_EFFECTS,
            `${JSON.stringify({ runId: request.runId, schemaVersion: request.settings.schemaVersion })}\n`);
        }
        await request.admission.markStarted();
        publish({ type: 'rows', rows: [{ message: new AssistantMessage('2030-01-01T00:00:00.000Z', 'Synthetic result') }] });
        publish({ type: 'run-ended', runId: request.runId, outcome: 'finished',
          finalResponse: { type: 'text', text: 'Synthetic result' } });
      };
      const adapter = createAgentProducerAdapter({
        async start(request, publish) {
          const session = { agentSessionId: crypto.randomUUID(), nativeSession: null, nativeSeedReceipt: null };
          publish({ type: 'session', session });
          await finish(request, publish);
          return session;
        },
        resume: finish,
        async abort() { return true; },
        runningSessions() { return []; },
      }, host);
      this.execution = adapter.execution;
      this.producers = adapter.producers;
      this.permissions = adapter.permissions;
    }
  };
}

const { values } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: {
  listen: { type: 'string' }, 'bind-address': { type: 'string' }, 'no-tls': { type: 'boolean' },
  'config-dir': { type: 'string' }, 'project-base-dir': { type: 'string' },
} });
if (!values['config-dir'] || !values['project-base-dir']) throw new Error('Missing compatibility worker directories');
const inventory = process.env.GARCON_TEST_COMPATIBILITY_INVENTORY ?? 'original';
if (!['original', 'changed', 'schema', 'empty'].includes(inventory)) throw new Error('Unknown synthetic inventory');
const integrations = inventory === 'empty' ? [] : [
  integrationClass('compat-primary', inventory === 'schema' ? 2 : 1, inventory === 'original' ? 'Original' : 'Replacement', inventory === 'original'),
  integrationClass(inventory === 'original' ? 'compat-removed' : 'compat-added', 1, 'Synthetic secondary', false),
];
const controller = process.env.GARCON_CONTROLLER_URL ? new URL(process.env.GARCON_CONTROLLER_URL) : null;
const secret = controller ? new URLSearchParams(controller.hash.slice(1)).get('secret') : null;
if (controller) controller.hash = '';
if (controller && !secret) throw new Error('Missing controller secret');
await runExecutorWorker({ configDir: values['config-dir'], projectBasePath: values['project-base-dir'],
  noTls: true, integrations,
  connection: controller ? { kind: 'dial', url: controller.href, secret: secret! }
    : { kind: 'listen', port: Number(values.listen ?? 0), bindAddress: values['bind-address'] ?? '0.0.0.0' },
});
