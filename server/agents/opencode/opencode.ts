// OpenCode SDK integration. Extends AgentEventEmitterRuntime so all output flows
// through typed events wired in the composition root.

import crypto from 'crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { normalizeToolResultContent }  from "../shared/normalize-util.js";
import { AssistantMessage, ThinkingMessage, ToolResultMessage, ErrorMessage, PermissionRequestMessage, PermissionResolvedMessage, PermissionCancelledMessage } from "../../../common/chat-types.js";
import { convertOpencodePermissionTool } from "./permission-tool-converter.js";
import { convertOpenCodeToolUse } from "./tool-use-converter.js";
import { AgentEventEmitterRuntime } from "../shared/event-emitter-runtime.js";
import { IdleSessionPurger } from "../shared/idle-session-purger.js";
import { isTestEnvironment } from '../../config.js';
import { normalizeThinkingMode, type PermissionMode } from "../../../common/chat-modes.js";
import type { AgentSessionSettingsPatch, StartSessionRequest, ResumeTurnRequest } from "../session-types.js";
import { createLogger } from '../../lib/log.js';
import {
  createOpenCodeRequestScope,
  isOpenCodeNotFoundResult,
  throwOpenCodeResultError,
  withOpenCodeRequestScope,
  type OpenCodeRequestScope,
} from './sdk-result.js';
import { UnsupportedSingleQueryEffortError } from '../single-query-errors.js';

const logger = createLogger('agents:opencode:opencode');

const DEFAULT_OPENCODE_STARTUP_TIMEOUT_MS = 5_000;
const DEFAULT_OPENCODE_MODEL_DISCOVERY_TIMEOUT_MS = 3_000;
const DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_OPENCODE_UNAVAILABLE_RETRY_MS = 60_000;
const DEFAULT_OPENCODE_MODEL_CACHE_TTL_MS = 5 * 60_000;
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

function buildPromptBody(command: string, model: string | undefined): Record<string, unknown> {
  const body: Record<string, unknown> = {
    parts: [{ type: 'text', text: command }],
  };
  if (model && model.includes('/')) {
    const idx = model.indexOf('/');
    body.model = {
      providerID: model.slice(0, idx),
      modelID: model.slice(idx + 1),
    };
  }
  return body;
}

interface SSEEvent {
  type: string;
  properties?: Record<string, any>;
}

function extractSessionId(event: SSEEvent): string | undefined {
  const props = event.properties || {};
  return props.sessionID
    || props.part?.sessionID
    || props.info?.sessionID
    || (event.type?.startsWith('session.') ? props.info?.id : undefined);
}

function extractTextParts(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
    .map((part: any) => part.text.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function parseOpenCodeModel(model: string | undefined): { providerID: string; modelID: string } | null {
  if (!model || typeof model !== 'string') return null;
  const idx = model.indexOf('/');
  if (idx < 1 || idx === model.length - 1) return null;
  return {
    providerID: model.slice(0, idx),
    modelID: model.slice(idx + 1),
  };
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

interface OpenCodeSession {
  status: 'running' | 'completed' | 'aborted';
  chatId: string;
  model?: string;
  permissionMode: PermissionMode;
  directory?: string;
  startedAt: string;
  lastActivityAt: number;
}

interface PendingTurnWaiter {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface PendingPermission {
  originalRequestId: string;
  agentSessionId: string;
  chatId: string;
  directory?: string;
}

interface OpenCodeRuntimeOptions {
  startupTimeoutMs?: number;
  modelDiscoveryTimeoutMs?: number;
  requestTimeoutMs?: number;
  unavailableRetryMs?: number;
  modelCacheTtlMs?: number;
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
  modelCacheTtlMs: number;
  now: () => number;
  createInstance: (input: {
    port: number;
    signal: AbortSignal;
  }) => Promise<OpenCodeInstance>;
}

interface OpenCodeInstance {
  client: any;
  baseUrl?: string;
  server?: {
    close?: () => void;
  };
  close?: () => void;
}

interface OpenCodeModelOption {
  value: string;
  label: string;
}

interface OpenCodeModelCache {
  models: OpenCodeModelOption[];
  fetchedAt: number;
}

class OpenCodeTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = 'OpenCodeTimeoutError';
  }
}

function normalizeOptions(options: OpenCodeRuntimeOptions): NormalizedOpenCodeRuntimeOptions {
  return {
    startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_OPENCODE_STARTUP_TIMEOUT_MS,
    modelDiscoveryTimeoutMs: options.modelDiscoveryTimeoutMs ?? DEFAULT_OPENCODE_MODEL_DISCOVERY_TIMEOUT_MS,
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS,
    unavailableRetryMs: options.unavailableRetryMs ?? DEFAULT_OPENCODE_UNAVAILABLE_RETRY_MS,
    modelCacheTtlMs: options.modelCacheTtlMs ?? DEFAULT_OPENCODE_MODEL_CACHE_TTL_MS,
    now: options.now ?? (() => Date.now()),
    createInstance: options.createInstance ?? createOpenCodeInstance,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'unknown error');
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
      const m = model as any;
      const modelId = m.id || modelKey;
      models.push({
        value: `${providerId}/${modelId}`,
        label: `${providerName}: ${m.name || modelId}`,
      });
    }
  }
  return models;
}

