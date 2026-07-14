import { constants as fsConstants, promises as fs } from 'fs';
import type { IPty } from 'bun-pty';
import {
  TERMINAL_SESSION_LIMIT,
  cloneTerminalMetadata,
  type TerminalCreateRequest,
  type TerminalCreateResponse,
  type TerminalErrorCode,
  type TerminalMetadata,
  type TerminalStreamServerMessage,
  type TerminalTerminateResponse,
} from '../../common/terminal.js';
import { getProjectBasePath, getUserShell } from '../config.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
import { assertRealWithinProjectBase } from '../lib/path-boundary.js';
import type { ServerPrincipal } from '../lib/http-route-types.js';
import { createLogger } from '../lib/log.js';
import { errorMessage } from '../lib/errors.js';
import { TerminalReplayBuffer } from './terminal-replay-buffer.js';

const logger = createLogger('terminals:manager');
const CREATE_RESULT_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_OPERATIONS = 1024;
export const MAX_TERMINAL_REQUEST_RESULTS_PER_PRINCIPAL = 256;
export const MAX_TERMINAL_REQUEST_RESULTS = 4096;

export interface TerminalStreamPeer {
  readonly connectionId: string;
  readonly ownedTerminalIds: Set<string>;
  sendTerminalMessage(message: TerminalStreamServerMessage): void;
}

interface TerminalAttachment {
  clientId: string;
  peer: TerminalStreamPeer;
}

interface TerminalSession {
  metadata: TerminalMetadata;
  principalKey: string;
  pty: IPty;
  replay: TerminalReplayBuffer;
  attachment: TerminalAttachment | null;
  subscribers: Set<TerminalStreamPeer>;
  attachmentGeneration: number;
  pendingOperations: number;
  operationChain: Promise<void>;
  pendingResize: {
    cols: number;
    rows: number;
    peer: TerminalStreamPeer;
    attachmentGeneration: number;
  } | null;
  terminating: boolean;
}

interface CachedCreateResult {
  expiresAt: number;
  response?: TerminalCreateResponse;
  error?: { code: TerminalErrorCode; message: string; status: number };
}

interface CachedTerminateResult {
  expiresAt: number;
  response: TerminalTerminateResponse;
}

export class TerminalManagerError extends Error {
  constructor(
    readonly code: TerminalErrorCode,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'TerminalManagerError';
  }
}

type PtySpawner = (
  file: string,
  args: string[],
  options: {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: Record<string, string>;
  },
) => IPty;

interface TerminalManagerOptions {
  spawnPty?: PtySpawner;
  now?: () => number;
  createResultTtlMs?: number;
  replayBytes?: number;
  requestResultsPerPrincipal?: number;
  requestResultsTotal?: number;
}

function ptyEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return {
    ...env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    FORCE_COLOR: '3',
  };
}

async function defaultSpawnPty(
  file: string,
  args: string[],
  options: {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: Record<string, string>;
  },
): Promise<IPty> {
  const { spawn } = await import('bun-pty');
  return spawn(file, args, options);
}

export class TerminalManager {
  readonly #sessionsByPrincipal = new Map<
    string,
    Map<string, TerminalSession>
  >();
  readonly #createResults = new Map<string, Map<string, CachedCreateResult>>();
  readonly #terminateResults = new Map<
    string,
    Map<string, CachedTerminateResult>
  >();
  readonly #displaySequenceByPrincipal = new Map<string, number>();
  readonly #createLock = new KeyedPromiseLock();
  readonly #now: () => number;
  readonly #createResultTtlMs: number;
  readonly #replayBytes: number | undefined;
  readonly #spawnPty?: PtySpawner;
  readonly #requestResultsPerPrincipal: number;
  readonly #requestResultsTotal: number;
  #requestResultCount = 0;
  readonly #resultCleanupTimer: ReturnType<typeof setInterval>;

