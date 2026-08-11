// OpenCode SDK integration. Extends AgentEventEmitterRuntime so all output flows
// through typed events wired in the composition root.

import crypto from 'crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { isRecord } from '@garcon/common/json';
import { errorMessage } from '@garcon/server-agent-common/lib/errors';
import { buildPromptBody, parseOpenCodeModel } from './prompt.js';
import { extractSessionId, extractTextParts, isOpenCodeAbortError, isOpenCodeContextOverflowError, openCodeSessionError, type SSEEvent } from './sse-events.js';
import {
  acceptUniqueOpenCodeTurnEvent,
  createOpenCodeTurnContext,
  openCodeEventBelongsToTurn,
  type OpenCodeSession,
} from './turn-events.js';
import { ErrorMessage, PermissionRequestMessage, PermissionResolvedMessage, PermissionCancelledMessage } from '@garcon/common/chat-types';
import type { ChatMessage } from '@garcon/common/chat-types';
import { convertOpencodePermissionTool } from "./permission-tool-converter.js";
import { AgentEventEmitterRuntime } from '@garcon/server-agent-common/shared/event-emitter-runtime';
import { IdleSessionPurger } from '@garcon/server-agent-common/shared/idle-session-purger';
import type { OpenCodeConfig } from '../../config.js';
import { normalizeThinkingMode } from '@garcon/common/chat-modes';
import {
  assertOpenCodeExecutionOpen,
  markOpenCodeExecutionStarted,
  openCodeEventMetadata,
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
  AGENT_UNSUPPORTED_SINGLE_QUERY_THINKING_MODE,
  AgentIntegrationError,
  type AgentLogger,
} from '@garcon/server-agent-interface';
import type { RuntimeEventMetadata } from '@garcon/server-agent-common/shared/event-emitter-runtime';
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
const OPENCODE_SERVER_CONFIG_CONTENT = JSON.stringify({});

// Source of OpenCode permission keys:
// - https://github.com/anomalyco/opencode/blob/f5eade1d2b95562c7fb58e3041e662a8b2b611b6/packages/web/src/content/docs/permissions.mdx
// - https://github.com/anomalyco/opencode/blob/f5eade1d2b95562c7fb58e3041e662a8b2b611b6/packages/opencode/src/agent/agent.ts
export const OPENCODE_PERMISSION_KEYS = Object.freeze([
  'read',
  'edit',
  'glob',
  'grep',
  'list',
  'bash',
  'task',
  'skill',
  'lsp',
  'todoread',
  'todowrite',
  'webfetch',
  'websearch',
  'codesearch',
  'external_directory',
  'doom_loop',
  'question',
  'plan_enter',
  'plan_exit',
] as const);

export function mapPermissionMode(mode: string): Array<{ permission: string; pattern: string; action: string }> {
  const map: Record<string, Record<string, string>> = {
    acceptEdits: { edit: 'allow', bash: 'ask', webfetch: 'allow' },
    bypassPermissions: Object.fromEntries(OPENCODE_PERMISSION_KEYS.map((permission) => [permission, 'allow'])),
    manualBypass: { edit: 'ask', bash: 'ask', webfetch: 'ask' },
    default: { edit: 'ask', bash: 'ask', webfetch: 'ask' },
  };

  const selected = map[mode] || map.default;

  return Object.entries(selected).map(([permission, action]) => ({
    permission,
    pattern: '*',
    action,
  }));
}

// Maps a permission decision to V2 reply value.
export function mapPermissionDecision(decision: { allow?: boolean; alwaysAllow?: boolean } | null | undefined): string {
  const allow = Boolean(decision?.allow);
  const alwaysAllow = Boolean(decision?.alwaysAllow);
  return allow ? (alwaysAllow ? 'always' : 'once') : 'reject';
}

// Extracts a normalized permission request from a V2 permission.asked event.
export function extractPermissionRequest(event: SSEEvent): {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  sessionID: string | null;
} | null {
  if (event.type !== 'permission.asked') return null;

  const props = event.properties || {};
  const requestId = props.requestID || props.id;
  if (!requestId) return null;

  return {
    requestId: String(requestId),
    toolName: props.permission || 'Unknown',
    toolInput: {
      permission: props.permission || null,
      patterns: Array.isArray(props.patterns) ? props.patterns : [],
      metadata: props.metadata || {},
      always: Array.isArray(props.always) ? props.always : [],
      tool: props.tool || null,
    },
    sessionID: props.sessionID || null,
  };
}

