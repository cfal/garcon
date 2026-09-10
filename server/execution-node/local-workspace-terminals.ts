import { constants as fsConstants, promises as fs } from "fs";
import type { IPty } from "bun-pty";
import {
  TERMINAL_SESSION_LIMIT,
  cloneTerminalMetadata,
  type TerminalCreateRequest,
  type TerminalCreateResponse,
  type TerminalErrorCode,
  type TerminalMetadata,
  type TerminalRenameResponse,
  type TerminalTerminateResponse,
} from "../../common/terminal.js";
import { KeyedPromiseLock } from "../lib/keyed-lock.js";
import {
  WorkspaceTerminalError,
  type TerminalPrincipal,
  type TerminalStreamPeer,
  type WorkspaceTerminalService,
} from "../execution-nodes/workspace-terminals.js";
import { createLogger } from "../lib/log.js";
import { errorMessage } from "../lib/errors.js";
import { TerminalReplayBuffer } from "../terminals/terminal-replay-buffer.js";

const logger = createLogger("terminals:manager");
const CREATE_RESULT_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_OPERATIONS = 1024;
export const MAX_TERMINAL_REQUEST_RESULTS_PER_PRINCIPAL = 256;
export const MAX_TERMINAL_REQUEST_RESULTS = 4096;

interface TerminalAttachment {
  clientId: string;
  peer: TerminalStreamPeer;
  expiresAtMs: number | null;
}

interface TerminalSession {
  metadata: TerminalMetadata;
  principalKey: string;
  pty: TerminalPty;
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
  error?: { code: TerminalErrorCode; message: string };
}

interface CachedTerminateResult {
  expiresAt: number;
  response: TerminalTerminateResponse;
}

export type TerminalPty = Pick<
  IPty,
  "write" | "resize" | "kill" | "onData" | "onExit"
>;

export type PtySpawner = (
  file: string,
  args: string[],
  options: {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: Record<string, string>;
  },
) => TerminalPty | Promise<TerminalPty>;

export interface LocalWorkspaceTerminalOptions {
  readonly projectBasePath: string;
  readonly assertProjectPathAllowed: (target: string) => Promise<string>;
  readonly shell: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  spawnPty?: PtySpawner;
  now?: () => number;
  createResultTtlMs?: number;
  replayBytes?: number;
  requestResultsPerPrincipal?: number;
  requestResultsTotal?: number;
}

function ptyEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) env[key] = value;
  }
  return {
    ...env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    FORCE_COLOR: "3",
  };
}

function terminateRequestKey(terminalId: string, requestId: string): string {
  return JSON.stringify([terminalId, requestId]);
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
): Promise<TerminalPty> {
  const { spawn } = await import("bun-pty");
  return spawn(file, args, options);
}

export class LocalWorkspaceTerminalService implements WorkspaceTerminalService {
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
  readonly #spawnPty: PtySpawner;
  readonly #projectBasePath: string;
  readonly #assertProjectPathAllowed: (target: string) => Promise<string>;
  readonly #shell: string;
  readonly #environment: Record<string, string>;
  readonly #pendingRequests = new Set<Promise<unknown>>();
  #closing = false;
  #shutdownPromise: Promise<void> | null = null;
  readonly #requestResultsPerPrincipal: number;
  readonly #requestResultsTotal: number;
  #requestResultCount = 0;
  readonly #resultCleanupTimer: ReturnType<typeof setInterval>;

