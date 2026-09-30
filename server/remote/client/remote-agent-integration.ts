import { parseChatMessage, isToolUseMessage } from '@garcon/common/chat-types';
import {
  AgentCallError,
  isAgentResourceRef,
  type AgentHistoryImport,
  type AgentIntegration,
  type AgentImportedTranscriptRow,
  type AgentProducerBinding,
  type AgentExecutionHandle,
  type AgentProducerNotification,
  type AgentResourceScope,
  type ExecutorCallOptions,
} from '@garcon/server-agent-interface';
import { failureDetail } from '@garcon/server-agent-common/execution/producer-adapter';
import { createVersionedSettings } from '@garcon/server-agent-common/settings/versioned-settings';
import type {
  ExecutorRpcMethods, IntegrationManifest, ProducerAcknowledgement, ProducerResumeState,
} from '../transport/rpc-protocol.js';
import type { RemoteSessionBacking, RemoteSessions } from './executor-client.js';
import { failureReason } from '../transport/failure-reason.js';
import { createLogger, type Logger } from '../../common/log.js';
import { EXECUTOR_DISCONNECTED_BEFORE_START, EXECUTOR_DISCONNECTED_MID_TURN } from '../../common/executor-disconnect.js';

const SINGLE_QUERY_RPC_GRACE_MS = 30_000;
// Answers the browser, whose requests time out after 30 s, even while the
// executor reconnects; an answer that could not be sent stays actionable.
const PERMISSION_RESPONSE_TIMEOUT_MS = 20_000;
const PRODUCER_ACK_DELAY_MS = 250;
// Each page carries at most 1 MiB, so a reader holds at most 4 MiB of replies.
const HISTORY_PAGES_IN_FLIGHT = 4;
const UNREADABLE_EVENT_FAILURE = {
  code: 'OUTCOME_UNKNOWN',
  message: 'An event from the executor could not be read, so this turn\'s outcome is unknown. Native history may contain additional output.',
} as const;

// A start, resume, or compaction whose outcome never reached the controller.
interface UnsettledLaunch {
  // Sends the same request on a replacement session, at most once.
  send: ((backing: RemoteSessionBacking) => Promise<AgentExecutionHandle>) | null;
  // Stops relaying the caller's cancellation once the launch settles.
  readonly release: () => void;
}

interface RemoteProducerBinding {
  readonly ref: AgentProducerBinding;
  // The session whose frames this binding accepts; a lost session stays here
  // until a replacement resumes the binding.
  backing: RemoteSessionBacking;
  receivedSeq: number;
  acknowledgedSeq: number;
  // Keyed by run ID.
  readonly unsettledLaunches: Map<string, UnsettledLaunch>;
  // The worker's view at resume, applied once the replay reaches it to the
  // runs already unsettled when resume was requested. The report cannot
  // describe a launch dispatched later, which settles through its own reply.
  resumeReport: { readonly report: ProducerResumeState; readonly runIds: readonly string[] } | null;
  // Whether lost output was reported since the last delivered event, so a run of
  // losses records one notice.
  lostOutputReported: boolean;
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
  readonly #log: Logger;
  readonly #bindings = new Map<string, RemoteProducerBinding>();
  // Sessions of bindings that failed before their owner closed them. The close must
  // reach the worker through the session that holds the binding, which can still be
  // installing when a replayed event fails it.
  readonly #failedBindings = new Map<string, RemoteSessionBacking>();
  #ackTimer: ReturnType<typeof setTimeout> | null = null;
  #migrated = false;
  #started = false;