interface PendingTurnWaiter {
  promise: Promise<Error | null>;
  settle: (failure: Error | null) => void;
}

interface PendingPermission {
  originalRequestId: string;
  agentSessionId: string;
  chatId: string;
  directory?: string;
  eventMetadata: RuntimeEventMetadata;
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

interface OpenCodeModelOption {
  value: string;
  label: string;
}

interface OpenCodeModelCache {
  models: OpenCodeModelOption[];
  fetchedAt: number;
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

export function buildOpenCodeServerEnv(
  baseEnv: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  return {
    ...baseEnv,
    OPENCODE_CONFIG_CONTENT: OPENCODE_SERVER_CONFIG_CONTENT,
    OPENCODE_DISABLE_AUTOUPDATE: '1',
  };
}

function configuredProvidersFromResult(result: any): any[] {
  const providers = result?.data?.providers;
  return Array.isArray(providers) ? providers : [];
}

function connectedProvidersFromListResult(result: any): any[] {
  const data = result?.data;
  const allProviders: any[] = Array.isArray(data?.all) ? data.all : [];
  const connected = new Set<string>(Array.isArray(data?.connected) ? data.connected : []);
  return allProviders.filter((provider) => connected.has(provider.id || provider.name));
}

function modelsFromProviders(providers: any[]): OpenCodeModelOption[] {
  const models: OpenCodeModelOption[] = [];
  for (const provider of providers) {
    const providerId = provider.id || provider.name;
    const providerName = provider.name || providerId;
    const agentModelsObj = provider.models || {};
    for (const [modelKey, model] of Object.entries(agentModelsObj)) {
      if (!isRecord(model)) continue;
      const modelId = typeof model.id === 'string' ? model.id : modelKey;
      models.push({
        value: `${providerId}/${modelId}`,
        label: `${providerName}: ${typeof model.name === 'string' ? model.name : modelId}`,
      });
    }
  }
  return models;
}

function stopOpenCodeProcess(proc: ChildProcess): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return;

  proc.kill();
  proc.stdout?.destroy();
  proc.stderr?.destroy();

  const killTimer = setTimeout(() => {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGKILL');
    }
  }, 500);
  killTimer.unref?.();
  proc.once('exit', () => clearTimeout(killTimer));
}