  constructor(options: LocalWorkspaceTerminalOptions) {
    this.#projectBasePath = options.projectBasePath;
    this.#assertProjectPathAllowed = options.assertProjectPathAllowed;
    this.#shell = options.shell;
    this.#environment = ptyEnvironment(options.environment);
    this.#now = options.now ?? Date.now;
    this.#createResultTtlMs = options.createResultTtlMs ?? CREATE_RESULT_TTL_MS;
    this.#replayBytes = options.replayBytes;
    this.#spawnPty = options.spawnPty ?? defaultSpawnPty;
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

  list(principal: TerminalPrincipal): TerminalMetadata[] {
    this.#assertAvailable(principal);
    return [...this.#sessionsFor(principal.key).values()]
      .map((session) => cloneTerminalMetadata(session.metadata))
      .sort((left, right) => left.displaySequence - right.displaySequence);
  }

  rename(
    principal: TerminalPrincipal,
    terminalId: string,
    title: string | null,
  ): TerminalRenameResponse {
    const session = this.#requireSession(principal, terminalId);
    session.metadata.title = title;
    this.#broadcastStatus(session, "rename");
    return { success: true, terminalId, title };
  }

  create(
    principal: TerminalPrincipal,
    request: TerminalCreateRequest,
  ): Promise<TerminalCreateResponse> {
    if (this.#closing)
      return Promise.reject(
        new WorkspaceTerminalError(
          "terminal-internal",
          "Terminal service has shut down.",
        ),
      );
    return this.#trackRequest(this.#create({ ...principal }, { ...request }));
  }

  async #create(
    principal: TerminalPrincipal,
    request: TerminalCreateRequest,
  ): Promise<TerminalCreateResponse> {
    return this.#createLock.runExclusive(principal.key, async () => {
      this.#assertAvailable(principal);
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
          throw new WorkspaceTerminalError(
            cached.error.code,
            cached.error.message,
          );
      }
      this.#assertRequestResultCapacity(principal.key);

      const sessions = this.#sessionsFor(principal.key);
      if (sessions.size >= TERMINAL_SESSION_LIMIT) {
        return this.#cacheCreateError(
          principal.key,
          request.requestId,
          "terminal-limit",
          "Close a terminal before creating another one.",
        );
      }

      let cwd: string;
      try {
        cwd = await this.#resolveInitialDirectory(
          request.requestedInitialWorkingDirectory,
        );
      } catch (error) {
        this.#assertAvailable(principal);
        logger.warn("terminal create validation failed:", errorMessage(error));
        return this.#cacheCreateError(
          principal.key,
          request.requestId,
          "terminal-validation",
          "Initial terminal directory is unavailable.",
        );
      }

      this.#assertAvailable(principal);
      const displaySequence =
        (this.#displaySequenceByPrincipal.get(principal.key) ?? 0) + 1;
      this.#displaySequenceByPrincipal.set(principal.key, displaySequence);
      const terminalId = crypto.randomUUID();
      let pty: TerminalPty;
      try {
        const options = {
          name: "xterm-256color",
          cols: 80,
          rows: 24,
          cwd,
          env: { ...this.#environment },
        };
        pty = await this.#spawnPty(this.#shell, [], options);
      } catch (error) {
        this.#assertAvailable(principal);
        logger.error("terminal create failed:", errorMessage(error));
        return this.#cacheCreateError(
          principal.key,
          request.requestId,
          "terminal-internal",
          "Unable to start terminal.",
        );
      }

      try {
        this.#assertAvailable(principal);
      } catch (error) {
        try {
          pty.kill();
        } catch (cleanupError) {
          logger.warn(
            "late terminal cleanup failed:",
            errorMessage(cleanupError),
          );
        }
        throw error;
      }

      const metadata: TerminalMetadata = {
        terminalId,
        displaySequence,
        title: null,
        initialWorkingDirectory: cwd,
        processStatus: "running",
        attachmentStatus: "detached",
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

  terminate(
    principal: TerminalPrincipal,
    terminalId: string,
    requestId: string,
  ): Promise<TerminalTerminateResponse> {
    return this.#trackRequest(
      this.#terminate({ ...principal }, terminalId, requestId),
    );
  }

  async #terminate(
    principal: TerminalPrincipal,
    terminalId: string,
    requestId: string,
  ): Promise<TerminalTerminateResponse> {
    return this.#createLock.runExclusive(principal.key, async () => {
      this.#assertAvailable(principal);
      this.#pruneRequestResults(principal.key);
      const resultKey = terminateRequestKey(terminalId, requestId);
      const cached = this.#terminateResults.get(principal.key)?.get(resultKey);
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
          resultKey,
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
        if (subscriber.signal.aborted) continue;
        try {
          subscriber.sendTerminalMessage({
            type: "terminal-terminated",
            terminalId,
          });
        } catch (error) {
          logger.warn(
            `terminal termination notification failed id=${terminalId} connection=${subscriber.connectionId}:`,
            errorMessage(error),
          );
        }
      }
      session.subscribers.clear();
      session.attachment = null;
      sessions.delete(terminalId);
      if (session.metadata.processStatus === "running") {
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
      this.#setRequestResult(this.#terminateResults, principal.key, resultKey, {
        expiresAt: this.#now() + this.#createResultTtlMs,
        response,
      });
      return this.#cloneTerminateResponse(response);
    });
  }

  attach(
    principal: TerminalPrincipal,
    peer: TerminalStreamPeer,
    request: Extract<
      import("../../common/terminal.js").TerminalStreamClientMessage,
      { type: "terminal-attach" }
    >,
  ): void {
    this.#assertPeerActive(peer);
    const session = this.#requireSession(principal, request.terminalId);
    if (request.afterSequence > session.metadata.latestOutputSequence) {
      throw new WorkspaceTerminalError(
        "terminal-replay-sequence",
        "Replay sequence is ahead of terminal output.",
      );
    }
    session.subscribers.add(peer);
    const previous = session.attachment;
    if (
      previous &&
      (previous.clientId !== request.clientId || previous.peer !== peer)
    ) {
      if (
        request.intent !== "takeover" &&
        previous.clientId !== request.clientId
      ) {
        throw new WorkspaceTerminalError(
          "terminal-takeover-required",
          "Terminal is attached in another browser tab.",
        );
      }
    }

    session.attachment = {
      clientId: request.clientId,
      peer,
      expiresAtMs: principal.expiresAtMs,
    };
    session.attachmentGeneration += 1;
    session.metadata.attachmentStatus = "attached";
    const generation = session.attachmentGeneration;
    if (
      previous &&
      previous.clientId !== request.clientId &&
      !previous.peer.signal.aborted
    ) {
      previous.peer.sendTerminalMessage({
        type: "terminal-taken-over",
        terminalId: session.metadata.terminalId,
        replacementClientId: request.clientId,
      });
    }
    if (!this.#stillOwns(session, peer, generation)) return;
    const firstSequence = session.replay.firstRetainedSequence;
    if (request.afterSequence < firstSequence - 1) {
      peer.sendTerminalMessage({
        type: "terminal-replay-truncated",
        terminalId: session.metadata.terminalId,
        firstSequence,
      });
      if (!this.#stillOwns(session, peer, generation)) return;
    }
    peer.sendTerminalMessage({
      type: "terminal-attached",
      terminal: cloneTerminalMetadata(session.metadata),
      replay: session.replay.after(request.afterSequence),
    });
    logger.info(
      `terminal attached id=${session.metadata.terminalId} principal=${principal.key}`,
    );
  }

  input(
    principal: TerminalPrincipal,
    peer: TerminalStreamPeer,
    terminalId: string,
    data: string,
  ): void {
    this.#assertPeerActive(peer);
    const session = this.#requireOwnedSession(principal, peer, terminalId);
    if (session.metadata.processStatus !== "running") {
      throw new WorkspaceTerminalError(
        "terminal-process-exited",
        "Terminal process has exited.",
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
    principal: TerminalPrincipal,
    peer: TerminalStreamPeer,
    terminalId: string,
    cols: number,
    rows: number,
  ): void {
    this.#assertPeerActive(peer);
    const session = this.#requireOwnedSession(principal, peer, terminalId);
    if (session.metadata.processStatus !== "running") return;
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

  detachPeer(principal: TerminalPrincipal, peer: TerminalStreamPeer): void {
    const sessions = this.#sessionsByPrincipal.get(principal.key);
    if (!sessions) return;
    for (const session of sessions.values()) {
      session.subscribers.delete(peer);
      if (session.attachment?.peer === peer) {
        session.attachment = null;
        session.attachmentGeneration += 1;
        session.metadata.attachmentStatus = "detached";
      }
    }
  }

  detachTerminal(
    principal: TerminalPrincipal,
    peer: TerminalStreamPeer,
    terminalId: string,
  ): void {
    const session = this.#sessionsByPrincipal
      .get(principal.key)
      ?.get(terminalId);
    if (!session) return;
    session.subscribers.delete(peer);
    if (session.attachment?.peer === peer) {
      session.attachment = null;
      session.attachmentGeneration += 1;
      session.metadata.attachmentStatus = "detached";
    }
  }

  shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#closing = true;
    clearInterval(this.#resultCleanupTimer);
    const pending: Promise<unknown>[] = [...this.#pendingRequests];
    for (const sessions of this.#sessionsByPrincipal.values()) {
      for (const session of sessions.values()) {
        session.terminating = true;
        pending.push(session.operationChain);
        session.pendingResize = null;
        session.attachment = null;
        session.attachmentGeneration += 1;
        session.subscribers.clear();
        try {
          session.pty.kill();
        } catch {
          // Process may already be gone.
        }
      }
      sessions.clear();
    }
    this.#sessionsByPrincipal.clear();
    this.#createResults.clear();
    this.#terminateResults.clear();
    this.#requestResultCount = 0;
    this.#displaySequenceByPrincipal.clear();
    this.#shutdownPromise = Promise.allSettled(pending).then(() => undefined);
    return this.#shutdownPromise;
  }

  #trackRequest<T>(operation: Promise<T>): Promise<T> {
    this.#pendingRequests.add(operation);
    const settled = () => {
      this.#pendingRequests.delete(operation);
    };
    void operation.then(settled, settled);
    return operation;
  }

  #assertAvailable(principal: TerminalPrincipal): void {
    if (this.#closing)
      throw new WorkspaceTerminalError(
        "terminal-internal",
        "Terminal service has shut down.",
      );
    if (
      principal.expiresAtMs !== null &&
      principal.expiresAtMs <= this.#now()
    ) {
      throw new WorkspaceTerminalError(
        "terminal-auth-expired",
        "Terminal authorization expired.",
      );
    }
  }

  #sessionsFor(principalKey: string): Map<string, TerminalSession> {
    let sessions = this.#sessionsByPrincipal.get(principalKey);
    if (!sessions) {
      sessions = new Map();
      this.#sessionsByPrincipal.set(principalKey, sessions);
    }
    return sessions;
  }

  #assertPeerActive(peer: TerminalStreamPeer): void {
    if (peer.signal.aborted)
      throw new WorkspaceTerminalError(
        "terminal-not-attached",
        "Terminal connection is closed.",
      );
  }

  #requireSession(
    principal: TerminalPrincipal,
    terminalId: string,
  ): TerminalSession {
    this.#assertAvailable(principal);
    const session = this.#sessionsFor(principal.key).get(terminalId);
    if (!session)
      throw new WorkspaceTerminalError(
        "terminal-not-found",
        "Terminal not found.",
      );
    return session;
  }

  #requireOwnedSession(
    principal: TerminalPrincipal,
    peer: TerminalStreamPeer,
    terminalId: string,
  ): TerminalSession {
    const session = this.#requireSession(principal, terminalId);
    if (session.attachment?.peer !== peer) {
      throw new WorkspaceTerminalError(
        "terminal-not-attached",
        "Terminal is not attached to this connection.",
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
      !this.#closing &&
      !session.terminating &&
      !peer.signal.aborted &&
      (session.attachment?.expiresAtMs === null ||
        (session.attachment?.expiresAtMs ?? 0) > this.#now()) &&
      session.attachmentGeneration === attachmentGeneration &&
      session.attachment?.peer === peer
    );
  }

  #wireSession(session: TerminalSession): void {
    session.pty.onData((data) => {
      if (session.terminating) return;
      const sequence = session.metadata.latestOutputSequence + 1;
      session.metadata.latestOutputSequence = sequence;
      session.replay.append({ sequence, data });
      const peer = session.attachment?.peer;
      if (
        !peer ||
        !this.#stillOwns(session, peer, session.attachmentGeneration)
      )
        return;
      peer.sendTerminalMessage({
        type: "terminal-output",
        terminalId: session.metadata.terminalId,
        sequence,
        data,
      });
    });
    session.pty.onExit(({ exitCode }) => {
      if (session.terminating) return;
      session.metadata.processStatus = "exited";
      session.metadata.exitCode = exitCode;
      this.#broadcastStatus(session, "exit");
      logger.info(
        `terminal exited id=${session.metadata.terminalId} principal=${session.principalKey} code=${exitCode}`,
      );
    });
  }

  #broadcastStatus(session: TerminalSession, event: "rename" | "exit"): void {
    for (const subscriber of session.subscribers) {
      if (subscriber.signal.aborted) continue;
      try {
        subscriber.sendTerminalMessage({
          type: "terminal-status",
          terminal: cloneTerminalMetadata(session.metadata),
        });
      } catch (error) {
        logger.warn(
          `terminal ${event} notification failed id=${session.metadata.terminalId} connection=${subscriber.connectionId}:`,
          errorMessage(error),
        );
      }
    }
  }

  #enqueue(
    session: TerminalSession,
    peer: TerminalStreamPeer,
    operation: () => void,
  ): void {
    if (session.pendingOperations >= MAX_PENDING_OPERATIONS) {
      throw new WorkspaceTerminalError(
        "terminal-backpressure",
        "Terminal input queue is full.",
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
        if (peer.signal.aborted) return;
        try {
          peer.sendTerminalMessage({
            type: "terminal-error",
            terminalId: session.metadata.terminalId,
            code: "terminal-internal",
            message: "Terminal operation failed.",
          });
        } catch (sendError) {
          // A failed peer send must not reject the chain; no later operation
          // would exist to absorb the rejection.
          logger.warn(
            `terminal error notification failed id=${session.metadata.terminalId} connection=${peer.connectionId}:`,
            errorMessage(sendError),
          );
        }
      })
      .finally(() => {
        session.pendingOperations -= 1;
      });
  }

  async #resolveInitialDirectory(requested: string | null): Promise<string> {
    const target = requested ?? this.#projectBasePath;
    const realPath = await this.#assertProjectPathAllowed(target);
    const stat = await fs.stat(realPath);
    if (!stat.isDirectory())
      throw new Error("Terminal path is not a directory");
    await fs.access(realPath, fsConstants.R_OK | fsConstants.X_OK);
    return realPath;
  }

  #cacheCreateError(
    principalKey: string,
    requestId: string,
    code: TerminalErrorCode,
    message: string,
  ): never {
    this.#setRequestResult(this.#createResults, principalKey, requestId, {
      expiresAt: this.#now() + this.#createResultTtlMs,
      error: { code, message },
    });
    throw new WorkspaceTerminalError(code, message);
  }

  #assertRequestResultCapacity(principalKey: string): void {
    const principalCount =
      (this.#createResults.get(principalKey)?.size ?? 0) +
      (this.#terminateResults.get(principalKey)?.size ?? 0);
    if (
      principalCount >= this.#requestResultsPerPrincipal ||
      this.#requestResultCount >= this.#requestResultsTotal
    ) {
      throw new WorkspaceTerminalError(
        "terminal-backpressure",
        "Too many terminal requests are awaiting idempotency expiry.",
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