  constructor(
    readonly manifest: IntegrationManifest,
    sessions: RemoteSessions,
    log: Logger = createLogger('executors'),
  ) {
    this.#log = log;
    this.descriptor = manifest.descriptor;
    this.attachments = manifest.attachments;
    const call = async <K extends keyof ExecutorRpcMethods>(method: K, request: ExecutorRpcMethods[K]['request'], options?: ExecutorCallOptions) => (
      sessions.call(this.descriptor.id, method, request, options)
    );
    const launch = async <K extends 'execution.start' | 'execution.resume' | 'compaction.compact'>(
      method: K, request: ExecutorRpcMethods[K]['request'], options?: ExecutorCallOptions,
    ) => {
      const state = this.#bindings.get(request.producerBinding.id);
      // Cancellation waits for the binding's worker for as long as it may run the launch.
      const cancelOnWorker = (binding: RemoteProducerBinding) => {
        void sessions.call(this.descriptor.id, 'producers.cancelLaunch', { binding: binding.ref, runId: request.runId }, {
          timeoutMs: null,
          instanceId: binding.backing.info.instanceId,
        }).catch(() => undefined);
      };
      // Native admission may outlive the default RPC deadline; Stop still cancels it.
      const send = ({ rpc }: RemoteSessionBacking, deadline: number | null) => rpc.call(this.descriptor.id, method, request, {
        ...options,
        timeoutMs: deadline,
        onLateResult: (handle) => rpc.call(this.descriptor.id, 'execution.abort', handle),
        // The session was lost before a cancelled launch reported its outcome. The
        // replacement session's resume report settles it, and the router stops it.
        onLateResultLost: () => {
          if (!state || this.#bindings.get(state.ref.id) !== state || state.unsettledLaunches.has(request.runId)) return;
          state.unsettledLaunches.set(request.runId, { send: null, release: () => undefined });
          cancelOnWorker(state);
        },
      });
      try {
        return await sessions.send(
          { signal: options?.signal, timeoutMs: options?.timeoutMs ?? null, dispatchDeadline: options?.dispatchDeadline },
          ({ backing, timeoutMs }) => send(backing, timeoutMs),
        );
      } catch (error) {
        const signal = options?.signal;
        // A binding closed or failed meanwhile has no run left to settle or cancel.
        if (state && this.#bindings.get(state.ref.id) === state
          && error instanceof AgentCallError && error.outcome === 'unknown' && !signal?.aborted) {
          // A lost call no longer carries the caller's cancellation, so a later
          // Stop cancels the launch through the worker's relay instead.
          const cancel = () => {
            if (state.unsettledLaunches.get(request.runId) === lost) cancelOnWorker(state);
          };
          const lost: UnsettledLaunch = {
            send: (replacement) => send(replacement, null),
            release: () => signal?.removeEventListener('abort', cancel),
          };
          signal?.addEventListener('abort', cancel, { once: true });
          state.unsettledLaunches.set(request.runId, lost);
        }
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
      detach: (binding) => { this.#forgetBinding(binding.id); },
      get scope() { return sessions.latest().manifests.get(manifest.descriptor.id)!.scope; },
      bind: async (request, options) => {
        const { backing, timeoutMs } = await sessions.acquire(options);
        if (!isAgentResourceRef(request.binding, 'producer', backing.manifests.get(this.descriptor.id)!.scope)) throw new AgentCallError('rejected', 'Producer scope mismatch', 'STALE_RESOURCE');
        const state: RemoteProducerBinding = {
          ref: request.binding, backing, receivedSeq: 0, acknowledgedSeq: 0, unsettledLaunches: new Map(), resumeReport: null,
          lostOutputReported: false,
        };
        this.#bindings.set(request.binding.id, state);
        try { await backing.rpc.call(this.descriptor.id, 'producers.bind', request, { ...options, timeoutMs }); }
        catch (error) {
          if (this.#bindings.get(request.binding.id) === state) this.#bindings.delete(request.binding.id);
          throw error;
        }
      },
      close: async (binding, options) => {
        const holder = this.#bindings.get(binding.id)?.backing ?? this.#failedBindings.get(binding.id);
        this.#forgetBinding(binding.id);
        this.#failedBindings.delete(binding.id);
        // A close waits for the worker for as long as it may hold the binding: the
        // worker suspends a lost session's bindings, and a replacement session of
        // the same instance closes this one without resuming it.
        const closing = { ...options, timeoutMs: options?.timeoutMs ?? null, instanceId: holder?.info.instanceId };
        if (holder?.rpc.transport.connected) return holder.rpc.call(this.descriptor.id, 'producers.close', binding, closing);
        await sessions.send(closing, ({ backing, timeoutMs }) => (
          backing.rpc.call(this.descriptor.id, 'producers.close', binding, { ...closing, timeoutMs })
        ));
      },
      subscribe: (listener) => {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
      },
    };
    this.permissions = {
      respond: (request, options) => call('permissions.respond', request, { timeoutMs: PERMISSION_RESPONSE_TIMEOUT_MS, ...options }),
    };
    this.catalog = {
      snapshot: ({ signal, timeoutMs, dispatchDeadline, ...request }) => call('catalog.snapshot', request, { signal, timeoutMs, dispatchDeadline }),
    };
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
        const { backing: { rpc }, timeoutMs } = await sessions.acquire({ signal });
        return rpc.call(this.descriptor.id, 'forking.fork', request, {
          signal,
          timeoutMs,
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
    this.endpoints = cap.endpoints ? { validate: (request, options) => call('endpoints.validate', request, options) } : null;
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
        // A reader belongs to the session that opened it.
        const { backing: { rpc }, timeoutMs } = await sessions.acquire({ signal });
        const close = (ref: ExecutorRpcMethods['history.open']['result']) =>
          rpc.call(manifest.descriptor.id, 'history.close', ref, { timeoutMs: 2000 });
        const ref = await rpc.call(manifest.descriptor.id, 'history.open', { source, request }, { signal, timeoutMs, onLateResult: close });
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
    this.configurationValidation = cap.configurationValidation ? { validate: (request, options) => call('configurationValidation.validate', request, options) } : null;
    this.sessionConfiguration = cap.sessionConfiguration ? {
      apply: (agentSessionId, configuration, previousConfiguration, options) => call(
        'sessionConfiguration.apply', { args: [agentSessionId, configuration, previousConfiguration] }, options,
      ),
    } : null;
    this.projectPathUpdates = cap.projectPathUpdates ? {
      prepare: async (request, options) => {
        const { backing: { rpc }, timeoutMs } = await sessions.acquire(options);
        return rpc.call(this.descriptor.id, 'projectPathUpdates.prepare', request, {
          ...options,
          timeoutMs,
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
    for (const id of [...this.#bindings.keys()]) this.#forgetBinding(id);
    this.#failedBindings.clear();
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
    const lostRunIds = new Map(suspended.map((state) => [state, [...state.unsettledLaunches.keys()]]));
    // A report from an earlier session describes a replay this session does
    // not deliver, so only this session's report may settle lost launches.
    for (const state of suspended) {
      state.backing = backing;
      state.resumeReport = null;
    }
    const { resumed } = await backing.rpc.call(this.descriptor.id, 'producers.resume', {
      bindings: suspended.map((state) => ({ binding: state.ref, acknowledgedSeq: state.receivedSeq })),
    });
    if (!Array.isArray(resumed)) throw new Error('Invalid producer resume reply');
    const scope = backing.manifests.get(this.descriptor.id)!.scope;
    const requested = new Set(suspended.map((state) => state.ref.id));
    const reports = new Map<string, ProducerResumeState>();
    const unreadable = new Set<string>();
    for (const report of resumed as unknown[]) {
      if (isResumeState(report, scope)) {
        reports.set(report.bindingId, report);
        continue;
      }
      // The rest of an unreadable report is peer text, so only an ID this controller asked about is kept.
      const bindingId = (report as { readonly bindingId?: unknown } | null)?.bindingId;
      const requestedId = typeof bindingId === 'string' && requested.has(bindingId) ? bindingId : null;
      if (requestedId) unreadable.add(requestedId);
      this.#log.warn('Executor producer resume report could not be read', {
        integrationId: this.descriptor.id, bindingId: requestedId,
      });
    }
    for (const state of suspended) {
      if (this.#bindings.get(state.ref.id) !== state) continue;
      const report = reports.get(state.ref.id);
      if (report) {
        state.resumeReport = { report, runIds: lostRunIds.get(state)! };
        this.#settleLostLaunches(state);
        continue;
      }
      // A binding whose report cannot be read fails like one the worker no longer holds,
      // rather than retiring every replacement session. Reading it as no launch would
      // settle a lost launch as never started.
      this.#retireFailed(state);
      this.#emit({ binding: state.ref, event: { type: 'publication-failed', error: unreadable.has(state.ref.id)
        ? UNREADABLE_EVENT_FAILURE
        : { code: 'OUTCOME_UNKNOWN', message: EXECUTOR_DISCONNECTED_MID_TURN } } });
    }
    this.#scheduleAcknowledgement();
  }

  receive(notification: AgentProducerNotification, seq: number, backing: RemoteSessionBacking): void {
    const { binding } = notification;
    const scope = backing.manifests.get(this.descriptor.id)!.scope;
    if (!isAgentResourceRef(binding, 'producer', scope)) throw new Error('Producer event scope mismatch');
    const state = this.#bindings.get(binding.id);
    if (state?.backing !== backing || seq <= state.receivedSeq) return;
    const gap = seq > state.receivedSeq + 1;
    state.receivedSeq = seq;
    this.#scheduleAcknowledgement();
    if (gap) this.#reportLostOutput(state);
    const event = this.#decode(notification.event, scope, binding, seq);
    if (event.type === 'publication-gap') this.#reportLostOutput(state);
    else {
      state.lostOutputReported = false;
      if (event.type === 'publication-failed') this.#retireFailed(state);
      if (event.type === 'launch-settled' || event.type === 'run-ended') this.#forgetLaunch(state, event.runId);
      this.#emit({ binding, event });
    }
    if (this.#bindings.get(binding.id) === state) this.#settleLostLaunches(state);
  }

  #reportLostOutput(state: RemoteProducerBinding): void {
    if (state.lostOutputReported) return;
    state.lostOutputReported = true;
    this.#emit({ binding: state.ref, event: { type: 'publication-gap' } });
  }

  #retireFailed(state: RemoteProducerBinding): void {
    this.#forgetBinding(state.ref.id);
    this.#failedBindings.set(state.ref.id, state.backing);
  }

  // Undecodable rows count as lost output. Any other event the controller cannot read,
  // such as a permission request or a launch outcome, leaves its run's state unknown, so
  // the binding fails, and closing it stops the native turn. Throwing instead would retire
  // the session, interrupting every binding it carries, and a failure that recurs on
  // replayed events would retire each replacement in turn.
  #decode(
    event: AgentProducerNotification['event'],
    scope: AgentResourceScope,
    binding: AgentProducerBinding,
    seq: number,
  ): AgentProducerNotification['event'] {
    try {
      return decodeProducerEvent(event, scope);
    } catch (error) {
      const type = typeof event?.type === 'string' ? event.type : 'unknown';
      this.#log.warn('Executor producer event could not be decoded', {
        integrationId: this.descriptor.id, bindingId: binding.id, seq, type, reason: failureReason(error),
      });
      return type === 'rows'
        ? { type: 'publication-gap' }
        : { type: 'publication-failed', error: UNREADABLE_EVENT_FAILURE };
    }
  }

  // Settles launches whose replies were lost once the replay reaches the
  // worker's resume report, so every event it published earlier, such as a
  // run's end, is applied first. A launch the worker has not finished reports
  // its own outcome on the binding later. A launch the worker never received
  // is sent again once on the replacement session; one it received that left
  // no record failed before its reply was lost, so it is not repeated.
  #settleLostLaunches(state: RemoteProducerBinding): void {
    const pending = state.resumeReport;
    if (!pending || state.receivedSeq < pending.report.replayThroughSeq) return;
    state.resumeReport = null;
    for (const runId of pending.runIds) {
      const lost = state.unsettledLaunches.get(runId);
      if (!lost) continue;
      const launch = pending.report.launch?.runId === runId ? pending.report.launch : null;
      if (launch && !launch.handle) continue;
      if (!launch && lost.send && !pending.report.receivedRunIds.includes(runId)) {
        this.#relaunch(state, runId, lost, lost.send);
        continue;
      }
      this.#forgetLaunch(state, runId);
      this.#emit({ binding: state.ref, event: launch?.handle
        ? { type: 'launch-settled', runId, handle: launch.handle }
        : { type: 'launch-settled', runId, error: EXECUTOR_DISCONNECTED_BEFORE_START } });
    }
  }

  // Its outcome settles the run like a lost launch's. If this reply is lost too,
  // the next resume report settles the run without sending it again.
  #relaunch(
    state: RemoteProducerBinding, runId: string, lost: UnsettledLaunch,
    send: (backing: RemoteSessionBacking) => Promise<AgentExecutionHandle>,
  ): void {
    lost.send = null;
    const settle = (event: Extract<AgentProducerNotification['event'], { readonly type: 'launch-settled' }>) => {
      if (state.unsettledLaunches.get(runId) !== lost) return;
      this.#forgetLaunch(state, runId);
      this.#emit({ binding: state.ref, event });
    };
    void send(state.backing).then(
      (handle) => settle({ type: 'launch-settled', runId, handle }),
      (error: unknown) => {
        if (!(error instanceof AgentCallError && error.outcome === 'unknown')) settle({ type: 'launch-settled', runId, error: failureDetail(error) });
      },
    );
  }