async function createOpenCodeInstance(input: {
  port: number;
  signal: AbortSignal;
}): Promise<OpenCodeInstance> {
  const { createOpencodeClient } = await import('@opencode-ai/sdk/v2');
  const proc = spawn('opencode', ['serve', '--hostname=127.0.0.1', `--port=${input.port}`], {
    env: buildOpenCodeServerEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const url = await new Promise<string>((resolve, reject) => {
    let output = '';
    let resolved = false;

    const cleanup = () => {
      input.signal.removeEventListener('abort', abort);
      proc.off('exit', onExit);
      proc.off('error', onError);
      proc.stdout.off('data', onStdout);
      proc.stderr.off('data', onStderr);
    };

    const fail = (error: unknown) => {
      if (resolved) return;
      cleanup();
      stopOpenCodeProcess(proc);
      reject(error);
    };

    const abort = () => {
      fail(input.signal.reason ?? new Error('OpenCode startup aborted'));
    };

    const onStdout = (chunk: Buffer) => {
      if (resolved) return;
      output += chunk.toString();
      const lines = output.split('\n');
      for (const line of lines) {
        if (!line.startsWith('opencode server listening')) continue;
        const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
        if (!match) {
          fail(new Error(`Failed to parse OpenCode server URL from output: ${line}`));
          return;
        }
        resolved = true;
        cleanup();
        resolve(match[1]);
        return;
      }
    };

    const onStderr = (chunk: Buffer) => {
      output += chunk.toString();
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const detail = output.trim() ? `\nServer output: ${output.trim()}` : '';
      fail(new Error(`OpenCode server exited before startup with code ${code ?? signal}${detail}`));
    };

    const onError = (error: Error) => {
      fail(error);
    };

    input.signal.addEventListener('abort', abort, { once: true });
    proc.stdout.on('data', onStdout);
    proc.stderr.on('data', onStderr);
    proc.on('exit', onExit);
    proc.on('error', onError);

    if (input.signal.aborted) abort();
  });

  const close = () => stopOpenCodeProcess(proc);
  return {
    client: createOpencodeClient({ baseUrl: url }),
    baseUrl: url,
    server: { close },
  };
}

export class OpenCodeRuntime extends AgentEventEmitterRuntime {
  readonly #config: OpenCodeConfig;
  readonly #logger: AgentLogger;
  #instance: OpenCodeInstance | null = null;
  #initPromise: Promise<OpenCodeInstance> | null = null;
  #startupAbortController: AbortController | null = null;
  #shutdownPromise: Promise<void> | null = null;
  #shuttingDown = false;
  #sessions = new Map<string, OpenCodeSession>();
  #pendingTurnWaiters = new Map<string, PendingTurnWaiter>();
  #pendingPermissions = new Map<string, PendingPermission>();
  readonly steering: OpenCodeSteeringController;
  readonly #endpointCoordinator: OpenCodeEndpointCoordinator;
  readonly #globalEventListener: OpenCodeGlobalEventListener;
  #modelCache: OpenCodeModelCache | null = null;
  #modelsPromise: Promise<OpenCodeModelOption[]> | null = null;
  #unavailableUntil = 0;
  #unavailableReason = '';
  readonly #instanceCreations: OpenCodeInstanceCreationTracker;
  #idlePurger = new IdleSessionPurger<OpenCodeSession>({
    sessions: () => this.#sessions.entries(),
    isRunning: (session) => session.status === 'running',
    lastActivityAt: (session) => session.lastActivityAt,
    purge: (sessionId, session) => {
      this.#sessions.delete(sessionId);
    },
  });

  #available: boolean | null = null;
  readonly #options: NormalizedOpenCodeRuntimeOptions;

  constructor(options: OpenCodeRuntimeOptions = {}) {
    super();
    this.#config = options.config ?? { isTestEnvironment: () => false };
    this.#logger = options.logger ?? SILENT_LOGGER;
    this.#options = normalizeOptions(options);
    this.#instanceCreations = new OpenCodeInstanceCreationTracker(() => this.#shuttingDown);
    this.#endpointCoordinator = new OpenCodeEndpointCoordinator({
      assertAvailable: () => this.#assertCanUseOpenCode(),
      ensureUnlocked: () => this.#ensureOpenCodeServerUnlocked(),
      closeInstance: () => this.#closeInstance(),
      hasRunningSessions: () => this.#hasRunningSessions(),
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
      settleIdle: (agentSessionId, session, idleEventId) => (
        this.#settleIdleSession(agentSessionId, session, idleEventId)
      ),
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

  #failRunningTurnsForListenerError(error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error));
    for (const [agentSessionId, session] of this.#sessions) {
      if (session.status !== 'running') continue;
      this.steering.stagePendingCleanup(session);
      const eventMetadata = session.turn.eventMetadata;
      session.providerWorkRequiresQuiescence = true;
      session.status = 'completed';
      session.lastActivityAt = Date.now();
      this.#cancelPendingPermissionsForSession(agentSessionId, 'cancelled');
      this.#rejectTurnWaiter(agentSessionId, failure);
      this.emitProcessing(session.chatId, false);
      this.emitFailed(session.chatId, failure.message, eventMetadata);
    }
    for (const agentSessionId of this.#pendingTurnWaiters.keys()) {
      this.#rejectTurnWaiter(agentSessionId, failure);
    }
  }

  #failTurnForProviderError(agentSessionId: string, session: OpenCodeSession, message: string): void {
    this.steering.stagePendingCleanup(session);
    const metadata = session.turn.eventMetadata;
    session.providerWorkRequiresQuiescence = true;
    session.status = 'completed';
    session.lastActivityAt = Date.now();
    this.#cancelPendingPermissionsForSession(agentSessionId, 'cancelled');
    this.#rejectTurnWaiter(agentSessionId, new Error(message));
    this.emitMessages(session.chatId, [new ErrorMessage(new Date().toISOString(), message)], metadata);
    this.emitProcessing(session.chatId, false);
    this.emitFailed(session.chatId, message, metadata);
  }

  #settleIdleSession(agentSessionId: string, session: OpenCodeSession, idleEventId: string | null): void {
    if (session.status !== 'running' || !session.turn.providerObservedEventId || !idleEventId
      || idleEventId <= session.turn.providerObservedEventId
      || session.turn.assistantMessageIds.size === 0) return;
    if (session.turn.pendingSteeringMessageIds.size > 0) {
      this.#failTurnForProviderError(
        agentSessionId,
        session,
        'OpenCode stopped before processing accepted steering input',
      );
      return;
    }
    const contextOverflow = session.turn.pendingContextOverflowError;
    if (contextOverflow) {
      this.#failTurnForProviderError(agentSessionId, session, contextOverflow);
      return;
    }
    const eventMetadata = session.turn.eventMetadata;
    this.#cancelPendingPermissionsForSession(agentSessionId, 'session-complete');
    session.status = 'completed';
    session.lastActivityAt = Date.now();
    this.#resolveTurnWaiter(agentSessionId);
    this.emitProcessing(session.chatId, false);
    this.emitFinished(session.chatId, 0, eventMetadata);
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

  #dispatchOpenCodeEvent(event: SSEEvent, session: OpenCodeSession): void {
    const chatMessages = convertOpenCodeEventToChatMessages(event, session.turn, this.#logger);
    if (!chatMessages || !chatMessages.length) {
      return;
    }

    this.emitMessages(session.chatId, chatMessages, session.turn.eventMetadata);
  }

  #emitPermissionMessages(
    chatId: string,
    messages: ChatMessage[],
    eventMetadata?: RuntimeEventMetadata,
  ): void {
    if (!messages.length) return;
    this.emitMessages(chatId, messages, eventMetadata);
  }

  #replyManualBypassPermission(
    client: any,
    agentSessionId: string,
    session: OpenCodeSession,
    requestId: string,
  ): void {
    const turn = session.turn;
    void this.#runScopedSessionRequest(
      'OpenCode manual bypass permission reply',
      { directory: session.directory },
      (signal, requestScope) => client.permission.reply(
        withOpenCodeRequestScope({ requestID: requestId, reply: 'once' }, requestScope),
        { signal },
      ),
    ).then((result) => {
      throwOpenCodeResultError(result, 'OpenCode manual bypass permission reply failed');
    }).catch((error) => {
      const current = this.#sessions.get(agentSessionId);
      if (
        current !== session
        || current.status !== 'running'
        || current.turn !== turn
      ) {
        this.#logger.debug('Ignoring a late OpenCode manual bypass reply failure', {
          agentSessionId,
          error: errorMessage(error),
        });
        return;
      }
      this.#failTurnForProviderError(agentSessionId, current, errorMessage(error));
    });
  }

  #cancelPendingPermissionsForSession(agentSessionId: string, reason: 'cancelled' | 'session-complete' | 'aborted'): void {
    for (const [permissionRequestId, pending] of this.#pendingPermissions.entries()) {
      if (pending.agentSessionId !== agentSessionId) continue;
      this.#pendingPermissions.delete(permissionRequestId);
      this.#emitPermissionMessages(
        pending.chatId,
        [new PermissionCancelledMessage(new Date().toISOString(), permissionRequestId, reason)],
        pending.eventMetadata,
      );
    }
  }

  #extractPermissionRequestFromEvent(event: SSEEvent) {
    return extractPermissionRequest(event);
  }

  #handleGlobalSSEEvent(client: any, event: SSEEvent): void {
    const sessionId = extractSessionId(event);
    if (!sessionId) {
      if (event.type !== 'server.heartbeat') {
        this.#logger.debug('OpenCode SSE event has no session ID', { eventType: event.type });
      }
      return;
    }

    // Turn-bound dispatch is running-only: retired turns cannot accept late provider events.
    const session = this.#sessions.get(sessionId);
    if (!session || session.status !== 'running') {
      this.#logger.debug('OpenCode SSE event targets a non-running session', {
        eventType: event.type,
        sessionId,
        knownSessionIds: [...this.#sessions.keys()],
      });
      return;
    }
    if (!acceptUniqueOpenCodeTurnEvent(session, event, this.#logger)) return;

    const chatId = session.chatId;
    if (!chatId) {
      this.#logger.debug('OpenCode SSE event arrived before chat assignment', {
        eventType: event.type,
        sessionId,
      });
      return;
    }
    if (
      session.terminalEventsFencedUntilPrompt
      && (event.type === 'session.error'
        || (event.type === 'session.status' && event.properties?.status?.type === 'idle'))
    ) {
      this.#logger.debug('Ignoring an OpenCode terminal event before successor prompt binding', {
        eventType: event.type,
        sessionId,
      });
      return;
    }
    if (isOpenCodeAbortError(event)) {
      this.#logger.debug('Ignoring OpenCode abort unwind for a Garcon-retired turn', { sessionId });
      return;
    }

    const sessionError = openCodeSessionError(event);
    if (sessionError) {
      if (isOpenCodeContextOverflowError(event)) {
        session.turn.pendingContextOverflowError = sessionError;
        return;
      }
      // A non-recoverable provider error must retire the turn before idle can claim success.
      this.#failTurnForProviderError(sessionId, session, sessionError);
      return;
    }
    if (event.type === 'permission.asked') {
      this.#handlePermissionEvent(client, event, sessionId, session, chatId);
      return;
    }
    this.steering.observeAcknowledgement(session, event);
    if (!openCodeEventBelongsToTurn(session, event)) return;
    this.#dispatchOpenCodeEvent(event, session);

    if (event.type !== 'session.status' || event.properties?.status?.type !== 'idle') return;
    if (session.aborting) {
      session.skippedIdleEventId = event.id ?? null;
      return;
    }
    if (session.activeSteeringDeliveries > 0) {
      this.steering.deferIdle(session, event.id ?? null);
      return;
    }
    this.#settleIdleSession(sessionId, session, event.id ?? null);
  }

  #handlePermissionEvent(
    client: any,
    event: SSEEvent,
    sessionId: string,
    session: OpenCodeSession,
    chatId: string,
  ): void {
    const toolMessageId = event.properties?.tool?.messageID;
    if (
      typeof toolMessageId === 'string'
      && !session.turn.assistantMessageIds.has(toolMessageId)
    ) return;
    const permission = this.#extractPermissionRequestFromEvent(event);
    if (!permission) return;
    if (session.permissionMode === 'manualBypass') {
      this.#replyManualBypassPermission(client, sessionId, session, permission.requestId);
      return;
    }
    const permissionRequestId = `opencode-${crypto.randomBytes(8).toString('hex')}`;
    this.#pendingPermissions.set(permissionRequestId, {
      originalRequestId: permission.requestId,
      agentSessionId: sessionId,
      chatId,
      directory: session.directory,
      eventMetadata: session.turn.eventMetadata,
    });
    const now = new Date().toISOString();
    this.#emitPermissionMessages(chatId, [
      new PermissionRequestMessage(
        now,
        permissionRequestId,
        convertOpencodePermissionTool(now, permissionRequestId, permission.toolInput),
      ),
    ], session.turn.eventMetadata);
  }

  async getClient(): Promise<any> {
    this.#assertCanUseOpenCode();
    const instance = await this.#ensureOpenCodeServer();
    return instance.client;
  }
  withClientLease<T>(operation: (client: any) => Promise<T>): Promise<T> {
    return this.#endpointCoordinator.withClientLease(operation);
  }
  getTranscriptIndexEndpoint(signal: AbortSignal): Promise<string> {
    return this.#endpointCoordinator.getTranscriptEndpoint(signal);
  }
  refreshTranscriptIndexEndpoint(failedBaseUrl: string, signal: AbortSignal): Promise<string> {
    return this.#endpointCoordinator.refreshTranscriptEndpoint(failedBaseUrl, signal);
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
    const result = await this.#runRequest<T>(label, (signal) => operation(signal, scope), control);
    if (!scope.directory || !isOpenCodeNotFoundResult(result)) return result;

    this.#logger.warn('OpenCode request missed the scoped directory; retrying without it', {
      label,
      directory: scope.directory,
    });
    return await this.#runRequest<T>(`${label} legacy`, (signal) => operation(signal, {}), control);
  }

  async #confirmGlobalEventDelivery(input: {
    client: any;
    directory?: string;
    signal: AbortSignal;
    waitForEvent(matches: (event: SSEEvent) => boolean): Promise<SSEEvent>;
  }): Promise<void> {
    const marker = `garcon-event-stream-readiness-${crypto.randomUUID()}`;
    let observed = false;
    let deliveryFailure: unknown;
    const delivery = input.waitForEvent((event) =>
      event.type === 'tui.toast.show'
      && event.properties?.message === marker
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
    session.terminalEventsFencedUntilPrompt = true;
    const result = await this.#runScopedSessionRequest(
      'OpenCode retired session abort',
      scope,
      (signal, requestScope) => client.session.abort(
        withOpenCodeRequestScope({ sessionID: agentSessionId }, requestScope),
        { signal },
      ),
    );
    throwOpenCodeResultError(result, 'OpenCode retired session abort failed');
    session.providerWorkRequiresQuiescence = false;
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
      onAbortable,
      clientRequestId,
      turnId,
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

    const eventMetadata = openCodeEventMetadata(
      { clientRequestId, turnId },
      'chat-start',
    );
    const turn = createOpenCodeTurnContext(eventMetadata, command);
    this.#sessions.set(agentSessionId, {
      status: 'running',
      chatId,
      model,
      permissionMode,
      directory: scope.directory,
      startedAt: new Date().toISOString(),
      lastActivityAt: Date.now(),
      recentEventIds: new Set(),
      providerWorkRequiresQuiescence: false,
      terminalEventsFencedUntilPrompt: false,
      activeSteeringDeliveries: 0,
      deferredIdleEventId: null,
      pendingSteeringRevertMessageId: null,
      turn,
    });
    this.emitSessionCreated(chatId);
    this.#logger.info('OpenCode session created and registered', { agentSessionId });

    try {
      await this.#globalEventListener.start(scope.directory);
      const activeSession = this.#sessions.get(agentSessionId);
      if (!activeSession || activeSession.status !== 'running' || activeSession.turn !== turn) {
        throw new Error('OpenCode event stream ended before prompt delivery');
      }
      if (request.executionAdmission) await markOpenCodeExecutionStarted(request);
      this.emitProcessing(chatId, true);
    } catch (error) {
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

    const promptRequest = this.#runScopedSessionRequest(
      'OpenCode prompt submit',
      scope,
      (signal, requestScope) => client.session.promptAsync(withOpenCodeRequestScope({
        sessionID: agentSessionId,
        ...promptBody,
      }, requestScope), { signal }),
    );
    onAbortable?.();
    promptRequest.then((result) => {
      throwOpenCodeResultError(result, 'OpenCode prompt submit failed');
    }).catch((err: Error) => {
      const sess = this.#sessions.get(agentSessionId);
      if (
        !sess
        || sess.status !== 'running'
        || sess.turn !== turn
      ) return;
      this.#logger.error('OpenCode prompt failed', { agentSessionId, error: err.message });
      this.steering.stagePendingCleanup(sess);
      sess.providerWorkRequiresQuiescence = true;
      sess.status = 'completed';
      sess.lastActivityAt = Date.now();
      this.emitProcessing(chatId, false);
      this.emitFailed(chatId, err.message, eventMetadata);
    });

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
      onAbortable,
      clientRequestId,
      turnId,
    } = request;
    void images;
    void thinkingMode;
    const session = this.#sessions.get(agentSessionId);
    const requestScope = createOpenCodeRequestScope(projectPath);
    const scope = requestScope.directory ? requestScope : { directory: session?.directory };

    await this.#ensureOpenCodeServer();
    await this.#globalEventListener.start(scope.directory);
    assertOpenCodeExecutionOpen(request);

    const eventMetadata = openCodeEventMetadata({ clientRequestId, turnId });
    const turn = createOpenCodeTurnContext(eventMetadata, command);
    const client = await this.getClient();
    if (session) {
      await this.#quiesceRetiredProviderWork(client, agentSessionId, session, scope);
      await this.steering.removeUnconsumed(client, agentSessionId, session, scope);
    }
    const waiter = this.#createTurnWaiter(agentSessionId);
    if (session) {
      session.status = 'running';
      session.aborting = false;
      session.skippedIdleEventId = null;
      session.activeSteeringDeliveries = 0;
      session.deferredIdleEventId = null;
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
        recentEventIds: new Set(),
        providerWorkRequiresQuiescence: false,
        terminalEventsFencedUntilPrompt: false,
        activeSteeringDeliveries: 0,
        deferredIdleEventId: null,
        pendingSteeringRevertMessageId: null,
        turn,
      });
    }
    const promptBody = buildPromptBody(command, model, turn.providerPromptPartId);

    try {
      await this.#globalEventListener.start(scope.directory);
      const activeSession = this.#sessions.get(agentSessionId);
      if (!activeSession || activeSession.status !== 'running' || activeSession.turn !== turn) {
        throw new Error('OpenCode event stream ended before prompt delivery');
      }
      if (request.executionAdmission) await markOpenCodeExecutionStarted(request);
      this.emitProcessing(chatId, true);
      const promptRequest = this.#runScopedSessionRequest(
        'OpenCode prompt submit',
        scope,
        (signal, requestScope) => client.session.promptAsync(withOpenCodeRequestScope({
          sessionID: agentSessionId,
          ...promptBody,
        }, requestScope), { signal }),
      );
      onAbortable?.();
      const result = await promptRequest;
      throwOpenCodeResultError(result, 'OpenCode prompt submit failed');
    } catch (err: any) {
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
      this.emitProcessing(chatId, false);
      this.emitFailed(chatId, err.message, eventMetadata);
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

  async abort(agentSessionId: string): Promise<boolean> {
    const session = this.#sessions.get(agentSessionId);
    if (!session || session.status !== 'running') return false;
    const turn = session.turn;
    session.aborting = true;
    session.skippedIdleEventId = null;

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
    } catch (error) {
      session.aborting = false;
      this.#logger.warn('OpenCode session abort failed', {
        agentSessionId,
        error: errorMessage(error),
      });
      // The abort never happened, so an idle skipped while aborting was a genuine completion.
      // The SSE listener may have recorded a skip concurrently; reset property narrowing.
      const skippedIdleEventId = session.skippedIdleEventId as string | null;
      session.skippedIdleEventId = null;
      this.#settleIdleSession(agentSessionId, session, skippedIdleEventId);
      return false;
    }

    if (
      this.#sessions.get(agentSessionId) !== session
      || session.status !== 'running'
      || session.turn !== turn
    ) return false;
    this.steering.stagePendingCleanup(session);
    session.status = 'aborted';
    session.lastActivityAt = Date.now();
    this.#cancelPendingPermissionsForSession(agentSessionId, 'aborted');
    // The acknowledged stop is turn-terminal work: the terminal event drives
    // the stop-settled sequence and releases the projection operation.
    this.emitProcessing(session.chatId, false);
    this.emitFinished(session.chatId, 0, turn.eventMetadata);
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

  async resolvePermission(permissionRequestId: string, decision: { allow: boolean; alwaysAllow?: boolean }): Promise<void> {
    if (!permissionRequestId) return;
    const pending = this.#pendingPermissions.get(permissionRequestId);
    this.#pendingPermissions.delete(permissionRequestId);
    if (!pending) {
      this.#logger.warn('OpenCode permission response has no pending request', {
        permissionRequestId,
      });
      return;
    }

    const allow = Boolean(decision?.allow);

    if (pending.chatId) {
      this.#emitPermissionMessages(
        pending.chatId,
        [new PermissionResolvedMessage(new Date().toISOString(), permissionRequestId, allow)],
        pending.eventMetadata,
      );
    }

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
