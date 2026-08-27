// OpenCode SDK integration. Each provider operation owns its transcript publisher.

import crypto from 'crypto';
import { isRecord } from '@garcon/common/json';
import { errorMessage } from '@garcon/server-agent-common/lib/errors';
import { buildPromptBody, parseOpenCodeModel } from './prompt.js';
import {
  extractSessionId,
  extractTextParts,
  isOpenCodeCompactionAssistant,
  isOpenCodeCompactionContinuationPart,
  isOpenCodeCompactionControlPart,
  isOpenCodeManualCompactionControlPart,
  openCodeAssistantTerminal,
  openCodeRetryNotice,
  type OpenCodeAssistantTerminal,
  type SSEEvent,
} from './sse-events.js';
import {
  acceptUniqueOpenCodeTurnEvent,
  createOpenCodeTurnContext,
  openCodeEventBelongsToTurn,
  type OpenCodeSession,
  type OpenCodeTurnContext,
} from './turn-events.js';
import { CompactionMessage, ErrorMessage } from '@garcon/common/chat-types';
import { attachNativeMessageSource } from '@garcon/server-agent-common/shared/native-message-source';
import {
  runtimeRows,
  type AgentRuntimeEvent,
  type AgentRuntimeOperation,
} from '@garcon/server-agent-common/execution/runtime-events';
import type { OpenCodeConfig } from '../../config.js';
import { normalizeThinkingMode, type PermissionMode, type ThinkingMode } from '@garcon/common/chat-modes';
import {
  assertOpenCodeExecutionOpen,
  markOpenCodeExecutionStarted,
  type OpenCodeExecutionAdmission,
  type OpenCodeResumeRequest,
  type OpenCodeSessionSettingsPatch,
  type OpenCodeStartRequest,
} from './runtime-types.js';
import {
  createOpenCodeRequestScope,
  isOpenCodeNotFoundResult,
  throwOpenCodeResultError,
  withOpenCodeRequestScope,
  type OpenCodeRequestScope,
} from './sdk-result.js';
import {
  AgentIntegrationError,
  type AgentLogger,
} from '@garcon/server-agent-interface';
import { OpenCodeEndpointCoordinator } from './endpoint-coordinator.js';
import { OpenCodeGlobalEventListener } from './global-event-listener.js';
import {
  closeOpenCodeInstance,
  OpenCodeInstanceCreationTracker,
  type OpenCodeInstance,
  type OpenCodeServerTermination,
} from './instance-lifecycle.js';
import { withSingleQueryControl } from '@garcon/server-agent-common/shared/single-query-control';
import {
  OpenCodeTimeoutError,
  withAbortableTimeout,
} from './request-control.js';
import { convertOpenCodeEventToChatMessages } from './event-converter.js';
import { OpenCodeSteeringController } from './steering.js';
import { OpenCodeModelDiscovery } from './model-discovery.js';
import { resolveOpenCodeThinkingVariant } from './thinking-variant.js';
import {
  OpenCodeOperationRoutes,
  type OpenCodeOperationEventSource,
  type OpenCodeOperationRoute,
} from './operation-routes.js';
import {
  OpenCodeDecisionController,
  mapPermissionMode,
} from './permissions.js';
import { createOpenCodeInstance } from './server-instance.js';
import {
  configuredProvidersFromResult,
  connectedProvidersFromListResult,
  modelsFromProviders,
  type OpenCodeModelOption,
} from './model-catalog.js';
import { adoptOpenCodeCompactionPartRoute, manualCompactionBoundaryRow } from './compaction-routing.js';
import { OpenCodeIdleLifecycle } from './idle-lifecycle.js';

const SILENT_LOGGER: AgentLogger = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
});

// Matches OpenCode's own subprocess harness: cold starts of the platform binary are
// dominated by transpile and plugin init, not the listen() call.
// https://github.com/anomalyco/opencode/blob/49c69c5ed3ccf706b61b3febb43c8aaff7f8325e/packages/opencode/test/lib/cli-process.ts#L363
const DEFAULT_OPENCODE_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_OPENCODE_MODEL_DISCOVERY_TIMEOUT_MS = 3_000;
const DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_OPENCODE_UNAVAILABLE_RETRY_MS = 60_000;
const DEFAULT_OPENCODE_SSE_RETRY_DELAY_MS = 3_000;
const RETAINED_SESSION_DELETION_LIMIT = 256;
const DEFAULT_OPENCODE_SSE_HEARTBEAT_TIMEOUT_MS = 30_000;
const DEFAULT_OPENCODE_MODEL_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_OPENCODE_SHUTDOWN_STARTUP_GRACE_MS = 100;

interface PendingTurnWaiter {
  promise: Promise<Error | null>;
  settle: (failure: Error | null) => void;
}

interface OpenCodeRuntimeOptions {
  config?: OpenCodeConfig;
  logger?: AgentLogger;
  startupTimeoutMs?: number;
  modelDiscoveryTimeoutMs?: number;
  requestTimeoutMs?: number;
  unavailableRetryMs?: number;
  sseRetryDelayMs?: number;
  sseHeartbeatTimeoutMs?: number;
  modelCacheTtlMs?: number;
  shutdownStartupGraceMs?: number;
  idleRetirementDelayMs?: number;
  idleRetirementCheckIntervalMs?: number;
  now?: () => number;
  createInstance?: (input: {
    signal: AbortSignal;
  }) => Promise<OpenCodeInstance>;
}

interface NormalizedOpenCodeRuntimeOptions {
  startupTimeoutMs: number;
  modelDiscoveryTimeoutMs: number;
  requestTimeoutMs: number;
  unavailableRetryMs: number;
  sseRetryDelayMs: number;
  sseHeartbeatTimeoutMs: number;
  modelCacheTtlMs: number;
  shutdownStartupGraceMs: number;
  now: () => number;
  requiresExecutable: boolean;
  createInstance: (input: {
    signal: AbortSignal;
  }) => Promise<OpenCodeInstance>;
}

function normalizeOptions(options: OpenCodeRuntimeOptions): NormalizedOpenCodeRuntimeOptions {
  return {
    startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_OPENCODE_STARTUP_TIMEOUT_MS,
    modelDiscoveryTimeoutMs: options.modelDiscoveryTimeoutMs ?? DEFAULT_OPENCODE_MODEL_DISCOVERY_TIMEOUT_MS,
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS,
    unavailableRetryMs: options.unavailableRetryMs ?? DEFAULT_OPENCODE_UNAVAILABLE_RETRY_MS,
    sseRetryDelayMs: options.sseRetryDelayMs ?? DEFAULT_OPENCODE_SSE_RETRY_DELAY_MS,
    sseHeartbeatTimeoutMs:
      options.sseHeartbeatTimeoutMs ?? DEFAULT_OPENCODE_SSE_HEARTBEAT_TIMEOUT_MS,
    modelCacheTtlMs: options.modelCacheTtlMs ?? DEFAULT_OPENCODE_MODEL_CACHE_TTL_MS,
    shutdownStartupGraceMs:
      options.shutdownStartupGraceMs ?? DEFAULT_OPENCODE_SHUTDOWN_STARTUP_GRACE_MS,
    now: options.now ?? (() => Date.now()),
    requiresExecutable: options.createInstance === undefined,
    createInstance: options.createInstance ?? createOpenCodeInstance,
  };
}

export class OpenCodeRuntime {
  readonly #config: OpenCodeConfig;
  readonly #logger: AgentLogger;
  #instance: OpenCodeInstance | null = null;
  // Bumped on every instance transition so availability reports can be
  // generation-tagged: reports from a retired generation are ignored.
  #instanceGeneration = 0;
  // Instances Garcon itself closed; their termination callbacks must leave the
  // availability cooldown intact instead of disarming it.
  readonly #deliberatelyClosed = new WeakSet<OpenCodeInstance>();
  // Sessions whose deletion failed through a dead endpoint; replayed once the
  // next instance is installed, because native sessions persist in the
  // provider database across respawns.
  #pendingSessionDeletions: Array<{ sessionId: string; scope: OpenCodeRequestScope }> = [];
  #initPromise: Promise<OpenCodeInstance> | null = null;
  #startupAbortController: AbortController | null = null;
  #shutdownPromise: Promise<void> | null = null;
  #shuttingDown = false;
  #sessions = new Map<string, OpenCodeSession>();
  #pendingSessionAborts = new WeakMap<OpenCodeSession, Promise<boolean>>();
  #pendingTurnWaiters = new Map<string, PendingTurnWaiter>();
  readonly #decisions: OpenCodeDecisionController;
  readonly steering: OpenCodeSteeringController;
  readonly #endpointCoordinator: OpenCodeEndpointCoordinator;
  readonly #globalEventListener: OpenCodeGlobalEventListener;
  readonly #operationRoutes: OpenCodeOperationRoutes;
  readonly #models: OpenCodeModelDiscovery;
  readonly #idleLifecycle: OpenCodeIdleLifecycle;
  #unavailableUntil = 0;
  #unavailableReason = '';
  readonly #instanceCreations: OpenCodeInstanceCreationTracker;

