import { parseChatMessage, isToolUseMessage } from '@garcon/common/chat-types';
import {
  AgentCallError,
  isAgentResourceRef,
  type AgentHistoryImport,
  type AgentIntegration,
  type AgentImportedTranscriptRow,
  type AgentProducerNotification,
} from '@garcon/server-agent-interface';
import { createVersionedSettings } from '@garcon/server-agent-common/settings/versioned-settings';
import type { ExecutorRpcMethods, IntegrationManifest } from '../transport/rpc-protocol.js';
import type { ExecutorRpc } from '../transport/rpc.js';
import type { RemoteSessionBacking } from './executor-client.js';

const SINGLE_QUERY_RPC_GRACE_MS = 30_000;

export class RemoteAgentIntegration implements AgentIntegration {
  readonly descriptor;
  readonly attachments;
  readonly execution: AgentIntegration['execution'];
  readonly producers: AgentIntegration['producers'];
  readonly permissions: AgentIntegration['permissions'];
  readonly catalog: AgentIntegration['catalog'];
  readonly settings: AgentIntegration['settings'];
  readonly lifecycle: AgentIntegration['lifecycle'];
  readonly migration: AgentIntegration['migration'];
  readonly auth: AgentIntegration['auth'];
  readonly commands: AgentIntegration['commands'];
  readonly compaction: AgentIntegration['compaction'];
  readonly forking: AgentIntegration['forking'];
  readonly steering: AgentIntegration['steering'];
  readonly endpoints: AgentIntegration['endpoints'];
  readonly singleQuery: AgentIntegration['singleQuery'];
  readonly legacyHistoryImport: AgentIntegration['legacyHistoryImport'];
  readonly nativeHistoryImport: AgentIntegration['nativeHistoryImport'];
  readonly nativeActivity: AgentIntegration['nativeActivity'];
  readonly nativeSessions: AgentIntegration['nativeSessions'];
  readonly configurationValidation: AgentIntegration['configurationValidation'];
  readonly sessionConfiguration: AgentIntegration['sessionConfiguration'];
  readonly projectPathUpdates: AgentIntegration['projectPathUpdates'];
  readonly #listeners = new Set<(event: AgentProducerNotification) => void>();
  readonly #bindings = new Map<string, RemoteSessionBacking>();
  #migrated = false;
  #started = false;