async function withAbortableTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          const error = new OpenCodeTimeoutError(label, timeoutMs);
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
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
  #instance: OpenCodeInstance | null = null;
  #initPromise: Promise<OpenCodeInstance> | null = null;
  #sseListenerStarted = false;
  #sessions = new Map<string, OpenCodeSession>();
  #pendingTurnWaiters = new Map<string, PendingTurnWaiter>();
  #pendingPermissions = new Map<string, PendingPermission>();
  #messageRoles = new Map<string, Map<string, string>>();
  #assistantPartTypes = new Map<string, Map<string, string>>();
  #modelCache: OpenCodeModelCache | null = null;
  #modelsPromise: Promise<OpenCodeModelOption[]> | null = null;
  #unavailableUntil = 0;
  #unavailableReason = '';
  #searchLeaseCount = 0;
  #idlePurger = new IdleSessionPurger<OpenCodeSession>({
    sessions: () => this.#sessions.entries(),
    isRunning: (session) => session.status === 'running',
    lastActivityAt: (session) => session.lastActivityAt,
    purge: (sessionId, session) => {
      this.#sessions.delete(sessionId);
      this.#messageRoles.delete(session.chatId);
      this.#assistantPartTypes.delete(session.chatId);
    },
  });

  #available: boolean | null = null;
  readonly #options: NormalizedOpenCodeRuntimeOptions;

  constructor(options: OpenCodeRuntimeOptions = {}) {
    super();
    this.#options = normalizeOptions(options);
  }

  // Shuts down the spawned opencode server process (if any).
  // Called during garcon graceful shutdown to prevent orphaned processes.
  shutdown(): void {
    this.#idlePurger.stop();
    for (const agentSessionId of this.#pendingTurnWaiters.keys()) {
      this.#rejectTurnWaiter(agentSessionId, new Error('OpenCode runtime shutting down'));
    }
    this.#sessions.clear();
    this.#pendingPermissions.clear();
    this.#closeInstance();
  }

  // Returns true if the opencode binary is on $PATH, without spawning a server.
  isAvailable(): boolean {
    if (this.#available !== null) return this.#available;
    if (isTestEnvironment()) {
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

  #closeInstanceIfIdle(): void {
    if (!this.#hasRunningSessions() && this.#searchLeaseCount === 0) this.#closeInstance();
  }

  #closeInstance(): void {
    const instance = this.#instance;
    if (instance) {
      try {
        if (typeof instance.server?.close === 'function') {
          instance.server.close();
        } else if (typeof instance.close === 'function') {
          instance.close();
        }
      } catch {
        // Best-effort cleanup.
      }
    }
    this.#instance = null;
    this.#initPromise = null;
    this.#sseListenerStarted = false;
  }

  #createTurnWaiter(agentSessionId: string): PendingTurnWaiter {
    if (this.#pendingTurnWaiters.has(agentSessionId)) {
      throw new Error(`Turn already in progress for session ${agentSessionId}`);
    }
    let resolveFn!: () => void;
    let rejectFn!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    const waiter: PendingTurnWaiter = { promise, resolve: resolveFn, reject: rejectFn };
    this.#pendingTurnWaiters.set(agentSessionId, waiter);
    return waiter;
  }

  #resolveTurnWaiter(agentSessionId: string): void {
    const waiter = this.#pendingTurnWaiters.get(agentSessionId);
    if (!waiter) return;
    this.#pendingTurnWaiters.delete(agentSessionId);
    waiter.resolve();
  }

  #rejectTurnWaiter(agentSessionId: string, error: unknown): void {
    const waiter = this.#pendingTurnWaiters.get(agentSessionId);
    if (!waiter) return;
    this.#pendingTurnWaiters.delete(agentSessionId);
    waiter.reject(error instanceof Error ? error : new Error(String(error || 'OpenCode turn failed')));
  }

  #clearTurnWaiter(agentSessionId: string): void {
    this.#pendingTurnWaiters.delete(agentSessionId);
  }

  async #ensureOpenCodeServer(): Promise<OpenCodeInstance> {
    if (this.#instance) return this.#instance;
    if (this.#initPromise) return this.#initPromise;
    this.#assertCanUseOpenCode();

    let startup: Promise<OpenCodeInstance> | null = null;
    startup = (async () => {
      try {
        if (typeof Bun !== 'undefined' && typeof Bun.which === 'function'
            && !isTestEnvironment() && !Bun.which('opencode')) {
          throw new Error('opencode executable not found in $PATH');
        }

        const port = 10000 + Math.floor(Math.random() * 50000);
        const result: OpenCodeInstance = await withAbortableTimeout(
          (signal) => this.#options.createInstance({ port, signal }),
          this.#options.startupTimeoutMs,
          'OpenCode startup',
        );

        if (!result?.client?.permission?.reply) {
          throw new Error('OpenCode v2 client missing permission.reply; aborting startup');
        }

        this.#instance = result;
        this.#markAvailable();
        return result;
      } catch (err) {
        const reason = errorMessage(err);
        if (this.#markTemporarilyUnavailable(reason)) {
          logger.warn('opencode: marked unavailable after startup failure:', reason);
        }
        throw err;
      } finally {
        if (this.#initPromise === startup) this.#initPromise = null;
      }
    })();

    this.#initPromise = startup;
    return this.#initPromise;
  }

  #convertOpenCodeEventToChatMessages(event: SSEEvent, chatId: string): unknown[] | undefined {
    const chatMessages: unknown[] = [];
    const now = new Date().toISOString();
    const props = event.properties || {};
    const roleFromEvent = (
      props.info?.role
      || props.part?.role
      || props.part?.snapshot?.role
      || props.message?.role
      || null
    );

    const assistantPartTypes = this.#assistantPartTypes.get(chatId) || new Map<string, string>();
    if (!this.#assistantPartTypes.has(chatId)) {
      this.#assistantPartTypes.set(chatId, assistantPartTypes);
    }
    const messageRoles = this.#messageRoles.get(chatId) || new Map<string, string>();
    if (!this.#messageRoles.has(chatId)) {
      this.#messageRoles.set(chatId, messageRoles);
    }

    switch (event.type) {
      case 'message.updated': {
        const info = props.info || {};
        const messageId = info.id;
        if (!messageId) {
          logger.warn(`opencode: missing messageID for ${event.type}:`, event);
          return;
        }
        if (info.finish !== 'stop') {
          if (info.role && info.role !== 'user') {
            messageRoles.set(messageId, info.role);
          }
        } else {
          messageRoles.delete(messageId);
        }
        break;
      }

      case 'message.part.updated': {
        const part = props.part || {};
        if (!part.id) {
          logger.warn(`opencode: missing partID for ${event.type}`);
          return;
        }

        const messageId = part.messageID;
        if (!messageId) {
          logger.warn(`opencode: missing messageID for ${event.type}:`, event);
          return;
        }

        const messageRole = roleFromEvent || messageRoles.get(messageId) || null;
        if (!messageRole) {
          return;
        }

        if (part.type === 'tool') {
          if (part.state?.status === 'completed') {
            chatMessages.push(convertOpenCodeToolUse(now, part));
            chatMessages.push(new ToolResultMessage(now, part.callID || '', normalizeToolResultContent(part.state.output), false));
          } else if (part.state?.status === 'error') {
            chatMessages.push(new ErrorMessage(now, 'Tool Error: ' + (part.state.error || 'Unknown')));
          }
          break;
        }

        if (part.type === 'text' || part.type === 'reasoning') {
          assistantPartTypes.set(part.id, part.type);
        }

        if (part.text) {
          const partType = assistantPartTypes.get(part.id);
          if (!partType) {
            logger.warn(`opencode: final text part not seen earlier:`, event);
            return;
          }
          assistantPartTypes.delete(part.id);

          if (partType === 'text') {
            chatMessages.push(new AssistantMessage(now, part.text));
          } else {
            chatMessages.push(new ThinkingMessage(now, part.text));
          }
        }
        break;
      }

      case 'message.part.delta':
        break;

      default:
        break;
    }

    return chatMessages;
  }

  #dispatchOpenCodeEvent(event: SSEEvent, chatId: string): void {
    const chatMessages = this.#convertOpenCodeEventToChatMessages(event, chatId);
    if (!chatMessages || !chatMessages.length) {
      return;
    }

    this.emitMessages(chatId, chatMessages);
  }

  #emitPermissionMessages(chatId: string, messages: unknown[]): void {
    if (!messages.length) return;
    this.emitMessages(chatId, messages);
  }

  #cancelPendingPermissionsForSession(agentSessionId: string, reason: 'cancelled' | 'session-complete' | 'aborted'): void {
    for (const [permissionRequestId, pending] of this.#pendingPermissions.entries()) {
      if (pending.agentSessionId !== agentSessionId) continue;
      this.#pendingPermissions.delete(permissionRequestId);
      this.#emitPermissionMessages(pending.chatId, [new PermissionCancelledMessage(new Date().toISOString(), permissionRequestId, reason)]);
    }
  }

  #extractPermissionRequestFromEvent(event: SSEEvent) {
    return extractPermissionRequest(event);
  }

  async #startGlobalSSEListener(): Promise<void> {
    if (this.#sseListenerStarted) return;
    this.#sseListenerStarted = true;

    const runListener = async () => {
      try {
        const client = await this.getClient();
        const result: any = await this.#runRequest<any>(
          'OpenCode event subscribe',
          (signal) => client.event.subscribe(undefined, { signal }),
        );

        for await (const event of result.stream) {
          const sessionId = extractSessionId(event);
          if (!sessionId) {
            if (event.type !== 'server.heartbeat') {
              logger.debug('opencode: SSE event with no sessionId, type:', event.type);
            }
            continue;
          }

          const session = this.#sessions.get(sessionId);
          if (!session || session.status === 'aborted') {
            logger.debug('opencode: SSE event for unknown/aborted session:', event.type, 'sid:', sessionId, 'known:', [...this.#sessions.keys()]);
            continue;
          }

          const chatId = session.chatId;
          if (!chatId) {
            logger.debug('opencode: SSE event before chatId assigned:', event.type, 'sid:', sessionId);
            continue;
          }

          if (event.type === 'permission.asked') {
            const permission = this.#extractPermissionRequestFromEvent(event);
            if (!permission) continue;
            if (session.permissionMode === 'manualBypass') {
              const client = await this.getClient();
              const result = await this.#runScopedSessionRequest(
                'OpenCode manual bypass permission reply',
                { directory: session.directory },
                (signal, requestScope) => client.permission.reply(
                  withOpenCodeRequestScope({
                    requestID: permission.requestId,
                    reply: 'once',
                  }, requestScope),
                  { signal },
                ),
              );
              throwOpenCodeResultError(result, 'OpenCode manual bypass permission reply failed');
              continue;
            }
            const permissionRequestId = `opencode-${crypto.randomBytes(8).toString('hex')}`;
            this.#pendingPermissions.set(permissionRequestId, {
              originalRequestId: permission.requestId,
              agentSessionId: sessionId,
              chatId,
              directory: session.directory,
            });

            const now = new Date().toISOString();
            this.#emitPermissionMessages(chatId, [
              new PermissionRequestMessage(
                now,
                permissionRequestId,
                convertOpencodePermissionTool(now, permissionRequestId, permission.toolInput),
              ),
            ]);

            continue;
          }

          this.#dispatchOpenCodeEvent(event, chatId);

          if (event.type === 'session.status') {
            const status = event.properties?.status;
            if (status?.type === 'idle') {
              this.#cancelPendingPermissionsForSession(sessionId, 'session-complete');
              session.status = 'completed';
              session.lastActivityAt = Date.now();
              this.#resolveTurnWaiter(sessionId);
              this.emitProcessing(chatId, false);
              this.emitFinished(chatId);
            }
          }
        }
      } catch (err: any) {
        for (const sessionId of this.#pendingTurnWaiters.keys()) {
          this.#rejectTurnWaiter(sessionId, err);
        }
        const retryMs = this.isTemporarilyUnavailable()
          ? Math.max(3000, Math.min(this.getUnavailableRetryAfterMs(), 30_000))
          : 3000;
        logger.error(`opencode: SSE listener error, reconnecting in ${Math.round(retryMs / 1000)}s:`, err.message);
        this.#sseListenerStarted = false;
        setTimeout(() => this.#startGlobalSSEListener(), retryMs);
      }
    };

    runListener();
  }

  async getClient(): Promise<any> {
    this.#assertCanUseOpenCode();
    const instance = await this.#ensureOpenCodeServer();
    return instance.client;
  }

  async acquireSearchServerLease(): Promise<{ baseUrl: string; release: () => void }> {
    this.#assertCanUseOpenCode();
    const instance = await this.#ensureOpenCodeServer();
    if (!instance.baseUrl) {
      throw new Error('OpenCode server URL is unavailable for transcript search');
    }
    this.#searchLeaseCount += 1;
    let released = false;
    return {
      baseUrl: instance.baseUrl,
      release: () => {
        if (released) return;
        released = true;
        this.#searchLeaseCount = Math.max(0, this.#searchLeaseCount - 1);
        this.#closeInstanceIfIdle();
      },
    };
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
      const client = await this.getClient();
      const models = await this.#discoverModels(client);
      this.#modelCache = {
        models,
        fetchedAt: this.#now(),
      };
      this.#markAvailable();
      return models;
    } catch (err) {
      const reason = errorMessage(err);
      if (this.#markTemporarilyUnavailable(reason)) {
        logger.warn('opencode: model discovery unavailable:', reason);
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

  async #runRequest<T>(label: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    try {
      return await withAbortableTimeout(operation, this.#options.requestTimeoutMs, label);
    } catch (err) {
      if (err instanceof OpenCodeTimeoutError) {
        const reason = errorMessage(err);
        if (this.#markTemporarilyUnavailable(reason)) {
          logger.warn('opencode: request timed out:', reason);
        }
      }
      throw err;
    }
  }

  async #runScopedSessionRequest<T>(
    label: string,
    scope: OpenCodeRequestScope,
    operation: (signal: AbortSignal, scope: OpenCodeRequestScope) => Promise<T>,
  ): Promise<T> {
    const result = await this.#runRequest<T>(label, (signal) => operation(signal, scope));
    if (!scope.directory || !isOpenCodeNotFoundResult(result)) return result;

    logger.warn(`opencode: ${label} missed directory ${scope.directory}; retrying without directory`);
    return await this.#runRequest<T>(`${label} legacy`, (signal) => operation(signal, {}));
  }

  async startSession({
    command,
    chatId,
    images,
    model,
    permissionMode = 'default',
    projectPath,
    thinkingMode,
  }: StartSessionRequest): Promise<string> {
    void images;
    void thinkingMode;

    await this.#ensureOpenCodeServer();
    await this.#startGlobalSSEListener();

    const client = await this.getClient();
    const scope = createOpenCodeRequestScope(projectPath);
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

    this.#sessions.set(agentSessionId, {
      status: 'running',
      chatId,
      model,
      permissionMode,
      directory: scope.directory,
      startedAt: new Date().toISOString(),
      lastActivityAt: Date.now(),
    });
    this.emitProcessing(chatId, true);
    this.emitSessionCreated(chatId);
    logger.info('opencode: session created and registered:', agentSessionId);

    const promptBody = buildPromptBody(command, model);

    this.#runScopedSessionRequest(
      'OpenCode prompt submit',
      scope,
      (signal, requestScope) => client.session.promptAsync(withOpenCodeRequestScope({
        sessionID: agentSessionId,
        ...promptBody,
      }, requestScope), { signal }),
    ).then((result) => {
      throwOpenCodeResultError(result, 'OpenCode prompt submit failed');
    }).catch((err: Error) => {
      logger.error(`opencode: prompt failed for session ${agentSessionId}:`, err.message);
      const sess = this.#sessions.get(agentSessionId);
      if (sess) {
        sess.status = 'completed';
        sess.lastActivityAt = Date.now();
      }
      this.emitProcessing(chatId, false);
      this.emitFailed(chatId, err.message);
    });

    return agentSessionId;
  }

  async runTurn({
    command,
    agentSessionId,
    chatId,
    images,
    model,
    permissionMode,
    projectPath,
    thinkingMode,
  }: ResumeTurnRequest): Promise<void> {
    void images;
    void thinkingMode;

    await this.#ensureOpenCodeServer();
    await this.#startGlobalSSEListener();

    const session = this.#sessions.get(agentSessionId);
    const requestScope = createOpenCodeRequestScope(projectPath);
    const scope = requestScope.directory ? requestScope : { directory: session?.directory };
    if (session) {
      session.status = 'running';
      session.chatId = chatId;
      session.permissionMode = permissionMode;
      session.directory = scope.directory;
      session.lastActivityAt = Date.now();
    } else {
      this.#sessions.set(agentSessionId, {
        status: 'running',
        chatId,
        model,
        permissionMode,
        directory: scope.directory,
        startedAt: new Date().toISOString(),
        lastActivityAt: Date.now(),
      });
    }
    this.emitProcessing(chatId, true);

    const client = await this.getClient();
    const promptBody = buildPromptBody(command, model);
    const waiter = this.#createTurnWaiter(agentSessionId);

    try {
      const result = await this.#runScopedSessionRequest(
        'OpenCode prompt submit',
        scope,
        (signal, requestScope) => client.session.promptAsync(withOpenCodeRequestScope({
          sessionID: agentSessionId,
          ...promptBody,
        }, requestScope), { signal }),
      );
      throwOpenCodeResultError(result, 'OpenCode prompt submit failed');
    } catch (err: any) {
      logger.error(`opencode: query failed for session ${agentSessionId}:`, err.message);
      const sess = this.#sessions.get(agentSessionId);
      if (sess) {
        sess.status = 'completed';
        sess.lastActivityAt = Date.now();
      }
      this.#clearTurnWaiter(agentSessionId);
      this.emitProcessing(chatId, false);
      this.emitFailed(chatId, err.message);
      throw err;
    }

    await waiter.promise;
  }

  async forkSession(
    sourceSessionId: string,
    options: { projectPath?: string | null } = {},
  ): Promise<string> {
    const sessionID = sourceSessionId.trim();
    if (!sessionID) {
      throw new Error('Cannot fork OpenCode session: missing source session id');
    }

    await this.#ensureOpenCodeServer();

    const client = await this.getClient();
    const scope = createOpenCodeRequestScope(options.projectPath);
    const result: any = await this.#runScopedSessionRequest<any>(
      'OpenCode session fork',
      scope,
      (signal, requestScope) => client.session.fork(
        withOpenCodeRequestScope({ sessionID }, requestScope),
        { signal },
      ),
    );

    throwOpenCodeResultError(result, 'OpenCode session fork failed');

    const forkedSessionId = typeof result?.data?.id === 'string'
      ? result.data.id.trim()
      : '';
    if (!forkedSessionId) {
      throw new Error('OpenCode session fork did not return a session id');
    }

    logger.info('opencode: session forked:', sessionID, '->', forkedSessionId);
    return forkedSessionId;
  }

  abort(agentSessionId: string): boolean {
    const session = this.#sessions.get(agentSessionId);
    if (!session) return false;

    session.status = 'aborted';
    session.lastActivityAt = Date.now();
    this.#rejectTurnWaiter(agentSessionId, new Error('OpenCode session aborted'));
    this.#cancelPendingPermissionsForSession(agentSessionId, 'aborted');
    this.getClient().then((client: any) => {
      this.#runScopedSessionRequest(
        'OpenCode session abort',
        { directory: session.directory },
        (signal, requestScope) => client.session.abort(
          withOpenCodeRequestScope({ sessionID: agentSessionId }, requestScope),
          { signal },
        ),
      ).then((result) => {
        throwOpenCodeResultError(result, 'OpenCode session abort failed');
      }).catch((err: Error) => {
        logger.warn(`opencode: failed to abort session ${agentSessionId}:`, err.message);
      });
    }).catch((err: Error) => {
      logger.warn(`opencode: failed to get client for abort ${agentSessionId}:`, err.message);
    });
    return true;
  }

  isRunning(agentSessionId: string): boolean {
    const session = this.#sessions.get(agentSessionId);
    return session?.status === 'running';
  }

  updateSessionSettings(agentSessionId: string, patch: AgentSessionSettingsPatch): void {
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
      logger.warn('opencode: resolvePermission, no pending entry for', permissionRequestId, '(already resolved or cancelled)');
      return;
    }

    const allow = Boolean(decision?.allow);

    if (pending.chatId) {
      this.#emitPermissionMessages(pending.chatId, [new PermissionResolvedMessage(new Date().toISOString(), permissionRequestId, allow)]);
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
      throw new UnsupportedSingleQueryEffortError('opencode', thinkingMode);
    }
    const { cwd, projectPath, model, permissionMode = 'default' } = options;
    const scope = createOpenCodeRequestScope(projectPath || cwd);
    const client = await this.getClient();

    const createResult: any = await this.#runRequest<any>(
      'OpenCode session create',
      (signal) => client.session.create(withOpenCodeRequestScope({
        permission: mapPermissionMode(permissionMode),
      }, scope), { signal }),
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
      if (parsedModel) {
        body.model = parsedModel;
      }

      const promptResult: any = await this.#runScopedSessionRequest<any>(
        'OpenCode prompt',
        scope,
        (signal, requestScope) => client.session.prompt(withOpenCodeRequestScope({
          sessionID: sessionId,
          ...body,
        }, requestScope), { signal }),
      );

      throwOpenCodeResultError(promptResult, 'OpenCode one-shot prompt failed');

      return extractTextParts(promptResult.data?.parts);
    } finally {
      await this.#runScopedSessionRequest(
        'OpenCode session delete',
        scope,
        (signal, requestScope) => client.session.delete(
          withOpenCodeRequestScope({ sessionID: sessionId }, requestScope),
          { signal },
        ),
      ).then((result) => {
        throwOpenCodeResultError(result, 'OpenCode session delete failed');
      }).catch(() => {});
    }
  }

  evictChat(chatId: string): void {
    this.#messageRoles.delete(chatId);
    this.#assistantPartTypes.delete(chatId);
  }

  startPurgeTimer(): void {
    this.#idlePurger.start();
  }
}