  #forgetLaunch(state: RemoteProducerBinding, runId: string): void {
    state.unsettledLaunches.get(runId)?.release();
    state.unsettledLaunches.delete(runId);
  }

  #forgetBinding(id: string): void {
    const state = this.#bindings.get(id);
    if (!state) return;
    for (const lost of state.unsettledLaunches.values()) lost.release();
    this.#bindings.delete(id);
  }

  // A listener that throws would otherwise retire the session delivering the event,
  // interrupting every binding it carries, and starve the listeners after it.
  #emit(notification: AgentProducerNotification): void {
    for (const listener of this.#listeners) {
      try {
        listener(notification);
      } catch (error) {
        this.#log.error('Executor producer listener failed', {
          integrationId: this.descriptor.id, bindingId: notification.binding.id,
          type: notification.event.type, reason: failureReason(error),
        });
      }
    }
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

function isResumeState(value: unknown, scope: AgentResourceScope): value is ProducerResumeState {
  const report = value as Partial<ProducerResumeState> | null;
  const launch = report?.launch;
  return typeof report?.bindingId === 'string' && Number.isSafeInteger(report.replayThroughSeq) && report.replayThroughSeq! >= 0
    && (launch === null || (typeof launch?.runId === 'string'
      && (launch.handle === null || isAgentResourceRef(launch.handle, 'execution', scope))))
    && Array.isArray(report.receivedRunIds) && report.receivedRunIds.every((runId) => typeof runId === 'string');
}

// Rebuilds a producer event received from the worker; throws when it is malformed.
function decodeProducerEvent(
  event: AgentProducerNotification['event'],
  scope: AgentResourceScope,
): AgentProducerNotification['event'] {
  if (event.type === 'publication-failed') {
    if (!isFailureDetail(event.error)) throw new Error('Invalid producer publication failure');
    return event;
  }
  if (event.type === 'launch-settled') {
    if (typeof event.runId !== 'string' || (event.handle ? !isAgentResourceRef(event.handle, 'execution', scope) : !isFailureDetail(event.error))) {
      throw new Error('Invalid launch outcome');
    }
    return event;
  }
  if (event.type === 'rows') return { ...event, rows: decodeRows(event.rows) };
  if (event.type === 'permission' && event.lifecycle.kind === 'requested') {
    const tool = decodeMessage(event.lifecycle.requestedTool);
    if (!isToolUseMessage(tool)) throw new Error('Invalid permission tool');
    if (!event.decision) throw new Error('Permission response capability is missing');
    return { type: 'permission', runId: event.runId, lifecycle: { ...event.lifecycle, requestedTool: tool }, decision: event.decision };
  }
  return event;
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