  #available: boolean | null = null;
  readonly #options: NormalizedOpenCodeRuntimeOptions;

  constructor(options: OpenCodeRuntimeOptions = {}) {
    this.#config = options.config ?? { isTestEnvironment: () => false };
    this.#logger = options.logger ?? SILENT_LOGGER;
    this.#operationRoutes = new OpenCodeOperationRoutes(this.#logger);
    this.#options = normalizeOptions(options);
    this.#decisions = new OpenCodeDecisionController({
      logger: this.#logger,
      publish: (agentSessionId, operation, event) => this.#publish(
        agentSessionId,
        operation,
        event,
      ),
      getClient: () => this.getClient(),
      runScopedRequest: (label, scope, operation) => (
        this.#runScopedSessionRequest(label, scope, operation)
      ),
      getSession: (agentSessionId) => this.#sessions.get(agentSessionId),
      failTurn: (agentSessionId, session, message) => (
        this.#failTurnForProviderError(agentSessionId, session, message)
      ),
    });
    this.#instanceCreations = new OpenCodeInstanceCreationTracker(() => this.#shuttingDown);
    this.#models = new OpenCodeModelDiscovery({
      cacheTtlMs: this.#options.modelCacheTtlMs,
      discoveryTimeoutMs: this.#options.modelDiscoveryTimeoutMs,
      logger: this.#logger,
      withClientLease: (operation) => this.withClientLease(operation),
      isAvailable: () => this.isAvailable(),
      isTemporarilyUnavailable: () => this.isTemporarilyUnavailable(),
      instanceGeneration: () => this.#instanceGeneration,
      markAvailable: (sourceGeneration) => this.#markAvailable(sourceGeneration),
      markTemporarilyUnavailable: (reason, sourceGeneration) => (
        this.#markTemporarilyUnavailable(reason, sourceGeneration)
      ),
      now: () => this.#now(),
    });
    this.#idleLifecycle = new OpenCodeIdleLifecycle({
      logger: this.#logger,
      sessions: () => this.#sessions.entries(),
      purgeSession: (sessionId) => { this.#sessions.delete(sessionId); },
      hasInstance: () => this.#instance !== null,
      hasStartup: () => this.#initPromise !== null,
      endpointIdle: () => this.#endpointCoordinator.idle,
      routesIdle: () => this.#operationRoutes.idle,
      decisionsIdle: () => this.#decisions.idle,
      hasPendingTurnWaiters: () => this.#pendingTurnWaiters.size > 0,
      isShuttingDown: () => this.#shuttingDown,
      runTransition: (operation) => this.#endpointCoordinator.runTransition(operation),
      invalidateModels: () => this.#models.invalidate(),
      closeInstance: () => this.#closeInstance(),
      now: () => this.#now(),
      retirementDelayMs: options.idleRetirementDelayMs,
      retirementCheckIntervalMs: options.idleRetirementCheckIntervalMs,
    });
    this.#endpointCoordinator = new OpenCodeEndpointCoordinator({
      assertAvailable: () => this.#assertCanUseOpenCode(),
      ensureUnlocked: () => this.#ensureOpenCodeServerUnlocked(),
      logger: this.#logger,
      onActivity: () => this.#idleLifecycle.recordActivity(),
    });
    this.#globalEventListener = new OpenCodeGlobalEventListener({
      requestTimeoutMs: this.#options.requestTimeoutMs,
      heartbeatTimeoutMs: this.#options.sseHeartbeatTimeoutMs,
      retryDelayMs: this.#options.sseRetryDelayMs,
      logger: this.#logger,
      getClient: () => this.getClient(),
      isShuttingDown: () => this.#shuttingDown,
      isTemporarilyUnavailable: () => this.isTemporarilyUnavailable(),
      getUnavailableRetryAfterMs: () => this.getUnavailableRetryAfterMs(),
      instanceGeneration: () => this.#instanceGeneration,
      markTemporarilyUnavailable: (reason, sourceGeneration) => (
        this.#markTemporarilyUnavailable(reason, sourceGeneration)
      ),
      failRunningTurns: (error) => this.#failRunningTurnsForListenerError(error),
      closeUnavailableInstanceIfIdle: () => this.#idleLifecycle.closeInstanceIfIdle(),
      confirmEventDelivery: this.#options.requiresExecutable
        ? (input) => this.#confirmGlobalEventDelivery(input)
        : async () => undefined,
      handleEvent: (client, event) => this.#handleGlobalSSEEvent(client, event),
    });
    this.steering = new OpenCodeSteeringController({
      requestTimeoutMs: this.#options.requestTimeoutMs,
      getSession: (agentSessionId) => this.#sessions.get(agentSessionId),
      getClient: () => this.getClient(),
      runScopedRequest: (label, scope, operation) => (
        this.#runScopedSessionRequest(label, scope, operation)
      ),
      releaseDeferredTerminal: (agentSessionId, session) => (
        this.#releaseDeferredTerminal(agentSessionId, session)
      ),
      bindOperationPart: (turn, partId) => this.#operationRoutes.bindPart(turn, partId),
      unbindOperationPart: (turn, partId) => this.#operationRoutes.unbindPart(turn, partId),
    });
  }

  // Shuts down the spawned opencode server process (if any).
  // Called during garcon graceful shutdown to prevent orphaned processes.
  shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#shuttingDown = true;
    this.#idleLifecycle.stop();
    for (const agentSessionId of this.#pendingTurnWaiters.keys()) {
      this.#rejectTurnWaiter(agentSessionId, new Error('OpenCode runtime shutting down'));
    }
    this.#sessions.clear();
    this.#decisions.clear();
    const startup = this.#initPromise;
    this.#startupAbortController?.abort(new Error('OpenCode runtime shutting down'));
    this.#closeInstance();
    const shutdown = (async () => {
      await startup?.catch(() => undefined);
      await this.#instanceCreations.waitForCleanup(this.#options.shutdownStartupGraceMs);
      this.#closeInstance();
    })();
    this.#shutdownPromise = shutdown;
    return shutdown;
  }

  // Returns whether an OpenCode instance can be created without starting one.
  isAvailable(): boolean {
    if (this.#available !== null) return this.#available;
    if (!this.#options.requiresExecutable || this.#config.isTestEnvironment()) {
      this.#available = true;
      return true;
    }
    if (typeof Bun !== 'undefined' && typeof Bun.which === 'function') {
      this.#available = Boolean(Bun.which('opencode'));
    } else {
      this.#available = false;
    }
    return this.#available;
  }

  isTemporarilyUnavailable(): boolean {
    return this.#unavailableRemainingMs() > 0;
  }

  getUnavailableReason(): string {
    return this.isTemporarilyUnavailable() ? this.#unavailableReason : '';
  }

  getUnavailableRetryAfterMs(): number {
    return this.#unavailableRemainingMs();
  }

  #now(): number {
    return this.#options.now();
  }

  #unavailableRemainingMs(): number {
    return Math.max(0, this.#unavailableUntil - this.#now());
  }

  #temporaryUnavailableError(): Error {
    const reason = this.getUnavailableReason();
    const retrySeconds = Math.ceil(this.#unavailableRemainingMs() / 1000);
    const suffix = retrySeconds > 0 ? ` Retry in ${retrySeconds}s.` : '';
    return new Error(`OpenCode is temporarily unavailable${reason ? `: ${reason}` : ''}.${suffix}`);
  }

  #assertCanUseOpenCode(): void {
    if (this.#shuttingDown) throw new Error('OpenCode runtime is shutting down');
    if (!this.isAvailable()) throw new Error('opencode is not installed');
    if (this.isTemporarilyUnavailable()) throw this.#temporaryUnavailableError();
  }

  #markAvailable(sourceGeneration?: number): void {
    if (sourceGeneration !== undefined && sourceGeneration !== this.#instanceGeneration) return;
    this.#unavailableUntil = 0;
    this.#unavailableReason = '';
  }

  #markTemporarilyUnavailable(reason: string, sourceGeneration?: number): boolean {
    // A report about a retired generation must not poison the current one: a
    // late timeout from a dead instance never arms a cooldown the replacement
    // has to wait out.
    if (sourceGeneration !== undefined && sourceGeneration !== this.#instanceGeneration) {
      return false;
    }
    const now = this.#now();
    const wasAvailable = this.#unavailableRemainingMs() === 0;
    const reasonChanged = this.#unavailableReason !== reason;
    this.#unavailableReason = reason;
    this.#unavailableUntil = now + this.#options.unavailableRetryMs;
    this.#idleLifecycle.closeInstanceIfIdle();
    return wasAvailable || reasonChanged;
  }

  #closeInstance(): void {
    // Null before killing the process so the resulting termination callback finds a
    // stale identity and is ignored.
    const instance = this.#instance;
    this.#instance = null;
    this.#instanceGeneration += 1;
    this.#globalEventListener.close();
    this.#operationRoutes.clear();
    if (instance) {
      // Killing a still-live process must preserve the availability cooldown
      // that prompted the close; an already-exited process keeps death
      // semantics so the termination handler disarms the cooldown.
      if (instance.server?.exitObserved && !instance.server.exitObserved()) {
        this.#deliberatelyClosed.add(instance);
      }
      closeOpenCodeInstance(instance);
    }
  }

  // Subscribes to the instance's process-lifetime termination signal. The instance
  // object itself is the generation token: a late callback from a deliberately closed
  // or replaced instance finds a different #instance and is ignored.
  // Fences admissions that captured an instance which was retired mid-flight: after every
  // await that can cross a termination transition, the captured identity must still be
  // current before sessions are registered, activations are published, or prompts are
  // sent through the captured client.
  #assertInstanceCurrent(instance: OpenCodeInstance): void {
    if (this.#instance !== instance) {
      throw new Error('OpenCode server process was retired while the request was in flight');
    }
  }

  #watchServerTermination(instance: OpenCodeInstance): void {
    const termination = instance.server?.termination;
    if (!termination) return;
    void termination.then((outcome) => this.#handleServerTermination(instance, outcome));
  }

  #handleServerTermination(
    instance: OpenCodeInstance,
    outcome: OpenCodeServerTermination,
  ): void {
    void this.#endpointCoordinator.runTransition(async () => {
      if (this.#shuttingDown) return;
      if (this.#deliberatelyClosed.has(instance)) {
        // Garcon closed this instance on purpose, most often to honor an
        // availability cooldown: the resulting exit must not disarm it.
        return;
      }
      if (this.#instance !== instance) {
        // The instance was already retired, but its death still invalidates any cooldown
        // armed by failures in its death window while no replacement is installed. A
        // failed replacement startup re-arms the cooldown on its own ensure path.
        if (this.#instance === null) this.#markAvailable();
        return;
      }
      const detail = outcome.kind === 'exit'
        ? `code ${outcome.code ?? outcome.signal ?? 'unknown'}`
        : errorMessage(outcome.error);
      this.#logger.warn('OpenCode server process terminated; retiring the instance', { detail });
      // Death is authoritative, unlike an SSE failure: retire the dead endpoint
      // immediately regardless of in-flight admissions or leases, fail active
      // turns, and leave the cooldown disarmed so the next demand respawns at
      // once. A failed replacement startup still arms the cooldown through the
      // ensure path.
      this.#failRunningTurnsForServerDeath(
        new Error(`OpenCode server process terminated unexpectedly (${detail})`),
      );
      this.#closeInstance();
      this.#markAvailable();
    }).catch((error) => {
      this.#logger.error('OpenCode server termination handling failed', {
        error: errorMessage(error),
      });
    });
  }

  // Death leaves no provider work behind, unlike an SSE failure: sessions stop
  // without quiescence so the idle purger can reclaim them, while steering
  // cleanup staging survives for the next turn.
  #failRunningTurnsForServerDeath(failure: Error): void {
    for (const [agentSessionId, session] of this.#sessions) {
      if (session.status !== 'running') continue;
      this.steering.stagePendingCleanup(session);
      session.providerWorkRequiresQuiescence = false;
      session.status = 'completed';
      session.lastActivityAt = Date.now();
      this.#operationRoutes.cancelRequest(session.turn, failure);
      this.#decisions.cancelForSession(agentSessionId, 'cancelled');
      this.#rejectTurnWaiter(agentSessionId, failure);
      this.#publishFailed(agentSessionId, session.turn.operation, failure.message);
    }
    for (const agentSessionId of this.#pendingTurnWaiters.keys()) {
      this.#rejectTurnWaiter(agentSessionId, failure);
    }
  }

  // Deletes a native session when possible and retains the deletion for the
  // next instance otherwise: the provider persists sessions in its own
  // database, so a leak survives the respawn. A not-found result means the
  // session is already gone and satisfies the deletion.
  // Deletes a native session when possible and retains the deletion for the
  // next instance otherwise: the provider persists sessions in its own
  // database, so a leak survives the respawn. A not-found result means the
  // session is already gone and satisfies the deletion. Cleanup carrying a
  // retired generation never contacts the stale client: a hanging deletion
  // through a dead endpoint would time out against the current generation and
  // wrongly arm the cooldown the death path just disarmed.
  async #deleteSessionBestEffort(
    sessionId: string,
    scope: OpenCodeRequestScope,
    cleanup: { client?: any; generation?: number } = {},
  ): Promise<void> {
    const retired = cleanup.generation !== undefined
      && cleanup.generation !== this.#instanceGeneration;
    const deleteThrough = retired ? null : (cleanup.client ?? (() => this.getClientIfInitialized())());
    if (!deleteThrough) {
      this.#retainSessionDeletion(sessionId, scope);
      return;
    }
    try {
      const result = await this.#runScopedSessionRequest(
        'OpenCode cancelled session delete',
        scope,
        (signal, requestScope) => deleteThrough.session.delete(
          withOpenCodeRequestScope({ sessionID: sessionId }, requestScope),
          { signal },
        ),
      );
      if (!isOpenCodeNotFoundResult(result)) {
        throwOpenCodeResultError(result, 'OpenCode cancelled session delete failed');
      }
    } catch {
      this.#retainSessionDeletion(sessionId, scope);
    }
  }

  // Retained deletions stay keyed by session id so repeated failures for one
  // session cannot accumulate, and the queue stays bounded: a provider that
  // never accepts deletions must not grow Garcon's memory without limit.
  #retainSessionDeletion(sessionId: string, scope: OpenCodeRequestScope): void {
    const existing = this.#pendingSessionDeletions.findIndex((entry) => entry.sessionId === sessionId);
    if (existing >= 0) this.#pendingSessionDeletions.splice(existing, 1);
    if (this.#pendingSessionDeletions.length >= RETAINED_SESSION_DELETION_LIMIT) {
      this.#logger.warn('Discarding an OpenCode retained session deletion at capacity', {
        sessionId,
        retained: this.#pendingSessionDeletions.length,
      });
      return;
    }
    this.#pendingSessionDeletions.push({ sessionId, scope });
  }

  // Replays retained deletions through the freshly installed instance. Each
  // attempt is best-effort: a failed replay stays retained for the next one.
  #drainPendingSessionDeletions(): void {
    if (this.#pendingSessionDeletions.length === 0) return;
    const pending = this.#pendingSessionDeletions.splice(0);
    for (const { sessionId, scope } of pending) {
      void this.withClientLease(async (client) => {
        const result = await this.#runScopedSessionRequest(
          'OpenCode retained session delete',
          scope,
          (signal, requestScope) => client.session.delete(
            withOpenCodeRequestScope({ sessionID: sessionId }, requestScope),
            { signal },
          ),
        );
        if (!isOpenCodeNotFoundResult(result)) {
          throwOpenCodeResultError(result, 'OpenCode retained session delete failed');
        }
      }).catch(() => {
        this.#retainSessionDeletion(sessionId, scope);
      });
    }
  }

  #createTurnWaiter(agentSessionId: string): PendingTurnWaiter {
    if (this.#pendingTurnWaiters.has(agentSessionId)) {
      throw new Error(`Turn already in progress for session ${agentSessionId}`);
    }
    let settle!: (failure: Error | null) => void;
    const promise = new Promise<Error | null>((resolve) => {
      settle = resolve;
    });
    const waiter: PendingTurnWaiter = { promise, settle };
    this.#pendingTurnWaiters.set(agentSessionId, waiter);
    return waiter;
  }

  #resolveTurnWaiter(agentSessionId: string): void {
    const waiter = this.#pendingTurnWaiters.get(agentSessionId);
    if (!waiter) return;
    this.#pendingTurnWaiters.delete(agentSessionId);
    waiter.settle(null);
  }

  #rejectTurnWaiter(agentSessionId: string, error: unknown): void {
    const waiter = this.#pendingTurnWaiters.get(agentSessionId);
    if (!waiter) return;
    this.#pendingTurnWaiters.delete(agentSessionId);
    waiter.settle(error instanceof Error ? error : new Error(String(error || 'OpenCode turn failed')));
  }

  #publish(
    agentSessionId: string,
    operation: AgentRuntimeOperation,
    event: AgentRuntimeEvent,
  ): void {
    try {
      operation.publish(event);
    } catch (error) {
      this.#logger.warn('OpenCode publisher rejected an event', {
        agentSessionId,
        eventType: event.type,
        error: errorMessage(error),
      });
    }
  }

  #publishRows(
    agentSessionId: string,
    operation: AgentRuntimeOperation,
    messages: Parameters<typeof runtimeRows>[0],
  ): void {
    if (messages.length === 0) return;
    this.#publish(agentSessionId, operation, { type: 'rows', rows: runtimeRows(messages) });
  }

  #publishFinished(agentSessionId: string, operation: AgentRuntimeOperation): void {
    this.#publish(agentSessionId, operation, {
      type: 'run-ended',
      runId: operation.runId,
      outcome: 'finished',
    });
  }

  #publishFailed(
    agentSessionId: string,
    operation: AgentRuntimeOperation,
    message: string,
  ): void {
    this.#publish(agentSessionId, operation, {
      type: 'run-ended',
      runId: operation.runId,
      outcome: 'failed',
      error: { code: 'PROVIDER_FAILURE', message },
    });
  }

  #failRunningTurnsForListenerError(error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error));
    for (const [agentSessionId, session] of this.#sessions) {
      if (session.status !== 'running') continue;
      this.steering.stagePendingCleanup(session);
      session.providerWorkRequiresQuiescence = true;
      session.status = 'completed';
      session.lastActivityAt = Date.now();
      this.#operationRoutes.cancelRequest(session.turn, failure);
      this.#decisions.cancelForSession(agentSessionId, 'cancelled');
      this.#rejectTurnWaiter(agentSessionId, failure);
      this.#publishFailed(agentSessionId, session.turn.operation, failure.message);
    }
    for (const agentSessionId of this.#pendingTurnWaiters.keys()) {
      this.#rejectTurnWaiter(agentSessionId, failure);
    }
  }

  #failTurnForProviderError(agentSessionId: string, session: OpenCodeSession, message: string): void {
    this.steering.stagePendingCleanup(session);
    session.providerWorkRequiresQuiescence = true;
    session.status = 'completed';
    session.lastActivityAt = Date.now();
    this.#decisions.cancelForSession(agentSessionId, 'cancelled');
    this.#rejectTurnWaiter(agentSessionId, new Error(message));
    // OpenCode stores a failed turn's provider error on its in-flight assistant
    // message, whose id the native loader uses as the error occurrence's
    // identity. Carrying that same id on the live error keeps one canonical
    // occurrence across live and restart rather than a duplicate.
    const failedMessageId = lastValue(session.turn.assistantMessageIds);
    const errorRow = new ErrorMessage(new Date().toISOString(), message);
    this.#publishRows(
      agentSessionId,
      session.turn.operation,
      [failedMessageId ? attachNativeMessageSource(errorRow, { entryId: failedMessageId }) : errorRow],
    );
    this.#publishFailed(agentSessionId, session.turn.operation, message);
  }

  #failPromptRequest(route: OpenCodeOperationRoute, error: unknown): void {
    const session = this.#sessions.get(route.sessionId);
    if (
      !this.#operationRoutes.isRegistered(route)
      || !session
      || session.status !== 'running'
      || session.turn !== route.turn
    ) {
      if (this.isTemporarilyUnavailable()) this.#idleLifecycle.closeInstanceIfIdle();
      return;
    }
    const providerTerminal = lastValue(route.turn.assistantTerminals.values());
    if (providerTerminal?.outcome === 'failed') {
      this.#failTurnForProviderError(route.sessionId, session, providerTerminal.error);
      if (this.isTemporarilyUnavailable()) this.#idleLifecycle.closeInstanceIfIdle();
      return;
    }
    const message = errorMessage(error);
    this.#logger.error('OpenCode prompt failed', {
      agentSessionId: route.sessionId,
      error: message,
    });
    this.steering.stagePendingCleanup(session);
    session.providerWorkRequiresQuiescence = true;
    session.status = 'completed';
    session.lastActivityAt = Date.now();
    this.#decisions.cancelForSession(route.sessionId, 'cancelled');
    this.#rejectTurnWaiter(route.sessionId, error);
    this.#publishFailed(route.sessionId, route.turn.operation, message);
    if (this.isTemporarilyUnavailable()) this.#idleLifecycle.closeInstanceIfIdle();
  }

  #settleTurnTerminal(
    agentSessionId: string,
    session: OpenCodeSession,
    terminal: OpenCodeAssistantTerminal,
  ): void {
    if (session.status !== 'running') return;
    if (session.aborting || session.activeSteeringDeliveries > 0) {
      session.deferredTerminal = terminal;
      return;
    }
    session.deferredTerminal = null;
    if (terminal.outcome === 'aborted') {
      this.#logger.debug('Ignoring OpenCode abort unwind for a Garcon-retired turn', {
        agentSessionId,
        messageId: terminal.messageId,
      });
      return;
    }
    if (session.turn.pendingSteeringMessageIds.size > 0) {
      this.#failTurnForProviderError(
        agentSessionId,
        session,
        'OpenCode stopped before processing accepted steering input',
      );
      return;
    }
    if (terminal.outcome === 'failed') {
      this.#failTurnForProviderError(agentSessionId, session, terminal.error);
      return;
    }
    this.#decisions.cancelForSession(agentSessionId, 'session-complete');
    session.status = 'completed';
    session.lastActivityAt = Date.now();
    this.#resolveTurnWaiter(agentSessionId);
    this.#publishFinished(agentSessionId, session.turn.operation);
  }

  #releaseDeferredTerminal(agentSessionId: string, session: OpenCodeSession): void {
    if (session.aborting || session.activeSteeringDeliveries > 0) return;
    const terminal = session.deferredTerminal;
    if (!terminal) return;
    session.deferredTerminal = null;
    this.#settleTurnTerminal(agentSessionId, session, terminal);
  }

  #clearTurnWaiter(agentSessionId: string): void {
    this.#pendingTurnWaiters.delete(agentSessionId);
  }

  async #ensureOpenCodeServer(): Promise<OpenCodeInstance> {
    return this.#endpointCoordinator.runTransition(() => this.#ensureOpenCodeServerUnlocked());
  }

  async #ensureOpenCodeServerUnlocked(): Promise<OpenCodeInstance> {
    if (this.#instance) return this.#instance;
    if (this.#initPromise) return this.#initPromise;
    this.#assertCanUseOpenCode();

    let startup: Promise<OpenCodeInstance> | null = null;
    const startupAbortController = new AbortController();
    this.#startupAbortController = startupAbortController;
    startup = (async () => {
      try {
        if (this.#options.requiresExecutable
            && typeof Bun !== 'undefined' && typeof Bun.which === 'function'
            && !this.#config.isTestEnvironment() && !Bun.which('opencode')) {
          throw new Error('opencode executable not found in $PATH');
        }

        const result: OpenCodeInstance = await withAbortableTimeout(
          (signal) => this.#instanceCreations.track(
            () => this.#options.createInstance({ signal }),
            signal,
          ),
          this.#options.startupTimeoutMs,
          'OpenCode startup',
          startupAbortController.signal,
        );

        if (this.#shuttingDown || startupAbortController.signal.aborted) {
          closeOpenCodeInstance(result);
          throw startupAbortController.signal.reason ?? new Error('OpenCode runtime is shutting down');
        }

        if (!result?.client?.permission?.reply) {
          closeOpenCodeInstance(result);
          throw new Error('OpenCode v2 client missing permission.reply; aborting startup');
        }

        this.#instance = result;
        this.#instanceGeneration += 1;
        this.#idleLifecycle.recordActivity();
        this.#watchServerTermination(result);
        this.#markAvailable();
        this.#drainPendingSessionDeletions();
        return result;
      } catch (err) {
        const reason = errorMessage(err);
        if (this.#markTemporarilyUnavailable(reason)) {
          this.#logger.warn('OpenCode marked unavailable after startup failure', { reason });
        }
        throw err;
      } finally {
        if (this.#initPromise === startup) this.#initPromise = null;
        if (this.#startupAbortController === startupAbortController) {
          this.#startupAbortController = null;
        }
      }
    })();

    this.#initPromise = startup;
    return this.#initPromise;
  }

  // Fails an admitted turn whose delivery raised: either the execution
  // admission closed (the caller aborted) or the provider work failed.
  #failAdmittedTurn(
    agentSessionId: string,
    turn: OpenCodeTurnContext,
    route: OpenCodeOperationRoute,
    request: { readonly executionAdmission?: OpenCodeExecutionAdmission },
    error: Error & { message: string },
    options: { readonly logLabel: string; readonly stageSteeringCleanup?: boolean },
  ): unknown {
    if (turn.providerMessageId === null) this.#operationRoutes.unregister(route);
    const sess = this.#sessions.get(agentSessionId);
    if (request.executionAdmission?.signal.aborted) {
      if (sess?.turn === turn) {
        sess.providerWorkRequiresQuiescence = true;
        sess.status = 'completed';
        sess.lastActivityAt = Date.now();
      }
      this.#clearTurnWaiter(agentSessionId);
      return error;
    }
    this.#logger.error(options.logLabel, { agentSessionId, error: error.message });
    if (!sess || sess.status !== 'running' || sess.turn !== turn) return error;
    if (options.stageSteeringCleanup) this.steering.stagePendingCleanup(sess);
    sess.providerWorkRequiresQuiescence = true;
    sess.status = 'completed';
    sess.lastActivityAt = Date.now();
    this.#clearTurnWaiter(agentSessionId);
    this.#publishFailed(agentSessionId, turn.operation, error.message);
    return error;
  }

  // Marks a session as the owner of a freshly admitted turn, inserting one
  // for a session the runtime has not seen (fork materialization, compaction).
  #activateTurn(
    agentSessionId: string,
    session: OpenCodeSession | undefined,
    input: {
      chatId: string;
      model: string;
      thinkingVariant?: string;
      permissionMode: PermissionMode;
      directory: string | undefined;
      turn: OpenCodeTurnContext;
    },
  ): void {
    if (session) {
      session.status = 'running';
      session.aborting = false;
      session.activeSteeringDeliveries = 0;
      session.deferredTerminal = null;
      session.chatId = input.chatId;
      session.model = input.model;
      session.thinkingVariant = input.thinkingVariant;
      session.permissionMode = input.permissionMode;
      session.directory = input.directory;
      session.lastActivityAt = Date.now();
      session.turn = input.turn;
      return;
    }
    this.#sessions.set(agentSessionId, {
      status: 'running',
      chatId: input.chatId,
      model: input.model,
      thinkingVariant: input.thinkingVariant,
      permissionMode: input.permissionMode,
      directory: input.directory,
      startedAt: new Date().toISOString(),
      lastActivityAt: Date.now(),
      providerWorkRequiresQuiescence: false,
      activeSteeringDeliveries: 0,
      deferredTerminal: null,
      pendingSteeringRevertMessageId: null,
      turn: input.turn,
    });
  }

  #dispatchOpenCodeEvent(event: SSEEvent, route: OpenCodeOperationRoute): void {
    if (route.turn.compaction) {
      this.#dispatchCompactionBoundary(event, route);
      return;
    }
    const chatMessages = convertOpenCodeEventToChatMessages(event, route.turn, this.#logger);
    if (!chatMessages || !chatMessages.length) {
      return;
    }

    this.#publishRows(route.sessionId, route.turn.operation, chatMessages);
  }

  // A manual compaction turn surfaces only the boundary marker; the provider's
  // summary text and control parts stay internal to the native session.
  #dispatchCompactionBoundary(event: SSEEvent, route: OpenCodeOperationRoute): void {
    if (route.turn.compactionBoundaryPublished) return;
    const boundary = manualCompactionBoundaryRow(event);
    if (!boundary) return;
    route.turn.compactionBoundaryPublished = true;
    this.#publishRows(route.sessionId, route.turn.operation, [
      attachNativeMessageSource(boundary.row, { entryId: boundary.summaryMessageId }),
    ]);
  }

  #dispatchPromptResponse(
    result: unknown,
    route: OpenCodeOperationRoute,
  ): OpenCodeAssistantTerminal {
    const response = isRecord(result) && isRecord(result.data) ? result.data : null;
    const info = response && isRecord(response.info) ? response.info : null;
    if (info?.role !== 'assistant' || typeof info.id !== 'string' || !info.id) {
      throw new Error('OpenCode prompt response is missing its assistant message');
    }

    const messageEvent: SSEEvent = {
      type: 'message.updated',
      properties: { sessionID: route.sessionId, info },
    };
    const responseParentId = typeof info.parentID === 'string' && info.parentID
      ? info.parentID
      : null;
    if (!this.#operationRoutes.activateFromResponse(route, responseParentId ?? info.id)) {
      throw new Error('OpenCode operation route retired before prompt completion');
    }
    if (responseParentId) route.turn.providerContinuationMessageIds.add(responseParentId);
    this.#operationRoutes.observe(route, messageEvent);
    const isCompaction = isOpenCodeCompactionAssistant(info);
    if (!isCompaction) {
      route.turn.assistantMessageIds.add(info.id);
      this.#dispatchOpenCodeEvent(messageEvent, route);
    }

    const parts = response && Array.isArray(response.parts) ? response.parts : [];
    for (const part of isCompaction ? [] : parts) {
      if (!isRecord(part)) continue;
      const partEvent: SSEEvent = {
        type: 'message.part.updated',
        properties: { sessionID: route.sessionId, part },
      };
      this.#operationRoutes.observe(route, partEvent);
      this.#dispatchOpenCodeEvent(partEvent, route);
    }

    return openCodeAssistantTerminal(messageEvent)
      ?? { outcome: 'finished', messageId: info.id };
  }

  async #completePromptRequest(
    client: any,
    route: OpenCodeOperationRoute,
    scope: OpenCodeRequestScope,
    request: Promise<unknown>,
  ): Promise<void> {
    let sourceRetired = false;
    try {
      const result = await request;
      await this.#awaitGlobalEventBarrier(
        client,
        scope.directory,
        route.requestAbortController.signal,
      );
      sourceRetired = true;
      route.requestAbortController.signal.throwIfAborted();
      throwOpenCodeResultError(result, 'OpenCode prompt failed');
      const terminal = this.#dispatchPromptResponse(result, route);
      const session = this.#sessions.get(route.sessionId);
      if (session?.turn !== route.turn) return;
      const observedTerminal = route.turn.assistantTerminals.get(terminal.messageId);
      this.#settleTurnTerminal(route.sessionId, session, observedTerminal ?? terminal);
    } catch (error) {
      this.#failPromptRequest(route, error);
    } finally {
      if (sourceRetired) {
        const session = this.#sessions.get(route.sessionId);
        if (session?.turn === route.turn) session.providerWorkRequiresQuiescence = false;
        this.#operationRoutes.unregister(route);
      }
    }
  }

  #handleGlobalSSEEvent(client: any, event: SSEEvent): void {
    const sessionId = extractSessionId(event);
    if (!sessionId) {
      if (event.type !== 'server.heartbeat') {
        this.#logger.debug('OpenCode SSE event has no session ID', { eventType: event.type });
      }
      return;
    }

    // Session status has no operation identity, so it is adopted at the session
    // scope before route resolution would drop it.
    if (event.type === 'session.status') {
      this.#handleSessionStatusEvent(sessionId, event);
      return;
    }

    this.#operationRoutes.bindTaskDescendantSession(event);
    const taskChildRoute = this.#operationRoutes.resolveTaskChild(sessionId);
    if (
      taskChildRoute
      && event.type !== 'permission.asked'
      && event.type !== 'question.asked'
    ) {
      this.#logger.debug('Ignoring an OpenCode task child transcript event', {
        eventId: event.id ?? null,
        eventType: event.type,
        parentSessionId: taskChildRoute.sessionId,
        childSessionId: sessionId,
      });
      return;
    }

    // Marked parts always pass through current-turn adoption so a foreign named ID cannot
    // bypass collision refusal through ordinary named resolution.
    const isCompactionPart = isOpenCodeCompactionControlPart(event)
      || isOpenCodeCompactionContinuationPart(event)
      || isOpenCodeManualCompactionControlPart(event);
    const route = taskChildRoute ?? (
      isCompactionPart
        ? adoptOpenCodeCompactionPartRoute({
            event,
            logger: this.#logger,
            operationRoutes: this.#operationRoutes,
            session: this.#sessions.get(sessionId),
            sessionId,
          })
        : this.#operationRoutes.resolve(sessionId, event)
    );
    if (!route) {
      if (isCompactionPart) return;
      const part = event.properties?.part;
      const info = event.properties?.info;
      const tool = event.properties?.tool;
      const partMessageId = typeof part?.messageID === 'string' ? part.messageID : null;
      const eventMessageId = typeof event.properties?.messageID === 'string'
        ? event.properties.messageID
        : null;
      const details = {
        eventId: event.id ?? null,
        eventType: event.type,
        sessionId,
        partId: typeof part?.id === 'string' ? part.id : null,
        messageId: partMessageId ?? eventMessageId,
        parentId: typeof info?.parentID === 'string' ? info.parentID : null,
        infoId: typeof info?.id === 'string' ? info.id : null,
        toolMessageId: typeof tool?.messageID === 'string' ? tool.messageID : null,
      };
      if (shouldWarnForUnroutedOpenCodeEvent(event.type)) {
        this.#logger.warn('Ignoring an OpenCode event without an operation identity', details);
      } else {
        this.#logger.debug('Ignoring an OpenCode event without an operation identity', details);
      }
      return;
    }
    if (!acceptUniqueOpenCodeTurnEvent(route.turn, event, this.#logger)) return;

    const source: OpenCodeOperationEventSource = taskChildRoute
      ? { kind: 'task-child', sessionId }
      : { kind: 'operation', sessionId };
    const session = this.#sessions.get(route.sessionId);
    const isCurrentTurn = session?.turn === route.turn;
    if (this.#decisions.handle(client, event, source, route)) return;
    if (isCurrentTurn) this.steering.observeAcknowledgement(session, event);
    const belongs = openCodeEventBelongsToTurn(route.turn, event);
    this.#operationRoutes.observe(route, event);
    if (belongs) {
      this.#operationRoutes.bindTaskChildSession(route, event);
      this.#dispatchOpenCodeEvent(event, route);
    }
    const terminal = belongs ? openCodeAssistantTerminal(event) : null;
    if (terminal) {
      route.turn.assistantTerminals.set(terminal.messageId, terminal);
      // A compaction turn has no prompt HTTP completion to drive settlement;
      // the summary assistant's terminal settles it directly.
      if (route.turn.compaction) {
        const terminalSession = this.#sessions.get(route.sessionId);
        if (terminalSession?.turn === route.turn) {
          this.#settleTurnTerminal(route.sessionId, terminalSession, terminal);
        }
      }
    }
  }

  // Surfaces a provider-announced retry wait as one durable notice row per
  // scheduled attempt, so an upstream stall is visible instead of dead air.
  #handleSessionStatusEvent(sessionId: string, event: SSEEvent): void {
    const notice = openCodeRetryNotice(event);
    const session = this.#sessions.get(sessionId);
    if (!notice || !session || session.status !== 'running') return;
    if (session.turn.lastRetryNoticeKey === notice.key) return;
    session.turn.lastRetryNoticeKey = notice.key;
    this.#publish(sessionId, session.turn.operation, {
      type: 'notice',
      runId: session.turn.operation.runId,
      title: notice.title,
      content: notice.content,
    });
  }

  async getClient(): Promise<any> {
    this.#assertCanUseOpenCode();
    const instance = await this.#ensureOpenCodeServer();
    return instance.client;
  }
  withClientLease<T>(operation: (client: any) => Promise<T>): Promise<T> {
    return this.#endpointCoordinator.withClientLease(operation);
  }
  getClientIfInitialized(): any | null {
    return this.#instance?.client ?? null;
  }

  async getModels(): Promise<OpenCodeModelOption[]> {
    return this.#models.getModels();
  }

  #resolveThinkingVariant(
    model: string | undefined,
    thinkingMode: ThinkingMode | undefined,
  ): Promise<string | undefined> {
    return this.#models.resolveThinkingVariantForTurn(model, thinkingMode);
  }

  async #runRequest<T>(
    label: string,
    operation: (signal: AbortSignal) => Promise<T>,
    control: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    const generation = this.#instanceGeneration;
    this.#endpointCoordinator.requestStarted();
    try {
      return await withAbortableTimeout(
        operation,
        control.timeoutMs ?? this.#options.requestTimeoutMs,
        label,
        control.signal,
      );
    } catch (err) {
      if (err instanceof OpenCodeTimeoutError) {
        const reason = errorMessage(err);
        if (this.#markTemporarilyUnavailable(reason, generation)) {
          this.#logger.warn('OpenCode request timed out', { reason });
        }
      }
      throw err;
    } finally {
      this.#endpointCoordinator.requestFinished();
    }
  }

  async #runScopedSessionRequest<T>(
    label: string,
    scope: OpenCodeRequestScope,
    operation: (signal: AbortSignal, scope: OpenCodeRequestScope) => Promise<T>,
    control: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    return this.#runRequest<T>(label, (signal) => operation(signal, scope), control);
  }

  async #runScopedTurnRequest<T>(
    scope: OpenCodeRequestScope,
    signal: AbortSignal,
    operation: (signal: AbortSignal, scope: OpenCodeRequestScope) => Promise<T>,
  ): Promise<T> {
    this.#endpointCoordinator.requestStarted();
    try {
      signal.throwIfAborted();
      return await operation(signal, scope);
    } finally {
      this.#endpointCoordinator.requestFinished();
    }
  }

  async #awaitGlobalEventBarrier(
    client: any,
    directory: string | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.#options.requiresExecutable) return;
    await withAbortableTimeout(
      (signal) => this.#confirmGlobalEventDelivery({
        client,
        directory,
        signal,
        waitForEvent: (matches, waitSignal) => (
          this.#globalEventListener.waitForEvent(matches, waitSignal)
        ),
      }),
      this.#options.requestTimeoutMs,
      'OpenCode prompt event delivery',
      signal,
    );
  }

  async #confirmGlobalEventDelivery(input: {
    client: any;
    directory?: string;
    signal: AbortSignal;
    waitForEvent(matches: (event: SSEEvent) => boolean, signal?: AbortSignal): Promise<SSEEvent>;
  }): Promise<void> {
    const marker = `garcon-event-stream-readiness-${crypto.randomUUID()}`;
    let observed = false;
    let deliveryFailure: unknown;
    const delivery = input.waitForEvent(
      (event) => event.type === 'tui.toast.show'
        && event.properties?.message === marker,
      input.signal,
    );
    void delivery.then(
      () => {
        observed = true;
      },
      (error) => {
        deliveryFailure = error;
      },
    );
    const scope = { directory: input.directory };
    // The global route registers its bus listener lazily after server.connected. An echoed
    // transient TUI event proves that later session events cannot fall in that gap without
    // creating or changing provider sessions.
    // https://github.com/anomalyco/opencode/blob/49c69c5ed3ccf706b61b3febb43c8aaff7f8325e/packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts#L33-L50
    // https://github.com/anomalyco/opencode/blob/49c69c5ed3ccf706b61b3febb43c8aaff7f8325e/packages/opencode/src/server/routes/instance/httpapi/handlers/tui.ts#L79-L83
    while (!observed) {
      if (deliveryFailure) throw deliveryFailure;
      const published: any = await this.#runScopedSessionRequest(
        'OpenCode event stream delivery probe',
        scope,
        (signal, requestScope) => input.client.tui.showToast(withOpenCodeRequestScope({
          message: marker,
          variant: 'info',
          duration: 1,
        }, requestScope), { signal }),
        { signal: input.signal },
      );
      throwOpenCodeResultError(published, 'OpenCode event stream delivery probe failed');
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await delivery;
  }

  async #quiesceRetiredProviderWork(
    client: any,
    agentSessionId: string,
    session: OpenCodeSession,
    scope: OpenCodeRequestScope,
  ): Promise<void> {
    if (!session.providerWorkRequiresQuiescence) return;
    const result = await this.#runScopedSessionRequest(
      'OpenCode retired session abort',
      scope,
      (signal, requestScope) => client.session.abort(
        withOpenCodeRequestScope({ sessionID: agentSessionId }, requestScope),
        { signal },
      ),
    );
    throwOpenCodeResultError(result, 'OpenCode retired session abort failed');
    await this.#awaitGlobalEventBarrier(client, scope.directory);
    this.#operationRoutes.retireTurn(session.turn);
    session.providerWorkRequiresQuiescence = false;
  }

  async #quiesceSessionBeforeTurn(
    agentSessionId: string,
    session: OpenCodeSession,
  ): Promise<void> {
    const pending = this.#pendingSessionAborts.get(session);
    if (pending) {
      await pending;
      return;
    }
    if (session.status === 'running') await this.abort(agentSessionId);
  }

  async startSession(request: OpenCodeStartRequest): Promise<string> {
    this.#endpointCoordinator.turnAdmissionStarted();
    try {
    assertOpenCodeExecutionOpen(request);
    const {
      command,
      chatId,
      images,
      model,
      permissionMode = 'default',
      projectPath,
      thinkingMode,
      operation,
    } = request;
    const scope = createOpenCodeRequestScope(projectPath);

    const instance = await this.#ensureOpenCodeServer();
    const generation = this.#instanceGeneration;
    await this.#globalEventListener.start(scope.directory);
    this.#assertInstanceCurrent(instance);

    const client: any = instance.client;
    assertOpenCodeExecutionOpen(request);
    const sessionResult: any = await this.#runRequest<any>(
      'OpenCode session create',
      (signal) => client.session.create(withOpenCodeRequestScope({
        permission: mapPermissionMode(permissionMode),
      }, scope), { signal }),
    );
    throwOpenCodeResultError(sessionResult, 'Failed to create OpenCode session');

    const agentSessionId = typeof sessionResult.data?.id === 'string'
      ? sessionResult.data.id.trim()
      : '';
    if (!agentSessionId) {
      throw new Error('Failed to create OpenCode session: missing session id');
    }

    const turn = createOpenCodeTurnContext(operation);
    const thinkingVariant = await this.#resolveThinkingVariant(model, thinkingMode);
    this.#sessions.set(agentSessionId, {
      status: 'running',
      chatId,
      model,
      thinkingVariant,
      permissionMode,
      directory: scope.directory,
      startedAt: new Date().toISOString(),
      lastActivityAt: Date.now(),
      providerWorkRequiresQuiescence: false,
      activeSteeringDeliveries: 0,
      deferredTerminal: null,
      pendingSteeringRevertMessageId: null,
      turn,
    });
    const route = this.#operationRoutes.register(
      agentSessionId,
      chatId,
      turn,
      true,
      permissionMode,
      scope.directory,
    );
    this.#logger.info('OpenCode session created and registered', { agentSessionId });

    try {
      // Fence inside the cleanup scope: a retirement after the session was
      // created must still attempt deleting it, because native sessions
      // persist in the provider database across respawns.
      this.#assertInstanceCurrent(instance);
      await this.#globalEventListener.start(scope.directory);
      this.#assertInstanceCurrent(instance);
      const activeSession = this.#sessions.get(agentSessionId);
      if (!activeSession || activeSession.status !== 'running' || activeSession.turn !== turn) {
        throw new Error('OpenCode event stream ended before prompt delivery');
      }
      if (request.executionAdmission) await markOpenCodeExecutionStarted(request);
      this.#assertInstanceCurrent(instance);
      // Activation publishes the durable session fact, so it must follow every
      // failure whose cleanup deletes the just-created native session; a chat
      // must never stay durably bound to a session this path removed.
      request.onSessionActivated?.(agentSessionId);
    } catch (error) {
      this.#operationRoutes.unregister(route);
      this.#sessions.delete(agentSessionId);
      await this.#deleteSessionBestEffort(agentSessionId, scope, { client, generation });
      throw error;
    }

    const promptBody = buildPromptBody(
      command,
      model,
      turn.providerPromptPartId,
      images ?? [],
      thinkingVariant,
    );

    const promptRequest = this.#runScopedTurnRequest(
      scope,
      route.requestAbortController.signal,
      (signal, requestScope) => client.session.prompt(withOpenCodeRequestScope({
        sessionID: agentSessionId,
        ...promptBody,
      }, requestScope), { signal }),
    );
    void this.#completePromptRequest(client, route, scope, promptRequest);

    return agentSessionId;
    } finally {
      this.#endpointCoordinator.turnAdmissionFinished();
      if (this.isTemporarilyUnavailable()) this.#idleLifecycle.closeInstanceIfIdle();
    }
  }

  async runTurn(request: OpenCodeResumeRequest): Promise<void> {
    this.#endpointCoordinator.turnAdmissionStarted();
    try {
    assertOpenCodeExecutionOpen(request);
    const {
      command,
      agentSessionId,
      chatId,
      images,
      model,
      permissionMode,
      projectPath,
      thinkingMode,
      operation,
    } = request;
    const pendingSession = this.#sessions.get(agentSessionId);
    if (pendingSession) await this.#quiesceSessionBeforeTurn(agentSessionId, pendingSession);
    const session = this.#sessions.get(agentSessionId);
    const requestScope = createOpenCodeRequestScope(projectPath);
    const scope = requestScope.directory ? requestScope : { directory: session?.directory };

    const instance = await this.#ensureOpenCodeServer();
    await this.#globalEventListener.start(scope.directory);
    this.#assertInstanceCurrent(instance);
    assertOpenCodeExecutionOpen(request);

    const turn = createOpenCodeTurnContext(operation);
    const client: any = instance.client;
    if (session) {
      await this.#quiesceRetiredProviderWork(client, agentSessionId, session, scope);
      await this.steering.removeUnconsumed(client, agentSessionId, session, scope);
    }
    this.#assertInstanceCurrent(instance);
    const waiter = this.#createTurnWaiter(agentSessionId);
    // One resolution per turn: the stored variant steering reuses must be the
    // variant this prompt submits, even if discovery refreshes mid-admission.
    const thinkingVariant = await this.#resolveThinkingVariant(model, thinkingMode);
    this.#activateTurn(agentSessionId, session, {
      chatId,
      model,
      thinkingVariant,
      permissionMode,
      directory: scope.directory,
      turn,
    });
    const route = this.#operationRoutes.register(
      agentSessionId,
      chatId,
      turn,
      false,
      permissionMode,
      scope.directory,
    );
    const promptBody = buildPromptBody(
      command,
      model,
      turn.providerPromptPartId,
      images ?? [],
      thinkingVariant,
    );

    try {
      await this.#globalEventListener.start(scope.directory);
      this.#assertInstanceCurrent(instance);
      const activeSession = this.#sessions.get(agentSessionId);
      if (!activeSession || activeSession.status !== 'running' || activeSession.turn !== turn) {
        throw new Error('OpenCode event stream ended before prompt delivery');
      }
      if (request.executionAdmission) await markOpenCodeExecutionStarted(request);
      this.#assertInstanceCurrent(instance);
      const promptRequest = this.#runScopedTurnRequest(
        scope,
        route.requestAbortController.signal,
        (signal, requestScope) => client.session.prompt(withOpenCodeRequestScope({
          sessionID: agentSessionId,
          ...promptBody,
        }, requestScope), { signal }),
      );
      void this.#completePromptRequest(client, route, scope, promptRequest);
    } catch (err: any) {
      throw this.#failAdmittedTurn(agentSessionId, turn, route, request, err, {
        logLabel: 'OpenCode query failed',
        stageSteeringCleanup: true,
      });
    }

    const turnFailure = await waiter.promise;
    if (turnFailure) throw turnFailure;
    } finally {
      this.#endpointCoordinator.turnAdmissionFinished();
      if (this.isTemporarilyUnavailable()) this.#idleLifecycle.closeInstanceIfIdle();
    }
  }

  // Manual compaction runs provider-native summarize as its own turn. The
  // summarize route returns before the model runs, so the turn's route binds to
  // the compaction user message it created and the summary assistant's terminal
  // arrives through the global stream.
  async compact(request: Omit<OpenCodeResumeRequest, 'command' | 'images'>): Promise<void> {
    this.#endpointCoordinator.turnAdmissionStarted();
    let turn: OpenCodeTurnContext | null = null;
    try {
      assertOpenCodeExecutionOpen(request);
      const {
        agentSessionId,
        chatId,
        model,
        projectPath,
        operation,
      } = request;
      const session = this.#sessions.get(agentSessionId);
      if (session?.status === 'running') {
        throw new Error('Cannot compact while an OpenCode turn is active');
      }
      const requestScope = createOpenCodeRequestScope(projectPath);
      const scope = requestScope.directory ? requestScope : { directory: session?.directory };

      const instance = await this.#ensureOpenCodeServer();
      await this.#globalEventListener.start(scope.directory);
      this.#assertInstanceCurrent(instance);
      assertOpenCodeExecutionOpen(request);

      turn = createOpenCodeTurnContext(operation, { compaction: true });
      const client: any = instance.client;
      if (session) {
        await this.#quiesceRetiredProviderWork(client, agentSessionId, session, scope);
        await this.steering.removeUnconsumed(client, agentSessionId, session, scope);
      }
      this.#assertInstanceCurrent(instance);
      this.#activateTurn(agentSessionId, session, {
        chatId,
        model,
        permissionMode: request.permissionMode,
        directory: scope.directory,
        turn,
      });
      const route = this.#operationRoutes.register(
        agentSessionId,
        chatId,
        turn,
        false,
        request.permissionMode,
        scope.directory,
      );
      const waiter = this.#createTurnWaiter(agentSessionId);

      try {
        await this.#globalEventListener.start(scope.directory);
        this.#assertInstanceCurrent(instance);
        const activeSession = this.#sessions.get(agentSessionId);
        if (!activeSession || activeSession.status !== 'running' || activeSession.turn !== turn) {
          throw new Error('OpenCode event stream ended before compaction delivery');
        }
        if (request.executionAdmission) await markOpenCodeExecutionStarted(request);
        this.#assertInstanceCurrent(instance);
        const parsedModel = parseOpenCodeModel(model);
        const summarizeRequest = this.#runScopedTurnRequest(
          scope,
          route.requestAbortController.signal,
          (signal, requestScopeInner) => client.session.summarize(
            withOpenCodeRequestScope({
              sessionID: agentSessionId,
              ...(parsedModel ?? {}),
            }, requestScopeInner),
            { signal },
          ),
        );
        const result = await summarizeRequest;
        await this.#awaitGlobalEventBarrier(client, scope.directory, route.requestAbortController.signal);
        throwOpenCodeResultError(result, 'OpenCode compaction failed');
        // The control part event precedes the summarize response, so the stream
        // adoption must have bound the compaction source by now.
        if (turn.providerMessageId === null) {
          throw new Error('OpenCode compaction did not create a compaction message');
        }
      } catch (error: any) {
        throw this.#failAdmittedTurn(agentSessionId, turn, route, request, error, {
          logLabel: 'OpenCode compaction failed',
        });
      }

      const turnFailure = await waiter.promise;
      if (turnFailure) throw turnFailure;
    } finally {
      // The route outlives the summarize response because the terminal arrives
      // on the stream; retiring here follows the awaited turn settlement and
      // keeps repeated compactions from leaking routes.
      if (turn) this.#operationRoutes.retireTurn(turn);
      this.#endpointCoordinator.turnAdmissionFinished();
      if (this.isTemporarilyUnavailable()) this.#idleLifecycle.closeInstanceIfIdle();
    }
  }

  async forkSession(
    sourceSessionId: string,
    options: { projectPath?: string | null; messageId?: string; permissionMode?: string } = {},
  ): Promise<string> {
    // OpenCode persists a manual compaction control before its summary runs, so
    // a whole-tip fork mid-compaction would clone a pending control into the
    // child, where the next prompt could be consumed as compaction input.
    const source = this.#sessions.get(sourceSessionId.trim());
    if (source?.status === 'running' && source.turn.compaction) {
      throw new AgentIntegrationError(
        'TRANSCRIPT_UNAVAILABLE',
        'The OpenCode source session is compacting; fork after it settles',
        true,
        { nativeForkReason: 'not-settled' },
      );
    }
    const forkedSessionId = await this.#endpointCoordinator.forkSession(
      sourceSessionId,
      options,
      (label, scope, operation) => this.#runScopedSessionRequest(label, scope, operation),
    );
    // Native fork clones only messages: the forked session carries no permission
    // ruleset, so without this the forked chat prompts for everything the source
    // had allowed. https://github.com/anomalyco/opencode/blob/v1.18.22/packages/opencode/src/session/session.ts#L691-L701
    const permissionMode = options.permissionMode;
    if (permissionMode) {
      try {
        await this.withClientLease(async (client) => {
          const result = await this.#runScopedSessionRequest(
            'OpenCode fork permission update',
            createOpenCodeRequestScope(options.projectPath),
            (requestSignal, requestScope) => client.session.update(
              withOpenCodeRequestScope({
                sessionID: forkedSessionId,
                permission: mapPermissionMode(permissionMode),
              }, requestScope),
              { signal: requestSignal },
            ),
          );
          throwOpenCodeResultError(result, 'Failed to apply OpenCode fork permission mode');
        });
      } catch (error) {
        // Never leave a forked session behind with a ruleset that does not match the
        // chat record; the fork caller retries the whole operation. Cleanup goes
        // through the retained-deletion path: an update that failed because the
        // endpoint died would otherwise orphan a full transcript clone.
        await this.#deleteSessionBestEffort(
          forkedSessionId,
          createOpenCodeRequestScope(options.projectPath),
        );
        throw new AgentIntegrationError(
          'TRANSCRIPT_UNAVAILABLE',
          errorMessage(error),
          true,
        );
      }
    }
    return forkedSessionId;
  }

  async deleteSession(agentSessionId: string, signal?: AbortSignal): Promise<void> {
    await this.withClientLease(async (client) => {
      const result = await this.#runScopedSessionRequest(
        'OpenCode forked session delete',
        {},
        (requestSignal, requestScope) => client.session.delete(
          withOpenCodeRequestScope({ sessionID: agentSessionId }, requestScope),
          { signal: requestSignal },
        ),
        { signal },
      );
      throwOpenCodeResultError(result, 'OpenCode forked session delete failed');
    });
  }

  abort(agentSessionId: string): Promise<boolean> {
    const session = this.#sessions.get(agentSessionId);
    if (!session || session.status !== 'running') return Promise.resolve(false);
    const existing = this.#pendingSessionAborts.get(session);
    if (existing) return existing;

    const pending = this.#abortRunningSession(agentSessionId, session);
    this.#pendingSessionAborts.set(session, pending);
    void pending.then(
      () => this.#pendingSessionAborts.delete(session),
      () => this.#pendingSessionAborts.delete(session),
    );
    return pending;
  }

  async #abortRunningSession(
    agentSessionId: string,
    session: OpenCodeSession,
  ): Promise<boolean> {
    const turn = session.turn;
    this.steering.stagePendingCleanup(session);
    session.providerWorkRequiresQuiescence = true;
    session.aborting = true;

    try {
      const client = await this.getClient();
      const result = await this.#runScopedSessionRequest(
        'OpenCode session abort',
        { directory: session.directory },
        (signal, requestScope) => client.session.abort(
          withOpenCodeRequestScope({ sessionID: agentSessionId }, requestScope),
          { signal },
        ),
      );
      throwOpenCodeResultError(result, 'OpenCode session abort failed');
      await this.#awaitGlobalEventBarrier(client, session.directory);
    } catch (error) {
      session.aborting = false;
      this.#logger.warn('OpenCode session abort failed', {
        agentSessionId,
        error: errorMessage(error),
      });
      this.#releaseDeferredTerminal(agentSessionId, session);
      return false;
    }

    session.providerWorkRequiresQuiescence = false;
    if (
      this.#sessions.get(agentSessionId) !== session
      || session.status !== 'running'
      || session.turn !== turn
    ) return false;
    session.status = 'aborted';
    session.deferredTerminal = null;
    session.lastActivityAt = Date.now();
    this.#operationRoutes.retireTurn(turn);
    this.#decisions.cancelForSession(agentSessionId, 'aborted');
    // The acknowledged stop is turn-terminal work: the terminal event settles
    // the core run and releases queued execution.
    this.#publishFinished(agentSessionId, turn.operation);
    this.#rejectTurnWaiter(agentSessionId, new Error('OpenCode session aborted'));
    return true;
  }

  isRunning(agentSessionId: string): boolean {
    const session = this.#sessions.get(agentSessionId);
    return session?.status === 'running';
  }

  updateSessionSettings(agentSessionId: string, patch: OpenCodeSessionSettingsPatch): void {
    const session = this.#sessions.get(agentSessionId);
    if (!session) return;
    if (patch.permissionMode !== undefined) session.permissionMode = patch.permissionMode;
  }

  getRunningSessions(): Array<{ id: string; status: string; startedAt: string }> {
    return Array.from(this.#sessions.entries())
      .filter(([, session]) => session.status === 'running')
      .map(([id, session]) => ({ id, status: session.status, startedAt: session.startedAt }));
  }

  async runSingleQuery(prompt: string, options: Record<string, any> = {}): Promise<string> {
    const thinkingMode = normalizeThinkingMode(options.thinkingMode);
    const { cwd, projectPath, model, permissionMode = 'default' } = options;
    const scope = createOpenCodeRequestScope(projectPath || cwd);
    const requestTimeoutMs = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
      ? Math.max(1, Math.round(options.timeoutMs))
      : undefined;
    return withSingleQueryControl(options, async (signal) => this.withClientLease(async (client) => {
      // The lease blocks idle retirement but not authoritative death
      // retirement: every stage after this point re-fences the generation so a
      // dead client is never prompted through, while the created session is
      // still cleaned up or retained for the replacement.
      const generation = this.#instanceGeneration;
      const assertCurrent = () => {
        if (this.#instanceGeneration !== generation) {
          throw new Error('OpenCode server process was retired while the request was in flight');
        }
      };

      const createResult: any = await this.#runRequest<any>(
        'OpenCode session create',
        (requestSignal) => client.session.create(withOpenCodeRequestScope({
          permission: mapPermissionMode(permissionMode),
        }, scope), { signal: requestSignal }),
        { signal, timeoutMs: requestTimeoutMs },
      );

      throwOpenCodeResultError(createResult, 'Failed to create OpenCode session');

      const sessionId = typeof createResult.data?.id === 'string' ? createResult.data.id.trim() : '';
      if (!sessionId) {
        throw new Error('Failed to create OpenCode session: missing session id');
      }

      try {
        assertCurrent();
        const parsedModel = parseOpenCodeModel(model);
        const body: Record<string, unknown> = {
          parts: [{ type: 'text', text: prompt }],
          tools: { '*': false },
        };
        if (parsedModel) body.model = parsedModel;
        const thinkingVariant = await this.#resolveThinkingVariant(model, thinkingMode);
        if (thinkingVariant) body.variant = thinkingVariant;

        const promptResult: any = await this.#runScopedSessionRequest<any>(
          'OpenCode prompt',
          scope,
          (requestSignal, requestScope) => client.session.prompt(withOpenCodeRequestScope({
            sessionID: sessionId,
            ...body,
          }, requestScope), { signal: requestSignal }),
          { signal, timeoutMs: requestTimeoutMs },
        );
        assertCurrent();

        throwOpenCodeResultError(promptResult, 'OpenCode one-shot prompt failed');
        return extractTextParts(promptResult.data?.parts);
      } finally {
        await this.#deleteSessionBestEffort(sessionId, scope, { client, generation });
      }
    }));
  }

  startPurgeTimer(): void {
    this.#idleLifecycle.start();
  }
}

// The failing assistant message is the last one the turn observed; the native
// error occurrence is stored on it, so its id is the canonical error identity.
function lastValue<T>(values: Iterable<T>): T | null {
  let last: T | null = null;
  for (const value of values) last = value;
  return last;
}

function shouldWarnForUnroutedOpenCodeEvent(eventType: string): boolean {
  return eventType === 'message.updated'
    || eventType === 'message.part.updated'
    || eventType === 'message.part.delta'
    || eventType === 'permission.asked'
    || eventType === 'question.asked'
    || eventType === 'session.error';
}