  constructor(options: TerminalManagerOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#createResultTtlMs = options.createResultTtlMs ?? CREATE_RESULT_TTL_MS;
    this.#replayBytes = options.replayBytes;
    this.#spawnPty = options.spawnPty;
    this.#requestResultsPerPrincipal =
      options.requestResultsPerPrincipal ??
      MAX_TERMINAL_REQUEST_RESULTS_PER_PRINCIPAL;
    this.#requestResultsTotal =
      options.requestResultsTotal ?? MAX_TERMINAL_REQUEST_RESULTS;
    this.#resultCleanupTimer = setInterval(
      () => this.#pruneRequestResults(),
      Math.max(1_000, Math.min(this.#createResultTtlMs, 60_000)),
    );
    this.#resultCleanupTimer.unref?.();
  }

  list(principal: ServerPrincipal): TerminalMetadata[] {
    return [...this.#sessionsFor(principal.key).values()]
      .map((session) => cloneTerminalMetadata(session.metadata))
      .sort((left, right) => left.displaySequence - right.displaySequence);
  }

  async create(
    principal: ServerPrincipal,
    request: TerminalCreateRequest,
  ): Promise<TerminalCreateResponse> {
    return this.#createLock.runExclusive(principal.key, async () => {
      this.#pruneRequestResults(principal.key);
      const cached = this.#createResults
        .get(principal.key)
        ?.get(request.requestId);
      if (cached && cached.expiresAt > this.#now()) {
        if (cached.response)
          return {
            success: true,
            terminal: cloneTerminalMetadata(cached.response.terminal),
          };
        if (cached.error)
          throw new TerminalManagerError(
            cached.error.code,
            cached.error.message,
            cached.error.status,
          );
      }
      this.#assertRequestResultCapacity(principal.key);

      const sessions = this.#sessionsFor(principal.key);
      if (sessions.size >= TERMINAL_SESSION_LIMIT) {
        return this.#cacheCreateError(
          principal.key,
          request.requestId,
          'terminal-limit',
          'Close a terminal before creating another one.',
          409,
        );
      }

      let cwd: string;
      try {
        cwd = await this.#resolveInitialDirectory(
          request.requestedInitialWorkingDirectory,
        );
      } catch (error) {
        logger.warn('terminal create validation failed:', errorMessage(error));
        return this.#cacheCreateError(
          principal.key,
          request.requestId,
          'terminal-validation',
          'Initial terminal directory is unavailable.',
          422,
        );
      }

      const displaySequence =
        (this.#displaySequenceByPrincipal.get(principal.key) ?? 0) + 1;
      this.#displaySequenceByPrincipal.set(principal.key, displaySequence);
      const terminalId = crypto.randomUUID();
      let pty: IPty;
      try {
        const shell = getUserShell();
        const options = {
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
          cwd,
          env: ptyEnvironment(),
        };
        pty = this.#spawnPty
          ? this.#spawnPty(shell, [], options)
          : await defaultSpawnPty(shell, [], options);
      } catch (error) {
        logger.error('terminal create failed:', errorMessage(error));
        return this.#cacheCreateError(
          principal.key,
          request.requestId,
          'terminal-internal',
          'Unable to start terminal.',
          500,
        );
      }