  constructor(readonly manifest: IntegrationManifest, current: () => RemoteSessionBacking) {
    this.descriptor = manifest.descriptor;
    this.attachments = manifest.attachments;
    const call = async <K extends keyof ExecutorRpcMethods>(method: K, request: ExecutorRpcMethods[K]['request'], options?: Parameters<ExecutorRpc['call']>[3]) => (
      current().rpc.call(this.descriptor.id, method, request, options)
    );
    this.execution = {
      start: (request, options) => call('execution.start', request, options),
      resume: (request, options) => call('execution.resume', request, options),
      abort: (handle, options) => call('execution.abort', handle, options),
      runningSessions: (options) => call('execution.runningSessions', null, options),
    };
    this.producers = {
      detach: (binding) => { this.#bindings.delete(binding.id); },
      get scope() { return current().manifests.get(manifest.descriptor.id)!.scope; },
      bind: async (request, options) => {
        const backing = current();
        if (!isAgentResourceRef(request.binding, 'producer', backing.manifests.get(this.descriptor.id)!.scope)) throw new AgentCallError('rejected', 'Producer scope mismatch', 'STALE_RESOURCE');
        this.#bindings.set(request.binding.id, backing);
        try { await backing.rpc.call(this.descriptor.id, 'producers.bind', request, options); }
        catch (error) {
          if (this.#bindings.get(request.binding.id) === backing) this.#bindings.delete(request.binding.id);
          throw error;
        }
      },
      close: async (binding, options) => {
        this.#bindings.delete(binding.id);
        await call('producers.close', binding, options);
      },
      subscribe: (listener) => {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
      },
    };
    this.permissions = { respond: (request, options) => call('permissions.respond', request, options) };
    this.catalog = { snapshot: ({ signal, ...request }) => call('catalog.snapshot', request, { signal }) };
    this.settings = {
      ...createVersionedSettings({
        ownerId: this.descriptor.id, schemaVersion: manifest.settings.defaults.schemaVersion,
        defaults: manifest.settings.defaults.values, descriptors: manifest.settings.descriptors,
      }),
      migrate: (request) => call('settings.migrate', request),
    };
    this.lifecycle = {
      start: async () => { if (!this.#started) { await call('lifecycle.start', null); this.#started = true; } },
      stop: async () => { this.#started = false; await call('lifecycle.stop', null); },
      migrateOwnedStorage: async () => { if (!this.#migrated) { await call('lifecycle.migrateOwnedStorage', null); this.#migrated = true; } },
    };
    this.migration = {
      translateLegacyModel: ({ signal, ...request }) => call('migration.translateLegacyModel', request, { signal }),
      translateLegacyNativeSession: ({ signal, ...request }) => call('migration.translateLegacyNativeSession', request, { signal }),
      translateLegacySettings: ({ signal, ...request }) => call('migration.translateLegacySettings', request, { signal }),
    };
    const cap = manifest.capabilities;
    this.auth = cap.auth ? {
      status: (signal) => call('auth.status', null, { signal }),
      ...(manifest.authMethods.launchLogin ? { launchLogin: () => call('auth.launchLogin', null) } : {}),
      ...(manifest.authMethods.completeLogin ? { completeLogin: (sessionId: string, code: string) => call('auth.completeLogin', { sessionId, code }) } : {}),
      ...(manifest.authMethods.loginStatus ? { loginStatus: (expectedSessionId?: string) => call('auth.loginStatus', { expectedSessionId }) } : {}),
    } : null;
    this.commands = cap.commands ? { discover: (projectPath, signal) => call('commands.discover', { projectPath }, { signal }) } : null;
    this.compaction = cap.compaction ? { compact: (request, options) => call('compaction.compact', request, options) } : null;
    this.forking = cap.forking ? {
      fork: ({ signal, ...request }) => call('forking.fork', request, { signal }),
      discard: (request, signal) => call('forking.discard', request, { signal }),
    } : null;
    this.steering = cap.steering ? {
      captureTarget: (request, options) => call('steering.captureTarget', request, options),
      steer: (request, options) => call('steering.steer', request, options),
    } : null;
    this.endpoints = cap.endpoints ? { validate: (request) => call('endpoints.validate', request) } : null;
    this.singleQuery = cap.singleQuery ? {
      run: async ({ signal, ...request }) => {
        const timeoutMs = request.timeoutMs;
        if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0
          || timeoutMs > 2 ** 31 - 1 - SINGLE_QUERY_RPC_GRACE_MS)) {
          throw new AgentCallError('not-dispatched', 'Single-query timeout is invalid');
        }
        return call('singleQuery.run', request, { signal, timeoutMs: (timeoutMs ?? 120_000) + SINGLE_QUERY_RPC_GRACE_MS });
      },
      ...(manifest.singleQueryRunsToolsWithoutPermission ? { runsToolsWithoutPermission: true as const } : {}),
    } : null;
    const history = (source: 'legacyHistoryImport' | 'nativeHistoryImport'): AgentHistoryImport => ({
      async *load({ signal, ...request }) {
        const { rpc } = current();
        const ref = await rpc.call(manifest.descriptor.id, 'history.open', { source, request }, { signal });
        try {
          while (true) {
            const batch = await rpc.call(manifest.descriptor.id, 'history.next', ref, { signal });
            if (batch.done) return;
            yield decodeRows(batch.rows);
          }
        } finally {
          await rpc.call(manifest.descriptor.id, 'history.close', ref, { timeoutMs: 2000 }).catch(() => undefined);
        }
      },
    });
    this.legacyHistoryImport = cap.legacyHistoryImport ? history('legacyHistoryImport') : null;
    this.nativeHistoryImport = cap.nativeHistoryImport ? history('nativeHistoryImport') : null;
    this.nativeActivity = cap.nativeActivity ? { lastActivity: (request, signal) => call('nativeActivity.lastActivity', request, { signal }) } : null;
    this.nativeSessions = cap.nativeSessions ? {
      resolveNativeSession: ({ signal, ...request }) => call('nativeSessions.resolveNativeSession', request, { signal }),
      describeSource: ({ signal, ...request }) => call('nativeSessions.describeSource', request, { signal }),
      release: ({ signal, ...request }) => call('nativeSessions.release', request, { signal }),
    } : null;
    this.configurationValidation = cap.configurationValidation ? { validate: (request) => call('configurationValidation.validate', request) } : null;
    this.sessionConfiguration = cap.sessionConfiguration ? { apply: (...args) => call('sessionConfiguration.apply', { args }) } : null;
    this.projectPathUpdates = cap.projectPathUpdates ? {
      prepare: (request, options) => call('projectPathUpdates.prepare', request, options),
      commit: (ref, options) => call('projectPathUpdates.commit', ref, options),
      rollback: (ref, options) => call('projectPathUpdates.rollback', ref, options),
    } : null;
  }

  async initializeReplacement(backing: RemoteSessionBacking, initial = false): Promise<void> {
    if (initial || this.#migrated) await backing.rpc.call(this.descriptor.id, 'lifecycle.migrateOwnedStorage', null);
    if (initial || this.#started) await backing.rpc.call(this.descriptor.id, 'lifecycle.start', null);
    if (initial) { this.#migrated = true; this.#started = true; }
  }

  retire(): void { this.#bindings.clear(); }

  receive(notification: AgentProducerNotification, backing: RemoteSessionBacking): void {
    const { binding } = notification;
    if (!isAgentResourceRef(binding, 'producer', backing.manifests.get(this.descriptor.id)!.scope)) throw new Error('Producer event scope mismatch');
    if (this.#bindings.get(binding.id) !== backing) return;
    let event = notification.event;
    if (event.type === 'publication-failed') {
      if (!event.error || typeof event.error.code !== 'string'
        || (event.error.message !== undefined && typeof event.error.message !== 'string')) {
        throw new Error('Invalid producer publication failure');
      }
      this.#bindings.delete(binding.id);
    }
    if (event.type === 'rows') event = { ...event, rows: decodeRows(event.rows) };
    if (event.type === 'permission' && event.lifecycle.kind === 'requested') {
      const tool = decodeMessage(event.lifecycle.requestedTool);
      if (!isToolUseMessage(tool)) throw new Error('Invalid permission tool');
      if (!event.decision) throw new Error('Permission response capability is missing');
      event = { type: 'permission', runId: event.runId, lifecycle: { ...event.lifecycle, requestedTool: tool }, decision: event.decision };
    }
    for (const listener of this.#listeners) listener({ binding, event });
  }
}

function decodeRows(rows: readonly AgentImportedTranscriptRow[]): readonly AgentImportedTranscriptRow[] {
  if (!Array.isArray(rows)) throw new Error('Invalid imported rows');
  return rows.map((row) => ({ ...row, message: decodeMessage(row.message) }));
}

function decodeMessage(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid normalized message');
  const message = parseChatMessage(value as Record<string, unknown>);
  if (!message) throw new Error('Unknown normalized message');
  return message;
}
