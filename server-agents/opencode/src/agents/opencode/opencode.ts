// OpenCode SDK integration. Each provider operation owns its transcript publisher.

import crypto from 'crypto';
import { isRecord } from '@garcon/common/json';
import type { PermissionDecisionPayload } from '@garcon/common/chat-command-contracts';
import { errorMessage } from '@garcon/server-agent-common/lib/errors';
import { buildPromptBody, parseOpenCodeModel } from './prompt.js';
import {
  extractSessionId,
  extractTextParts,
  isOpenCodeCompactionAssistant,
  isOpenCodeCompactionContinuationPart,
  isOpenCodeCompactionControlPart,
  openCodeAssistantTerminal,
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
import { ErrorMessage } from '@garcon/common/chat-types';
import { attachNativeMessageSource } from '@garcon/server-agent-common/shared/native-message-source';
import { convertOpencodePermissionTool } from "./permission-tool-converter.js";
import {
  runtimeRows,
  type AgentRuntimeEvent,
  type AgentRuntimeOperation,
} from '@garcon/server-agent-common/execution/runtime-events';
import { IdleSessionPurger } from '@garcon/server-agent-common/shared/idle-session-purger';
import type { OpenCodeConfig } from '../../config.js';
import { normalizeThinkingMode } from '@garcon/common/chat-modes';
import {
  assertOpenCodeExecutionOpen,
  markOpenCodeExecutionStarted,
  type OpenCodeResumeRequest,
  type OpenCodeSessionSettingsPatch,
  type OpenCodeStartRequest,
} from './runtime-types.js';
import {
  createOpenCodeRequestScope,
  throwOpenCodeResultError,
  withOpenCodeRequestScope,
  type OpenCodeRequestScope,
} from './sdk-result.js';
import {
  AGENT_UNSUPPORTED_SINGLE_QUERY_THINKING_MODE,
  AgentIntegrationError,
  type AgentLogger,
} from '@garcon/server-agent-interface';
import { OpenCodeEndpointCoordinator } from './endpoint-coordinator.js';
import { OpenCodeGlobalEventListener } from './global-event-listener.js';
import {
  closeOpenCodeInstance,
  OpenCodeInstanceCreationTracker,
  type OpenCodeInstance,
} from './instance-lifecycle.js';
import { withSingleQueryControl } from '@garcon/server-agent-common/shared/single-query-control';
import {
  OpenCodeTimeoutError,
  withAbortableTimeout,
} from './request-control.js';
import { convertOpenCodeEventToChatMessages } from './event-converter.js';
import { OpenCodeSteeringController } from './steering.js';
import {
  OpenCodeOperationRoutes,
  type OpenCodeOperationRoute,
} from './operation-routes.js';
import {
  extractPermissionRequest,
  mapPermissionDecision,
  mapPermissionMode,
} from './permissions.js';
import { createOpenCodeInstance } from './server-instance.js';
import {
  configuredProvidersFromResult,
  connectedProvidersFromListResult,
  modelsFromProviders,
  type OpenCodeModelOption,
} from './model-catalog.js';

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
const DEFAULT_OPENCODE_SSE_HEARTBEAT_TIMEOUT_MS = 30_000;
const DEFAULT_OPENCODE_MODEL_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_OPENCODE_SHUTDOWN_STARTUP_GRACE_MS = 100;

interface PendingTurnWaiter {
  promise: Promise<Error | null>;
  settle: (failure: Error | null) => void;
}

interface PendingPermission {
  permissionOccurrenceId: string;
  originalRequestId: string;
  agentSessionId: string;
  directory?: string;
  operation: OpenCodeTurnContext['operation'];
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
  now?: () => number;
  createInstance?: (input: {
    port: number;
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
    port: number;
    signal: AbortSignal;
  }) => Promise<OpenCodeInstance>;
}

interface OpenCodeModelCache {
  models: OpenCodeModelOption[];
  fetchedAt: number;
}

type OpenCodeCompactionPartDropCode =
  | 'COMPACTION_PART_NO_SESSION'
  | 'COMPACTION_PART_SESSION_NOT_RUNNING'
  | 'COMPACTION_PART_BEFORE_PROMPT'
  | 'COMPACTION_PART_ROUTE_RETIRED'
  | 'COMPACTION_PART_INVALID_IDENTIFIERS'
  | 'COMPACTION_PART_IDENTITY_COLLISION';

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
  #initPromise: Promise<OpenCodeInstance> | null = null;
  #startupAbortController: AbortController | null = null;
  #shutdownPromise: Promise<void> | null = null;
  #shuttingDown = false;
  #sessions = new Map<string, OpenCodeSession>();
  #pendingSessionAborts = new WeakMap<OpenCodeSession, Promise<boolean>>();
  #pendingTurnWaiters = new Map<string, PendingTurnWaiter>();
  #pendingPermissions = new Set<PendingPermission>();
  readonly steering: OpenCodeSteeringController;
  readonly #endpointCoordinator: OpenCodeEndpointCoordinator;
  readonly #globalEventListener: OpenCodeGlobalEventListener;
  readonly #operationRoutes: OpenCodeOperationRoutes;
  #modelCache: OpenCodeModelCache | null = null;
  #modelsPromise: Promise<OpenCodeModelOption[]> | null = null;
  #unavailableUntil = 0;
  #unavailableReason = '';
  readonly #instanceCreations: OpenCodeInstanceCreationTracker;
  #idlePurger = new IdleSessionPurger<OpenCodeSession>({
    sessions: () => this.#sessions.entries(),
    isRunning: (session) => (
      session.status === 'running' || session.providerWorkRequiresQuiescence
    ),
    lastActivityAt: (session) => session.lastActivityAt,
    purge: (sessionId) => {
      this.#sessions.delete(sessionId);
    },
  });

  #available: boolean | null = null;
  readonly #options: NormalizedOpenCodeRuntimeOptions;

  constructor(options: OpenCodeRuntimeOptions = {}) {
    this.#config = options.config ?? { isTestEnvironment: () => false };
    this.#logger = options.logger ?? SILENT_LOGGER;
    this.#operationRoutes = new OpenCodeOperationRoutes(this.#logger);
    this.#options = normalizeOptions(options);
    this.#instanceCreations = new OpenCodeInstanceCreationTracker(() => this.#shuttingDown);
    this.#endpointCoordinator = new OpenCodeEndpointCoordinator({
      assertAvailable: () => this.#assertCanUseOpenCode(),
      ensureUnlocked: () => this.#ensureOpenCodeServerUnlocked(),
      logger: this.#logger,
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
      markTemporarilyUnavailable: (reason) => this.#markTemporarilyUnavailable(reason),
      failRunningTurns: (error) => this.#failRunningTurnsForListenerError(error),
      closeUnavailableInstanceIfIdle: () => this.#closeInstanceIfIdle(),
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
    this.#idlePurger.stop();
    for (const agentSessionId of this.#pendingTurnWaiters.keys()) {
      this.#rejectTurnWaiter(agentSessionId, new Error('OpenCode runtime shutting down'));
    }
    this.#sessions.clear();
    this.#pendingPermissions.clear();
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

  #markAvailable(): void {
    this.#unavailableUntil = 0;
    this.#unavailableReason = '';
  }

  #markTemporarilyUnavailable(reason: string): boolean {
    const now = this.#now();
    const wasAvailable = this.#unavailableRemainingMs() === 0;
    const reasonChanged = this.#unavailableReason !== reason;
    this.#unavailableReason = reason;
    this.#unavailableUntil = now + this.#options.unavailableRetryMs;
    this.#closeInstanceIfIdle();
    return wasAvailable || reasonChanged;
  }

  #hasRunningSessions(): boolean {
    return Array.from(this.#sessions.values()).some((session) => session.status === 'running');
  }

  #closeInstanceIfIdle(): boolean {
    if (!this.#hasRunningSessions() && this.#endpointCoordinator.idle) {
      this.#closeInstance();
      return true;
    }
    return false;
  }

  #closeInstance(): void {
    this.#globalEventListener.close();
    this.#operationRoutes.clear();
    const instance = this.#instance;
    if (instance) {
      closeOpenCodeInstance(instance);
    }
    this.#instance = null;
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
      this.#cancelPendingPermissionsForSession(agentSessionId, 'cancelled');
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
    this.#cancelPendingPermissionsForSession(agentSessionId, 'cancelled');
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
      if (this.isTemporarilyUnavailable()) this.#closeInstanceIfIdle();
      return;
    }
    const providerTerminal = lastValue(route.turn.assistantTerminals.values());
    if (providerTerminal?.outcome === 'failed') {
      this.#failTurnForProviderError(route.sessionId, session, providerTerminal.error);
      if (this.isTemporarilyUnavailable()) this.#closeInstanceIfIdle();
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
    this.#cancelPendingPermissionsForSession(route.sessionId, 'cancelled');
    this.#rejectTurnWaiter(route.sessionId, error);
    this.#publishFailed(route.sessionId, route.turn.operation, message);
    if (this.isTemporarilyUnavailable()) this.#closeInstanceIfIdle();
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
    this.#cancelPendingPermissionsForSession(agentSessionId, 'session-complete');
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

        const port = 10000 + Math.floor(Math.random() * 50000);
        const result: OpenCodeInstance = await withAbortableTimeout(
          (signal) => this.#instanceCreations.track(
            () => this.#options.createInstance({ port, signal }),
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
        this.#markAvailable();
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

  #dispatchOpenCodeEvent(event: SSEEvent, route: OpenCodeOperationRoute): void {
    const chatMessages = convertOpenCodeEventToChatMessages(event, route.turn, this.#logger);
    if (!chatMessages || !chatMessages.length) {
      return;
    }

    this.#publishRows(route.sessionId, route.turn.operation, chatMessages);
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

  #replyManualBypassPermission(
    client: any,
    route: OpenCodeOperationRoute,
    requestId: string,
  ): void {
    void this.#runScopedSessionRequest(
      'OpenCode manual bypass permission reply',
      { directory: route.directory },
      (signal, requestScope) => client.permission.reply(
        withOpenCodeRequestScope({ requestID: requestId, reply: 'once' }, requestScope),
        { signal },
      ),
    ).then((result) => {
      throwOpenCodeResultError(result, 'OpenCode manual bypass permission reply failed');
    }).catch((error) => {
      const current = this.#sessions.get(route.sessionId);
      if (
        current?.status !== 'running'
        || current.turn !== route.turn
      ) {
        this.#logger.debug('Ignoring a late OpenCode manual bypass reply failure', {
          agentSessionId: route.sessionId,
          error: errorMessage(error),
        });
        return;
      }
      this.#failTurnForProviderError(route.sessionId, current, errorMessage(error));
    });
  }

  #cancelPendingPermissionsForSession(agentSessionId: string, reason: 'cancelled' | 'session-complete' | 'aborted'): void {
    for (const pending of [...this.#pendingPermissions]) {
      if (pending.agentSessionId !== agentSessionId) continue;
      this.#pendingPermissions.delete(pending);
      this.#publish(agentSessionId, pending.operation, {
        type: 'permission',
        runId: pending.operation.runId,
        lifecycle: {
          kind: 'cancelled',
          permissionOccurrenceId: pending.permissionOccurrenceId,
          reason,
        },
      });
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

    // Marked parts always pass through current-turn adoption so a foreign named ID cannot
    // bypass collision refusal through ordinary named resolution.
    const isCompactionPart = isOpenCodeCompactionControlPart(event)
      || isOpenCodeCompactionContinuationPart(event);
    const route = isCompactionPart
      ? this.#adoptCompactionPart(sessionId, event)
      : this.#operationRoutes.resolve(sessionId, event);
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

    const session = this.#sessions.get(sessionId);
    const isCurrentTurn = session?.turn === route.turn;
    if (event.type === 'permission.asked') {
      this.#handlePermissionEvent(client, event, sessionId, route);
      return;
    }
    if (isCurrentTurn) this.steering.observeAcknowledgement(session, event);
    const belongs = openCodeEventBelongsToTurn(route.turn, event);
    this.#operationRoutes.observe(route, event);
    if (belongs) this.#dispatchOpenCodeEvent(event, route);
    const terminal = belongs ? openCodeAssistantTerminal(event) : null;
    if (terminal) route.turn.assistantTerminals.set(terminal.messageId, terminal);
  }

  #adoptCompactionPart(
    sessionId: string,
    event: SSEEvent,
  ): OpenCodeOperationRoute | null {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      return this.#dropCompactionPart('COMPACTION_PART_NO_SESSION', sessionId, event);
    }
    if (session.status !== 'running') {
      return this.#dropCompactionPart(
        'COMPACTION_PART_SESSION_NOT_RUNNING',
        sessionId,
        event,
      );
    }
    if (session.turn.providerMessageId === null) {
      return this.#dropCompactionPart('COMPACTION_PART_BEFORE_PROMPT', sessionId, event);
    }
    const adoption = this.#operationRoutes.adoptCompactionPart(session.turn, event);
    switch (adoption.kind) {
      case 'adopted': {
        const part = event.properties?.part;
        this.#logger.debug('Adopted an OpenCode compaction part', {
          agentSessionId: sessionId,
          partId: typeof part?.id === 'string' ? part.id : null,
          messageId: typeof part?.messageID === 'string' ? part.messageID : null,
        });
        return adoption.route;
      }
      case 'route-retired':
        return this.#dropCompactionPart('COMPACTION_PART_ROUTE_RETIRED', sessionId, event);
      case 'invalid-identifiers':
        return this.#dropCompactionPart(
          'COMPACTION_PART_INVALID_IDENTIFIERS',
          sessionId,
          event,
        );
      case 'identity-collision':
        return this.#dropCompactionPart(
          'COMPACTION_PART_IDENTITY_COLLISION',
          sessionId,
          event,
        );
    }
  }

  #dropCompactionPart(
    code: OpenCodeCompactionPartDropCode,
    sessionId: string,
    event: SSEEvent,
  ): null {
    const part = event.properties?.part;
    this.#logger.warn('Dropping an OpenCode compaction part', {
      code,
      agentSessionId: sessionId,
      eventId: event.id ?? null,
      partId: typeof part?.id === 'string' ? part.id : null,
      messageId: typeof part?.messageID === 'string' ? part.messageID : null,
    });
    return null;
  }

  #handlePermissionEvent(
    client: any,
    event: SSEEvent,
    sessionId: string,
    route: OpenCodeOperationRoute,
  ): void {
    const toolMessageId = event.properties?.tool?.messageID;
    if (
      typeof toolMessageId === 'string'
      && !route.turn.assistantMessageIds.has(toolMessageId)
    ) return;
    const permission = extractPermissionRequest(event);
    if (!permission) return;
    if (route.permissionMode === 'manualBypass') {
      this.#replyManualBypassPermission(client, route, permission.requestId);
      return;
    }
    const permissionOccurrenceId = crypto.randomUUID();
    const pending: PendingPermission = {
      permissionOccurrenceId,
      originalRequestId: permission.requestId,
      agentSessionId: sessionId,
      directory: route.directory,
      operation: route.turn.operation,
    };
    this.#pendingPermissions.add(pending);
    const now = new Date().toISOString();
    const requestedTool = convertOpencodePermissionTool(
      now,
      permissionOccurrenceId,
      permission.toolInput,
    );
    this.#publish(sessionId, route.turn.operation, {
      type: 'permission',
      runId: route.turn.operation.runId,
      lifecycle: {
        kind: 'requested',
        permissionOccurrenceId,
        requestedTool,
        options: [],
      },
      decision: Object.freeze({
        permissionOccurrenceId,
        respond: (decision: PermissionDecisionPayload) => this.#resolvePermission(pending, decision),
      }),
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
    if (!this.isAvailable()) return [];
    if (this.isTemporarilyUnavailable()) return this.#cachedModels();
    if (this.#isModelCacheFresh()) return this.#cachedModels();
    if (this.#modelsPromise) return this.#modelsPromise;

    this.#modelsPromise = this.#loadModels().finally(() => {
      this.#modelsPromise = null;
    });
    return this.#modelsPromise;
  }

  #cachedModels(): OpenCodeModelOption[] {
    return this.#modelCache?.models ?? [];
  }

  #isModelCacheFresh(): boolean {
    if (!this.#modelCache) return false;
    return this.#now() - this.#modelCache.fetchedAt < this.#options.modelCacheTtlMs;
  }

  async #loadModels(): Promise<OpenCodeModelOption[]> {
    try {
      const models = await this.withClientLease((client) => this.#discoverModels(client));
      this.#modelCache = {
        models,
        fetchedAt: this.#now(),
      };
      this.#markAvailable();
      return models;
    } catch (err) {
      const reason = errorMessage(err);
      if (this.#markTemporarilyUnavailable(reason)) {
        this.#logger.warn('OpenCode model discovery is unavailable', { reason });
      }
      return this.#cachedModels();
    }
  }

  async #discoverModels(client: any): Promise<OpenCodeModelOption[]> {
    if (typeof client.config?.providers === 'function') {
      const result = await withAbortableTimeout(
        (signal) => client.config.providers(undefined, { signal }),
        this.#options.modelDiscoveryTimeoutMs,
        'OpenCode model discovery',
      );
      return modelsFromProviders(configuredProvidersFromResult(result));
    }

    const result = await withAbortableTimeout(
      (signal) => client.provider.list(undefined, { signal }),
      this.#options.modelDiscoveryTimeoutMs,
      'OpenCode provider list',
    );
    return modelsFromProviders(connectedProvidersFromListResult(result));
  }

  async #runRequest<T>(
    label: string,
    operation: (signal: AbortSignal) => Promise<T>,
    control: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
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
        if (this.#markTemporarilyUnavailable(reason)) {
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
    void images;
    void thinkingMode;
    const scope = createOpenCodeRequestScope(projectPath);

    await this.#ensureOpenCodeServer();
    await this.#globalEventListener.start(scope.directory);

    const client = await this.getClient();
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
    this.#sessions.set(agentSessionId, {
      status: 'running',
      chatId,
      model,
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
    request.onSessionActivated?.(agentSessionId);
    this.#logger.info('OpenCode session created and registered', { agentSessionId });

    try {
      await this.#globalEventListener.start(scope.directory);
      const activeSession = this.#sessions.get(agentSessionId);
      if (!activeSession || activeSession.status !== 'running' || activeSession.turn !== turn) {
        throw new Error('OpenCode event stream ended before prompt delivery');
      }
      if (request.executionAdmission) await markOpenCodeExecutionStarted(request);
    } catch (error) {
      this.#operationRoutes.unregister(route);
      this.#sessions.delete(agentSessionId);
      await this.#runScopedSessionRequest(
        'OpenCode cancelled session delete',
        scope,
        (signal, requestScope) => client.session.delete(
          withOpenCodeRequestScope({ sessionID: agentSessionId }, requestScope),
          { signal },
        ),
      ).catch(() => undefined);
      throw error;
    }

    const promptBody = buildPromptBody(command, model, turn.providerPromptPartId);

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
      if (this.isTemporarilyUnavailable()) this.#closeInstanceIfIdle();
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
    void images;
    void thinkingMode;
    const pendingSession = this.#sessions.get(agentSessionId);
    if (pendingSession) await this.#quiesceSessionBeforeTurn(agentSessionId, pendingSession);
    const session = this.#sessions.get(agentSessionId);
    const requestScope = createOpenCodeRequestScope(projectPath);
    const scope = requestScope.directory ? requestScope : { directory: session?.directory };

    await this.#ensureOpenCodeServer();
    await this.#globalEventListener.start(scope.directory);
    assertOpenCodeExecutionOpen(request);

    const turn = createOpenCodeTurnContext(operation);
    const client = await this.getClient();
    if (session) {
      await this.#quiesceRetiredProviderWork(client, agentSessionId, session, scope);
      await this.steering.removeUnconsumed(client, agentSessionId, session, scope);
    }
    const waiter = this.#createTurnWaiter(agentSessionId);
    if (session) {
      session.status = 'running';
      session.aborting = false;
      session.activeSteeringDeliveries = 0;
      session.deferredTerminal = null;
      session.chatId = chatId;
      session.model = model;
      session.permissionMode = permissionMode;
      session.directory = scope.directory;
      session.lastActivityAt = Date.now();
      session.turn = turn;
    } else {
      this.#sessions.set(agentSessionId, {
        status: 'running',
        chatId,
        model,
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
    }
    const route = this.#operationRoutes.register(
      agentSessionId,
      chatId,
      turn,
      false,
      permissionMode,
      scope.directory,
    );
    const promptBody = buildPromptBody(command, model, turn.providerPromptPartId);

    try {
      await this.#globalEventListener.start(scope.directory);
      const activeSession = this.#sessions.get(agentSessionId);
      if (!activeSession || activeSession.status !== 'running' || activeSession.turn !== turn) {
        throw new Error('OpenCode event stream ended before prompt delivery');
      }
      if (request.executionAdmission) await markOpenCodeExecutionStarted(request);
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
      if (turn.providerMessageId === null) this.#operationRoutes.unregister(route);
      const sess = this.#sessions.get(agentSessionId);
      if (request.executionAdmission?.signal.aborted) {
        if (sess?.turn === turn) {
          sess.providerWorkRequiresQuiescence = true;
          sess.status = 'completed';
          sess.lastActivityAt = Date.now();
        }
        this.#clearTurnWaiter(agentSessionId);
        throw err;
      }
      this.#logger.error('OpenCode query failed', { agentSessionId, error: err.message });
      if (!sess || sess.status !== 'running' || sess.turn !== turn) throw err;
      this.steering.stagePendingCleanup(sess);
      sess.providerWorkRequiresQuiescence = true;
      sess.status = 'completed';
      sess.lastActivityAt = Date.now();
      this.#clearTurnWaiter(agentSessionId);
      this.#publishFailed(agentSessionId, turn.operation, err.message);
      throw err;
    }

    const turnFailure = await waiter.promise;
    if (turnFailure) throw turnFailure;
    } finally {
      this.#endpointCoordinator.turnAdmissionFinished();
      if (this.isTemporarilyUnavailable()) this.#closeInstanceIfIdle();
    }
  }

  async forkSession(
    sourceSessionId: string,
    options: { projectPath?: string | null } = {},
  ): Promise<string> {
    return this.#endpointCoordinator.forkSession(
      sourceSessionId,
      options.projectPath,
      (label, scope, operation) => this.#runScopedSessionRequest(label, scope, operation),
    );
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
    this.#cancelPendingPermissionsForSession(agentSessionId, 'aborted');
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

  async #resolvePermission(
    pending: PendingPermission,
    decision: { allow: boolean; alwaysAllow?: boolean },
  ): Promise<void> {
    if (!this.#pendingPermissions.has(pending)) {
      throw new Error('OpenCode permission occurrence is no longer pending');
    }
    const allow = Boolean(decision?.allow);
    const reply = mapPermissionDecision(decision);
    const client = await this.getClient();
    const result = await this.#runScopedSessionRequest(
      'OpenCode permission reply',
      { directory: pending.directory },
      (signal, requestScope) => client.permission.reply(
        withOpenCodeRequestScope({
          requestID: pending.originalRequestId,
          reply,
          message: allow ? undefined : 'User denied tool use',
        }, requestScope),
        { signal },
      ),
    );
    throwOpenCodeResultError(result, 'OpenCode permission reply failed');
    this.#pendingPermissions.delete(pending);
  }

  async runSingleQuery(prompt: string, options: Record<string, any> = {}): Promise<string> {
    const thinkingMode = normalizeThinkingMode(options.thinkingMode);
    if (thinkingMode !== 'none') {
      throw new AgentIntegrationError(
        'OPERATION_UNSUPPORTED',
        `opencode does not support explicit one-shot effort ${thinkingMode}.`,
        false,
        AGENT_UNSUPPORTED_SINGLE_QUERY_THINKING_MODE,
      );
    }
    const { cwd, projectPath, model, permissionMode = 'default' } = options;
    const scope = createOpenCodeRequestScope(projectPath || cwd);
    const requestTimeoutMs = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
      ? Math.max(1, Math.round(options.timeoutMs))
      : undefined;
    return withSingleQueryControl(options, async (signal) => this.withClientLease(async (client) => {
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
        const parsedModel = parseOpenCodeModel(model);
        const body: Record<string, unknown> = {
          parts: [{ type: 'text', text: prompt }],
          tools: { '*': false },
        };
        if (parsedModel) body.model = parsedModel;

        const promptResult: any = await this.#runScopedSessionRequest<any>(
          'OpenCode prompt',
          scope,
          (requestSignal, requestScope) => client.session.prompt(withOpenCodeRequestScope({
            sessionID: sessionId,
            ...body,
          }, requestScope), { signal: requestSignal }),
          { signal, timeoutMs: requestTimeoutMs },
        );

        throwOpenCodeResultError(promptResult, 'OpenCode one-shot prompt failed');
        return extractTextParts(promptResult.data?.parts);
      } finally {
        await this.#runScopedSessionRequest(
          'OpenCode session delete',
          scope,
          (requestSignal, requestScope) => client.session.delete(
            withOpenCodeRequestScope({ sessionID: sessionId }, requestScope),
            { signal: requestSignal },
          ),
        ).then((result) => {
          throwOpenCodeResultError(result, 'OpenCode session delete failed');
        }).catch(() => {});
      }
    }));
  }

  startPurgeTimer(): void {
    this.#idlePurger.start();
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
    || eventType === 'session.error';
}