      const metadata: TerminalMetadata = {
        terminalId,
        displaySequence,
        initialWorkingDirectory: cwd,
        processStatus: 'running',
        attachmentStatus: 'detached',
        createdAt: new Date(this.#now()).toISOString(),
        exitCode: null,
        latestOutputSequence: 0,
      };
      const session: TerminalSession = {
        metadata,
        principalKey: principal.key,
        pty,
        replay: new TerminalReplayBuffer(this.#replayBytes),
        attachment: null,
        subscribers: new Set(),
        attachmentGeneration: 0,
        pendingOperations: 0,
        operationChain: Promise.resolve(),
        pendingResize: null,
        terminating: false,
      };
      sessions.set(terminalId, session);
      this.#wireSession(session);
      const response: TerminalCreateResponse = {
        success: true,
        terminal: cloneTerminalMetadata(metadata),
      };
      this.#setRequestResult(
        this.#createResults,
        principal.key,
        request.requestId,
        {
          expiresAt: this.#now() + this.#createResultTtlMs,
          response,
        },
      );
      logger.info(
        `terminal created id=${terminalId} principal=${principal.key} sequence=${displaySequence}`,
      );
      return response;
    });
  }

  async terminate(
    principal: ServerPrincipal,
    terminalId: string,
    requestId: string,
  ): Promise<TerminalTerminateResponse> {
    return this.#createLock.runExclusive(principal.key, async () => {
      this.#pruneRequestResults(principal.key);
      const cached = this.#terminateResults.get(principal.key)?.get(requestId);
      if (cached) return this.#cloneTerminateResponse(cached.response);
      this.#assertRequestResultCapacity(principal.key);
      const sessions = this.#sessionsFor(principal.key);
      const session = sessions.get(terminalId);
      if (!session) {
        const response: TerminalTerminateResponse = {
          success: true,
          terminalId,
          terminal: null,
        };
        this.#setRequestResult(
          this.#terminateResults,
          principal.key,
          requestId,
          {
            expiresAt: this.#now() + this.#createResultTtlMs,
            response,
          },
        );
        return response;
      }
      session.terminating = true;
      const finalMetadata = cloneTerminalMetadata(session.metadata);
      for (const subscriber of session.subscribers) {
        try {
          subscriber.sendTerminalMessage({
            type: 'terminal-terminated',
            terminalId,
          });
        } catch (error) {
          logger.warn(
            `terminal termination notification failed id=${terminalId} connection=${subscriber.connectionId}:`,
            errorMessage(error),
          );
        }
        subscriber.ownedTerminalIds.delete(terminalId);
      }
      session.subscribers.clear();
      session.attachment = null;
      sessions.delete(terminalId);
      if (session.metadata.processStatus === 'running') {
        try {
          session.pty.kill();
        } catch (error) {
          logger.warn(
            `terminal kill failed id=${terminalId}:`,
            errorMessage(error),
          );
        }
      }
      logger.info(
        `terminal terminated id=${terminalId} principal=${principal.key}`,
      );
      const response: TerminalTerminateResponse = {
        success: true,
        terminalId,
        terminal: finalMetadata,
      };
      this.#setRequestResult(this.#terminateResults, principal.key, requestId, {
        expiresAt: this.#now() + this.#createResultTtlMs,
        response,
      });
      return this.#cloneTerminateResponse(response);
    });
  }

  attach(
    principal: ServerPrincipal,
    peer: TerminalStreamPeer,
    request: Extract<
      import('../../common/terminal.js').TerminalStreamClientMessage,
      { type: 'terminal-attach' }
    >,
  ): void {
    const session = this.#requireSession(principal, request.terminalId);
    if (request.afterSequence > session.metadata.latestOutputSequence) {
      throw new TerminalManagerError(
        'terminal-replay-sequence',
        'Replay sequence is ahead of terminal output.',
      );
    }
    session.subscribers.add(peer);
    const previous = session.attachment;
    if (
      previous &&
      (previous.clientId !== request.clientId || previous.peer !== peer)
    ) {
      if (
        request.intent !== 'takeover' &&
        previous.clientId !== request.clientId
      ) {
        throw new TerminalManagerError(
          'terminal-takeover-required',
          'Terminal is attached in another browser tab.',
          409,
        );
      }
      previous.peer.ownedTerminalIds.delete(session.metadata.terminalId);
      if (previous.clientId !== request.clientId) {
        previous.peer.sendTerminalMessage({
          type: 'terminal-taken-over',
          terminalId: session.metadata.terminalId,
          replacementClientId: request.clientId,
        });
      }
    }

    session.attachment = { clientId: request.clientId, peer };
    session.attachmentGeneration += 1;
    peer.ownedTerminalIds.add(session.metadata.terminalId);
    session.metadata.attachmentStatus = 'attached';
    const firstSequence = session.replay.firstRetainedSequence;
    if (request.afterSequence < firstSequence - 1) {
      peer.sendTerminalMessage({
        type: 'terminal-replay-truncated',
        terminalId: session.metadata.terminalId,
        firstSequence,
      });
    }
    peer.sendTerminalMessage({
      type: 'terminal-attached',
      terminal: cloneTerminalMetadata(session.metadata),
      replay: session.replay.after(request.afterSequence),
    });
    logger.info(
      `terminal attached id=${session.metadata.terminalId} principal=${principal.key}`,
    );
  }

  input(
    principal: ServerPrincipal,
    peer: TerminalStreamPeer,
    terminalId: string,
    data: string,
  ): void {
    const session = this.#requireOwnedSession(principal, peer, terminalId);
    if (session.metadata.processStatus !== 'running') {
      throw new TerminalManagerError(
        'terminal-process-exited',
        'Terminal process has exited.',
        409,
      );
    }
    const attachmentGeneration = session.attachmentGeneration;
    // Ends resize coalescing at the input boundary so later resizes remain ordered after this input.
    session.pendingResize = null;
    this.#enqueue(session, peer, () => {
      if (!this.#stillOwns(session, peer, attachmentGeneration)) return;
      session.pty.write(data);
    });
  }

  resize(
    principal: ServerPrincipal,
    peer: TerminalStreamPeer,
    terminalId: string,
    cols: number,
    rows: number,
  ): void {
    const session = this.#requireOwnedSession(principal, peer, terminalId);
    if (session.metadata.processStatus !== 'running') return;
    const attachmentGeneration = session.attachmentGeneration;
    const pending = session.pendingResize;
    if (
      pending &&
      pending.peer === peer &&
      pending.attachmentGeneration === attachmentGeneration
    ) {
      pending.cols = cols;
      pending.rows = rows;
      return;
    }
    const resize = { cols, rows, peer, attachmentGeneration };
    session.pendingResize = resize;
    try {
      this.#enqueue(session, peer, () => {
        if (session.pendingResize === resize) session.pendingResize = null;
        if (!this.#stillOwns(session, resize.peer, resize.attachmentGeneration))
          return;
        session.pty.resize(resize.cols, resize.rows);
      });
    } catch (error) {
      if (session.pendingResize === resize) session.pendingResize = null;
      throw error;
    }
  }

  detachPeer(principal: ServerPrincipal, peer: TerminalStreamPeer): void {
    const sessions = this.#sessionsFor(principal.key);
    for (const [terminalId, session] of sessions) {
      const wasSubscribed = session.subscribers.delete(peer);
      if (session.attachment?.peer === peer) {
        session.attachment = null;
        session.attachmentGeneration += 1;
        session.metadata.attachmentStatus = 'detached';
      }
      if (wasSubscribed) peer.ownedTerminalIds.delete(terminalId);
    }
    peer.ownedTerminalIds.clear();
  }

  shutdown(): void {
    clearInterval(this.#resultCleanupTimer);
    for (const sessions of this.#sessionsByPrincipal.values()) {
      for (const session of sessions.values()) {
        session.terminating = true;
        try {
          session.pty.kill();
        } catch {
          // Process may already be gone.
        }
      }
      sessions.clear();
    }
    this.#createResults.clear();
    this.#terminateResults.clear();
    this.#requestResultCount = 0;
  }

  #sessionsFor(principalKey: string): Map<string, TerminalSession> {
    let sessions = this.#sessionsByPrincipal.get(principalKey);
    if (!sessions) {
      sessions = new Map();
      this.#sessionsByPrincipal.set(principalKey, sessions);
    }
    return sessions;
  }

  #requireSession(
    principal: ServerPrincipal,
    terminalId: string,
  ): TerminalSession {
    const session = this.#sessionsFor(principal.key).get(terminalId);
    if (!session)
      throw new TerminalManagerError(
        'terminal-not-found',
        'Terminal not found.',
        404,
      );
    return session;
  }

  #requireOwnedSession(
    principal: ServerPrincipal,
    peer: TerminalStreamPeer,
    terminalId: string,
  ): TerminalSession {
    const session = this.#requireSession(principal, terminalId);
    if (session.attachment?.peer !== peer) {
      throw new TerminalManagerError(
        'terminal-not-attached',
        'Terminal is not attached to this connection.',
        409,
      );
    }
    return session;
  }

  #stillOwns(
    session: TerminalSession,
    peer: TerminalStreamPeer,
    attachmentGeneration: number,
  ): boolean {
    return (
      session.attachmentGeneration === attachmentGeneration &&
      session.attachment?.peer === peer &&
      peer.ownedTerminalIds.has(session.metadata.terminalId)
    );
  }

  #wireSession(session: TerminalSession): void {
    session.pty.onData((data) => {
      if (session.terminating) return;
      const sequence = session.metadata.latestOutputSequence + 1;
      session.metadata.latestOutputSequence = sequence;
      session.replay.append({ sequence, data });
      session.attachment?.peer.sendTerminalMessage({
        type: 'terminal-output',
        terminalId: session.metadata.terminalId,
        sequence,
        data,
      });
    });
    session.pty.onExit(({ exitCode }) => {
      if (session.terminating) return;
      session.metadata.processStatus = 'exited';
      session.metadata.exitCode = exitCode;
      session.attachment?.peer.sendTerminalMessage({
        type: 'terminal-status',
        terminal: cloneTerminalMetadata(session.metadata),
      });
      logger.info(
        `terminal exited id=${session.metadata.terminalId} principal=${session.principalKey} code=${exitCode}`,
      );
    });
  }

  #enqueue(
    session: TerminalSession,
    peer: TerminalStreamPeer,
    operation: () => void,
  ): void {
    if (session.pendingOperations >= MAX_PENDING_OPERATIONS) {
      throw new TerminalManagerError(
        'terminal-backpressure',
        'Terminal input queue is full.',
        429,
      );
    }
    session.pendingOperations += 1;
    session.operationChain = session.operationChain
      .catch(() => undefined)
      .then(() => operation())
      .catch((error) => {
        logger.warn(
          `terminal operation failed id=${session.metadata.terminalId}:`,
          errorMessage(error),
        );
        peer.sendTerminalMessage({
          type: 'terminal-error',
          terminalId: session.metadata.terminalId,
          code: 'terminal-internal',
          message: 'Terminal operation failed.',
        });
      })
      .finally(() => {
        session.pendingOperations -= 1;
      });
  }

  async #resolveInitialDirectory(requested: string | null): Promise<string> {
    const target = requested ?? getProjectBasePath();
    const realPath = await assertRealWithinProjectBase(target);
    const stat = await fs.stat(realPath);
    if (!stat.isDirectory())
      throw new Error('Terminal path is not a directory');
    await fs.access(realPath, fsConstants.R_OK | fsConstants.X_OK);
    return realPath;
  }

  #cacheCreateError(
    principalKey: string,
    requestId: string,
    code: TerminalErrorCode,
    message: string,
    status: number,
  ): never {
    this.#setRequestResult(this.#createResults, principalKey, requestId, {
      expiresAt: this.#now() + this.#createResultTtlMs,
      error: { code, message, status },
    });
    throw new TerminalManagerError(code, message, status);
  }

  #assertRequestResultCapacity(principalKey: string): void {
    const principalCount =
      (this.#createResults.get(principalKey)?.size ?? 0) +
      (this.#terminateResults.get(principalKey)?.size ?? 0);
    if (
      principalCount >= this.#requestResultsPerPrincipal ||
      this.#requestResultCount >= this.#requestResultsTotal
    ) {
      throw new TerminalManagerError(
        'terminal-backpressure',
        'Too many terminal requests are awaiting idempotency expiry.',
        429,
      );
    }
  }

  #setRequestResult<T>(
    results: Map<string, Map<string, T>>,
    principalKey: string,
    requestId: string,
    result: T,
  ): void {
    let principalResults = results.get(principalKey);
    if (!principalResults) {
      principalResults = new Map();
      results.set(principalKey, principalResults);
    }
    if (!principalResults.has(requestId)) this.#requestResultCount += 1;
    principalResults.set(requestId, result);
  }

  #pruneRequestResults(principalKey?: string): void {
    const now = this.#now();
    this.#pruneResultMap(this.#createResults, now, principalKey);
    this.#pruneResultMap(this.#terminateResults, now, principalKey);
  }

  #pruneResultMap<T extends { expiresAt: number }>(
    results: Map<string, Map<string, T>>,
    now: number,
    principalKey?: string,
  ): void {
    const principals = principalKey
      ? ([[principalKey, results.get(principalKey)]] as const)
      : [...results.entries()];
    for (const [key, principalResults] of principals) {
      if (!principalResults) continue;
      for (const [requestId, result] of principalResults) {
        if (result.expiresAt > now) continue;
        principalResults.delete(requestId);
        this.#requestResultCount -= 1;
      }
      if (principalResults.size === 0) results.delete(key);
    }
  }

  #cloneTerminateResponse(
    response: TerminalTerminateResponse,
  ): TerminalTerminateResponse {
    return {
      success: true,
      terminalId: response.terminalId,
      terminal: response.terminal
        ? cloneTerminalMetadata(response.terminal)
        : null,
    };
  }
}
