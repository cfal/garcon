import { parseChatMessage, isToolUseMessage } from '@garcon/common/chat-types';
import {
  AgentCallError,
  isAgentResourceRef,
  type AgentHistoryImport,
  type AgentIntegration,
  type AgentImportedTranscriptRow,
  type AgentProducerBinding,
  type AgentProducerNotification,
  type AgentResourceScope,
  type ExecutorCallOptions,
} from '@garcon/server-agent-interface';
import { createVersionedSettings } from '@garcon/server-agent-common/settings/versioned-settings';
import type {
  ExecutorRpcMethods, IntegrationManifest, ProducerAcknowledgement, ProducerResumeState,
} from '../transport/rpc-protocol.js';
import type { RemoteSessionBacking } from './executor-client.js';
import { EXECUTOR_DISCONNECTED_BEFORE_START, EXECUTOR_DISCONNECTED_MID_TURN } from '../../common/executor-disconnect.js';

const SINGLE_QUERY_RPC_GRACE_MS = 30_000;
const PRODUCER_ACK_DELAY_MS = 250;
// Each page carries at most 1 MiB, so a reader holds at most 4 MiB of replies.
const HISTORY_PAGES_IN_FLIGHT = 4;

interface RemoteProducerBinding {
  readonly ref: AgentProducerBinding;
  // The session whose frames this binding accepts; a lost session stays here
  // until a replacement resumes the binding.
  backing: RemoteSessionBacking;
  receivedSeq: number;
  acknowledgedSeq: number;
  // Runs whose start, resume, or compaction outcome never reached the controller.
  readonly unsettledLaunches: Set<string>;
  // The worker's view at resume, applied once the replay reaches it to the
  // runs already unsettled when resume was requested. The report cannot
  // describe a launch dispatched later, which settles through its own reply.
  resumeReport: { readonly report: ProducerResumeState; readonly runIds: readonly string[] } | null;
}

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
  readonly #bindings = new Map<string, RemoteProducerBinding>();
  #ackTimer: ReturnType<typeof setTimeout> | null = null;
  #migrated = false;
  #started = false;

  constructor(readonly manifest: IntegrationManifest, current: () => RemoteSessionBacking) {
    this.descriptor = manifest.descriptor;
    this.attachments = manifest.attachments;
    const call = async <K extends keyof ExecutorRpcMethods>(method: K, request: ExecutorRpcMethods[K]['request'], options?: ExecutorCallOptions) => (
      current().rpc.call(this.descriptor.id, method, request, options)
    );
    const launch = async <K extends 'execution.start' | 'execution.resume' | 'compaction.compact'>(
      method: K, request: ExecutorRpcMethods[K]['request'], options?: ExecutorCallOptions,
    ) => {
      const { rpc } = current();
      const state = this.#bindings.get(request.producerBinding.id);
      try {
        return await rpc.call(this.descriptor.id, method, request, {
          ...options,
          // Native admission may outlive the default RPC deadline; Stop and session loss still cancel it.
          timeoutMs: options?.timeoutMs ?? null,
          onLateResult: (handle) => rpc.call(this.descriptor.id, 'execution.abort', handle),
        });
      } catch (error) {
        if (error instanceof AgentCallError && error.outcome === 'unknown') state?.unsettledLaunches.add(request.runId);
        throw error;
      }
    };
    this.execution = {
      start: (request, options) => launch('execution.start', request, options),
      resume: (request, options) => launch('execution.resume', request, options),
      abort: (handle, options) => call('execution.abort', handle, options),
      runningSessions: (options) => call('execution.runningSessions', null, options),
    };
    this.producers = {
      detach: (binding) => { this.#bindings.delete(binding.id); },
      get scope() { return current().manifests.get(manifest.descriptor.id)!.scope; },
      bind: async (request, options) => {
        const backing = current();
        if (!isAgentResourceRef(request.binding, 'producer', backing.manifests.get(this.descriptor.id)!.scope)) throw new AgentCallError('rejected', 'Producer scope mismatch', 'STALE_RESOURCE');
        const state: RemoteProducerBinding = {
          ref: request.binding, backing, receivedSeq: 0, acknowledgedSeq: 0, unsettledLaunches: new Set(), resumeReport: null,
        };
        this.#bindings.set(request.binding.id, state);
        try { await backing.rpc.call(this.descriptor.id, 'producers.bind', request, options); }
        catch (error) {
          if (this.#bindings.get(request.binding.id) === state) this.#bindings.delete(request.binding.id);
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
    this.compaction = cap.compaction ? { compact: (request, options) => launch('compaction.compact', request, options) } : null;
    this.forking = cap.forking ? {
      fork: async ({ signal, ...request }) => {
        const { rpc } = current();
        return rpc.call(this.descriptor.id, 'forking.fork', request, {
          signal,
          onLateResult: (outcome) => {
            if (outcome.kind === 'materialized') return rpc.call(this.descriptor.id, 'forking.discard', outcome.session);
          },
        });
      },
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
        const close = (ref: ExecutorRpcMethods['history.open']['result']) =>
          rpc.call(manifest.descriptor.id, 'history.close', ref, { timeoutMs: 2000 });
        const ref = await rpc.call(manifest.descriptor.id, 'history.open', { source, request }, { signal, onLateResult: close });
        // Keeping several pages in flight hides link latency behind the worker's
        // reading and the controller's ledger writes.
        const inFlight: Promise<ExecutorRpcMethods['history.next']['result']>[] = [];
        let requested = 0;
        try {
          while (true) {
            while (inFlight.length < HISTORY_PAGES_IN_FLIGHT) {
              const page = rpc.call(manifest.descriptor.id, 'history.next', { reader: ref, page: requested++ }, { signal });
              page.catch(() => undefined);
              inFlight.push(page);
            }
            const batch = await inFlight.shift()!;
            if (batch.done) return;
            yield decodeRows(batch.rows);
          }
        } finally {
          await close(ref).catch(() => undefined);
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
      prepare: async (request, options) => {
        const { rpc } = current();
        return rpc.call(this.descriptor.id, 'projectPathUpdates.prepare', request, {
          ...options,
          onLateResult: (prepared) => {
            if (prepared) return rpc.call(this.descriptor.id, 'projectPathUpdates.rollback', prepared.preparation);
          },
        });
      },
      commit: (ref, options) => call('projectPathUpdates.commit', ref, options),
      rollback: (ref, options) => call('projectPathUpdates.rollback', ref, options),
    } : null;
  }

  async initializeReplacement(backing: RemoteSessionBacking, initial = false): Promise<void> {
    if (initial || this.#migrated) await backing.rpc.call(this.descriptor.id, 'lifecycle.migrateOwnedStorage', null);
    if (initial || this.#started) await backing.rpc.call(this.descriptor.id, 'lifecycle.start', null);
    if (initial) { this.#migrated = true; this.#started = true; }
  }

  retire(): void {
    this.#bindings.clear();
    if (this.#ackTimer) clearTimeout(this.#ackTimer);
    this.#ackTimer = null;
  }

  // Reattaches bindings from lost sessions. Replayed frames stream around the
  // reply, paced by the worker, and are deduplicated by sequence; a binding the
  // worker no longer holds fails its run exactly as a lost session did before
  // resumption.
  async resume(backing: RemoteSessionBacking): Promise<void> {
    const suspended = [...this.#bindings.values()].filter((state) => state.backing !== backing);
    if (suspended.length === 0) return;
    const lostRunIds = new Map(suspended.map((state) => [state, [...state.unsettledLaunches]]));
    for (const state of suspended) state.backing = backing;
    const { resumed } = await backing.rpc.call(this.descriptor.id, 'producers.resume', {
      bindings: suspended.map((state) => ({ binding: state.ref, acknowledgedSeq: state.receivedSeq })),
    });
    const reports = new Map(resumeStates(resumed, backing.manifests.get(this.descriptor.id)!.scope)
      .map((report) => [report.bindingId, report]));
    for (const state of suspended) {
      if (this.#bindings.get(state.ref.id) !== state) continue;
      const report = reports.get(state.ref.id);
      if (report) {
        state.resumeReport = { report, runIds: lostRunIds.get(state)! };
        this.#settleLostLaunches(state);
        continue;
      }
      this.#bindings.delete(state.ref.id);
      this.#emit({ binding: state.ref, event: { type: 'publication-failed', error: {
        code: 'OUTCOME_UNKNOWN', message: EXECUTOR_DISCONNECTED_MID_TURN,
      } } });
    }
    this.#scheduleAcknowledgement();
  }

  receive(notification: AgentProducerNotification, seq: number, backing: RemoteSessionBacking): void {
    const { binding } = notification;
    if (!isAgentResourceRef(binding, 'producer', backing.manifests.get(this.descriptor.id)!.scope)) throw new Error('Producer event scope mismatch');
    const state = this.#bindings.get(binding.id);
    if (state?.backing !== backing || seq <= state.receivedSeq) return;
    const gap = seq > state.receivedSeq + 1;
    state.receivedSeq = seq;
    this.#scheduleAcknowledgement();
    if (gap) this.#emit({ binding, event: { type: 'publication-gap' } });
    let event = notification.event;
    if (event.type === 'publication-failed') {
      if (!isFailureDetail(event.error)) throw new Error('Invalid producer publication failure');
      this.#bindings.delete(binding.id);
    }
    if (event.type === 'launch-settled') {
      const scope = backing.manifests.get(this.descriptor.id)!.scope;
      if (typeof event.runId !== 'string' || (event.handle ? !isAgentResourceRef(event.handle, 'execution', scope) : !isFailureDetail(event.error))) {
        throw new Error('Invalid launch outcome');
      }
    }
    if (event.type === 'launch-settled' || event.type === 'run-ended') state.unsettledLaunches.delete(event.runId);
    if (event.type === 'rows') event = { ...event, rows: decodeRows(event.rows) };
    if (event.type === 'permission' && event.lifecycle.kind === 'requested') {
      const tool = decodeMessage(event.lifecycle.requestedTool);
      if (!isToolUseMessage(tool)) throw new Error('Invalid permission tool');
      if (!event.decision) throw new Error('Permission response capability is missing');
      event = { type: 'permission', runId: event.runId, lifecycle: { ...event.lifecycle, requestedTool: tool }, decision: event.decision };
    }
    this.#emit({ binding, event });
    if (this.#bindings.get(binding.id) === state) this.#settleLostLaunches(state);
  }

  // Settles launches whose replies were lost once the replay reaches the
  // worker's resume report, so every event it published earlier, such as a
  // run's end, is applied first. A launch the worker has not finished reports
  // its own outcome on the binding later.
  #settleLostLaunches(state: RemoteProducerBinding): void {
    const pending = state.resumeReport;
    if (!pending || state.receivedSeq < pending.report.replayThroughSeq) return;
    state.resumeReport = null;
    for (const runId of pending.runIds) {
      if (!state.unsettledLaunches.has(runId)) continue;
      const launch = pending.report.launch?.runId === runId ? pending.report.launch : null;
      if (launch && !launch.handle) continue;
      state.unsettledLaunches.delete(runId);
      this.#emit({ binding: state.ref, event: launch?.handle
        ? { type: 'launch-settled', runId, handle: launch.handle }
        : { type: 'launch-settled', runId, error: EXECUTOR_DISCONNECTED_BEFORE_START } });
    }
  }

  #emit(notification: AgentProducerNotification): void {
    for (const listener of this.#listeners) listener(notification);
  }

  // Acknowledges received frames in batches so the worker can release them.
  #scheduleAcknowledgement(): void {
    if (this.#ackTimer) return;
    this.#ackTimer = setTimeout(() => {
      this.#ackTimer = null;
      const pending = new Map<RemoteSessionBacking, ProducerAcknowledgement[]>();
      for (const state of this.#bindings.values()) {
        if (state.receivedSeq <= state.acknowledgedSeq || !state.backing.rpc.transport.connected) continue;
        state.acknowledgedSeq = state.receivedSeq;
        const acknowledgements = pending.get(state.backing) ?? [];
        acknowledgements.push({ bindingId: state.ref.id, seq: state.receivedSeq });
        pending.set(state.backing, acknowledgements);
      }
      for (const [backing, acknowledgements] of pending) backing.rpc.acknowledgeProducers(acknowledgements);
    }, PRODUCER_ACK_DELAY_MS);
    this.#ackTimer.unref?.();
  }
}

function isFailureDetail(value: unknown): value is { readonly code: string; readonly message?: string } {
  if (!value || typeof value !== 'object') return false;
  const detail = value as Record<string, unknown>;
  return typeof detail.code === 'string' && (detail.message === undefined || typeof detail.message === 'string');
}

function resumeStates(value: unknown, scope: AgentResourceScope): readonly ProducerResumeState[] {
  if (!Array.isArray(value)) throw new Error('Invalid producer resume reply');
  for (const state of value as unknown[]) {
    const report = state as Partial<ProducerResumeState> | null;
    const launch = report?.launch;
    if (typeof report?.bindingId !== 'string' || !Number.isSafeInteger(report.replayThroughSeq) || report.replayThroughSeq! < 0
      || (launch !== null && (typeof launch?.runId !== 'string'
        || (launch.handle !== null && !isAgentResourceRef(launch.handle, 'execution', scope))))) {
      throw new Error('Invalid producer resume reply');
    }
  }
  return value as readonly ProducerResumeState[];
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
