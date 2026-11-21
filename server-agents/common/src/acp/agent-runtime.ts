import crypto from 'node:crypto';
import {
  ErrorMessage,
  type ChatMessage,
} from '@garcon/common/chat-types';
import type { PermissionDecisionPayload } from '@garcon/common/chat-command-contracts';
import {
  runtimeRows,
  type AgentRuntimeEvent,
  type AgentRuntimeOperation,
} from '../execution/runtime-events.js';
import {
  assertAcpExecutionOpen,
  markAcpExecutionStarted,
  type AcpProjectPathUpdateRequest,
  type AcpResumeRequest,
  type AcpSessionSettingsPatch,
  type AcpStartedSession,
  type AcpStartRequest,
} from './runtime-types.js';
import { AgentIntegrationError, type AgentLogger } from '@garcon/server-agent-interface';
import { AcpCapabilityCache } from './capability-cache.js';
import { AcpClient } from './client.js';
import type {
  AcpJsonRpcId,
  AcpSessionRequestPermission,
  AcpSessionUpdateNotification,
} from './protocol.js';
import type { ReconnectStrategy } from './reconnect-policy.js';
import { reconnectAcpSession, reconnectOrder } from './reconnect-policy.js';
import { AcpRestoreRegistry } from './restore-registry.js';
import { isJsonRpcId } from './protocol.js';
import {
  childEnvironmentFor,
  newSessionModelFor,
  nativePathFor,
  promptConfigFor,
  promptFor,
  configureSessionFor,
  type AcpAgentPolicy,
  type AcpPrompt,
} from './policy.js';
import { AcpTransport } from './transport.js';
import {
  newRuntimeSession,
  type AcpAgentRuntimeSession,
  type AcpTurnContext,
  type PendingPermissionRequest,
} from './runtime-session.js';
import { asObject, asString, type AcpEventConverter, type AcpSessionUpdateContext } from './event-converter.js';
import { IdleSessionPurger } from '../shared/idle-session-purger.js';
import {
  abortStrategy,
  unlessSettled,
  untilSettledOrClosed,
  fallbackPermissionToolUse,
  humanizeError,
  isAutoApproveMode,
  permissionCancelledOutcome,
  permissionChoiceOutcome,
} from './runtime-helpers.js';

// How long a cancelled prompt may take to settle before the next turn replaces its process.
const DEFAULT_CANCEL_SETTLE_TIMEOUT_MS = 10_000;

export interface AcpAgentRuntimeOptions {
  converter: AcpEventConverter;
  capabilityCache?: AcpCapabilityCache;
  createTransport?: () => AcpTransport;
  logger?: AgentLogger;
  cancelSettleTimeoutMs?: number;
}

const SILENT_LOGGER: AgentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export class AcpAgentRuntime {
  #policy: AcpAgentPolicy;
  #converter: AcpEventConverter;
  #capabilityCache: AcpCapabilityCache;
  #createTransport: () => AcpTransport;
  #logger: AgentLogger;
  #cancelSettleTimeoutMs: number;
  #sessions = new Map<string, AcpAgentRuntimeSession>();
  #restores = new AcpRestoreRegistry<AcpAgentRuntimeSession>();
  #stopped = false;
  #pendingPermissions = new Set<PendingPermissionRequest>();
  #idlePurger = new IdleSessionPurger<AcpAgentRuntimeSession>({
    sessions: () => this.#sessions.entries(),
    isRunning: (session) => this.#isBusy(session),
    lastActivityAt: (session) => session.lastActivityAt,
    purge: (_sessionId, session) => this.#retireSession(session, 'session-complete'),
  });

  constructor(policy: AcpAgentPolicy, options: AcpAgentRuntimeOptions) {
    this.#policy = policy;
    this.#converter = options.converter;
    this.#capabilityCache = options.capabilityCache ?? new AcpCapabilityCache();
    this.#createTransport = options.createTransport ?? (() => new AcpTransport());
    this.#logger = options.logger ?? SILENT_LOGGER;
    this.#cancelSettleTimeoutMs = options.cancelSettleTimeoutMs ?? DEFAULT_CANCEL_SETTLE_TIMEOUT_MS;
  }

  async startSession(request: AcpStartRequest): Promise<AcpStartedSession> {
    assertAcpExecutionOpen(request);
    // Built first, so an unusable attachment fails before any process or native
    // conversation exists.
    const prompt = promptFor(this.#policy, request);
    const client = await this.#connectClient(request);
    let created: Awaited<ReturnType<AcpClient['newSession']>>;
    try {
      assertAcpExecutionOpen(request);
      const model = newSessionModelFor(this.#policy, request);
      created = await client.newSession({
        cwd: request.projectPath,
        mcpServers: this.#policy.mcpServers,
        ...(model ? { model } : {}),
      });
    } catch (error) {
      client.close();
      throw error;
    }

    if (this.#stopped) {
      client.close();
      throw new Error(`The ${this.#policy.agentId} runtime stopped while the session was starting.`);
    }
    const sessionId = created.sessionId;
    const existing = this.#sessions.get(sessionId);
    if (existing) {
      client.close();
      if (existing.chatId !== request.chatId) {
        throw new Error(`ACP session ${sessionId} is already bound to another chat`);
      }
      throw new Error(`ACP session ${sessionId} is already active`);
    }
    const now = new Date().toISOString();
    const capabilities = client.getAdvertisedCapabilities();
    const session = newRuntimeSession({
      id: sessionId,
      remoteSessionId: sessionId,
      chatId: request.chatId,
      projectPath: request.projectPath,
      client,
      capabilities,
      permissionMode: request.permissionMode,
      configOptions: created.configOptions,
      models: created.models,
      agentDefaultModelId: created.models?.currentModelId,
    }, now);
    this.#registerSession(session);
    const result = {
      agentSessionId: sessionId,
      nativePath: nativePathFor(this.#policy, sessionId),
    };
    request.onSessionActivated?.(result);
    let resolveStarted!: () => void;
    let rejectStarted!: (error: unknown) => void;
    let executionStarted = false;
    const started = new Promise<void>((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });
    const promptTask = this.#runPrompt(session, request, prompt, () => {
      this.#retireSupersededChatSessions(session);
      if (executionStarted) return;
      executionStarted = true;
      resolveStarted();
    });
    void promptTask.then(() => {
      if (!executionStarted) rejectStarted(new Error('ACP session ended before execution started'));
    }, (error) => {
      if (!executionStarted) rejectStarted(error);
    });
    try {
      await started;
    } catch (error) {
      this.#retireSession(session, 'cancelled');
      throw error;
    }

    return result;
  }

  async runTurn(request: AcpResumeRequest): Promise<void> {
    assertAcpExecutionOpen(request);
    const prompt = promptFor(this.#policy, request);
    let session = await this.#liveSessionForTurn(request, await this.#sessionForTurn(request));
    // A turn stopped while configuring is still the pending turn.
    const cancelled = session.activeTurn?.running ? session.activeTurn : session.pendingTurn;
    if (cancelled?.aborted) {
      await untilSettledOrClosed(cancelled.settled.promise, request.executionAdmission?.signal);
      assertAcpExecutionOpen(request);
      session = await this.#liveSessionForTurn(request, session);
    }
    if (this.#isBusy(session)) {
      throw new Error(`Session ${request.agentSessionId} is already running`);
    }
    await this.#runPrompt(session, request, prompt);
  }

  // A session can retire while a turn awaits it. One that crashed or timed out is
  // restored again; one its chat released stays gone.
  async #liveSessionForTurn(request: AcpResumeRequest, session: AcpAgentRuntimeSession): Promise<AcpAgentRuntimeSession> {
    const live = session.retired && !session.released ? await this.#sessionForTurn(request) : session;
    if (live.released) throw this.#releasedError(request.agentSessionId);
    return live;
  }

  #releasedError(agentSessionId: string): Error {
    return new Error(`The ${this.#policy.agentId} session ${agentSessionId} was released while it was being restored.`);
  }

  #isBusy(session: AcpAgentRuntimeSession): boolean {
    return session.activeTurn?.running === true || session.pendingTurn !== null;
  }

  // A cooperative cancel settles when the agent answers the open prompt. An
  // agent that never answers loses its process, so a stopped turn cannot stay
  // running; the next turn reconnects.
  #armCancelSettleTimeout(turn: AcpTurnContext): void {
    turn.cancelTimer ??= unlessSettled(turn.settled.promise, this.#cancelSettleTimeoutMs, () => {
      if (!turn.completed) this.#retireSession(turn.session, 'aborted');
    });
  }

  async prepareProjectPathUpdate(request: AcpProjectPathUpdateRequest): Promise<void> {
    const agentSessionId = request.agentSessionId;
    if (!agentSessionId) return;

    if (this.#restores.inFlight(agentSessionId)) {
      throw new AgentIntegrationError('SESSION_BUSY', `Session ${agentSessionId} is being restored`, false);
    }
    const session = this.#sessions.get(agentSessionId);
    if (!session) return;
    if (session.chatId !== request.chatId) {
      throw new AgentIntegrationError('SESSION_BUSY', 'Chat ID mismatch', false);
    }
    if (this.#isBusy(session)) {
      throw new AgentIntegrationError('SESSION_BUSY', `Session ${agentSessionId} is already running`, false);
    }
    if ((session.sourceTurn?.pendingPermissions.size ?? 0) > 0) {
      throw new AgentIntegrationError('SESSION_BUSY', `Session ${agentSessionId} is waiting for permission`, false);
    }

    this.#retireSession(session, 'session-complete');
  }

  releaseSession(chatId: string, agentSessionId: string | null): void {
    if (!agentSessionId) return;
    this.#restores.cancel(agentSessionId, chatId);
    const session = this.#sessions.get(agentSessionId);
    if (session?.chatId !== chatId) return;
    session.released = true;
    this.#retireSession(session, 'cancelled');
  }

  abort(agentSessionId: string): boolean {
    const session = this.#sessions.get(agentSessionId);
    if (!session) return false;
    const turn = session.activeTurn;
    if (!turn?.running) {
      const pending = session.pendingTurn;
      if (!pending) return false;
      pending.aborted = true;
      session.state = 'aborted';
      // A process-restart agent loses its process at once, as a running turn
      // would; otherwise a hung configure call is bounded like an unanswered cancel.
      if (abortStrategy(this.#policy) === 'process-restart') this.#retireSession(session, 'aborted');
      else this.#armCancelSettleTimeout(pending);
      return true;
    }

    if (abortStrategy(this.#policy) === 'process-restart') {
      turn.aborted = true;
      session.state = 'aborted';
      this.#completeTurn(turn);
      this.#retireSession(session, 'aborted');
      return true;
    }

    turn.aborted = true;
    session.state = 'aborted';
    this.#cancelPermissionsForTurn(turn, 'aborted');
    try {
      session.client.cancelSession({ sessionId: session.remoteSessionId });
    } catch (error) {
      this.#logger.warn('ACP cancel could not be delivered.', {
        agentId: this.#policy.agentId,
        sessionId: session.id,
        error: humanizeError(error),
      });
    }
    this.#armCancelSettleTimeout(turn);
    return true;
  }

  isRunning(agentSessionId: string): boolean {
    const session = this.#sessions.get(agentSessionId);
    return session ? this.#isBusy(session) : false;
  }

  getRunningSessions(): Array<{ id: string; status?: string; startedAt?: string }> {
    return Array.from(this.#sessions.values())
      .filter((session) => this.#isBusy(session))
      .map((session) => ({
        id: session.id,
        status: session.state,
        startedAt: session.startedAt,
      }));
  }

  async #resolvePermission(
    pending: PendingPermissionRequest,
    decision: PermissionDecisionPayload,
  ): Promise<void> {
    if (!this.#pendingPermissions.has(pending) || pending.turn.sourceRetired) {
      throw new Error('ACP permission occurrence is no longer pending');
    }
    pending.session.client.respond(
      pending.requestId,
      pending.responseForDecision(decision),
    );
    this.#pendingPermissions.delete(pending);
    pending.turn.pendingPermissions.delete(pending);
  }

  updateSessionSettings(agentSessionId: string, patch: AcpSessionSettingsPatch): void {
    const session = this.#sessions.get(agentSessionId);
    if (!session) return;
    if (patch.permissionMode !== undefined) {
      session.permissionMode = patch.permissionMode;
      // A turn still configuring becomes the source when its prompt goes out,
      // so it carries the change too.
      for (const turn of [session.sourceTurn, session.pendingTurn]) {
        if (turn) turn.permissionMode = patch.permissionMode;
      }
    }
  }

  shutdown(): void {
    // Fences starts still connecting; restores are cancelled below.
    this.#stopped = true;
    this.#idlePurger.stop();
    this.#restores.cancelAll();
    for (const session of [...this.#sessions.values()]) {
      this.#retireSession(session, 'session-complete');
    }
    this.#sessions.clear();
    this.#pendingPermissions.clear();
  }

  startPurgeTimer(): void {
    this.#stopped = false;
    this.#idlePurger.start();
  }

  async #connectClient(request: AcpStartRequest | AcpResumeRequest): Promise<AcpClient> {
    const command = typeof this.#policy.command === 'function'
      ? this.#policy.command()
      : this.#policy.command;
    const transport = this.#createTransport();
    const client = new AcpClient(transport, {
      initialize: {
        protocolVersion: 1,
        clientInfo: { name: 'garcon', version: '1.0.0' },
        clientCapabilities: this.#policy.clientCapabilities ?? {},
        mcpServers: this.#policy.mcpServers ?? [],
      },
      authenticateMethodId: typeof this.#policy.authenticateMethodId === 'function'
        ? this.#policy.authenticateMethodId()
        : this.#policy.authenticateMethodId,
    });
    try {
      await client.connect({
        command,
        args: this.#policy.args ?? ['acp'],
        cwd: request.projectPath,
        env: childEnvironmentFor(this.#policy, request),
      });
      assertAcpExecutionOpen(request);
    } catch (error) {
      client.close();
      throw error;
    }
    this.#capabilityCache.set({
      command,
      binaryVersion: this.#policy.binaryVersion ?? 'unknown',
    }, client.getAdvertisedCapabilities());
    return client;
  }

  async #sessionForTurn(request: AcpResumeRequest): Promise<AcpAgentRuntimeSession> {
    // Re-checked after each wait: a waiter woken by a failed restore may find
    // another waiter's new restore already in flight.
    for (let restoring = this.#restores.inFlight(request.agentSessionId); restoring;
      restoring = this.#restores.inFlight(request.agentSessionId)) {
      // Only a waiter that joined before the release fails with it; a turn that
      // arrives afterwards starts a fresh restore once the cancelled one settles.
      const joinedBeforeRelease = !restoring.cancelled();
      await restoring.settled;
      if (joinedBeforeRelease && restoring.cancelled()) {
        throw this.#releasedError(request.agentSessionId);
      }
    }
    const existing = this.#sessions.get(request.agentSessionId);
    if (existing) {
      if (existing.chatId !== request.chatId) {
        throw new Error(`ACP session ${request.agentSessionId} is already bound to another chat`);
      }
      return existing;
    }
    return this.#restores.run(request.agentSessionId, request.chatId, (isCancelled) => this.#restoreSession(request, isCancelled));
  }

  async #restoreSession(request: AcpResumeRequest, isCancelled: () => boolean): Promise<AcpAgentRuntimeSession> {
    const client = await this.#connectClient(request);
    // A release during connect stops the restore before it resumes the session.
    if (isCancelled() || this.#stopped) {
      client.close();
      throw this.#releasedError(request.agentSessionId);
    }
    const capabilities = client.getAdvertisedCapabilities();
    const order = reconnectOrder(capabilities);
    const baseSession = newRuntimeSession({
      id: request.agentSessionId,
      remoteSessionId: request.agentSessionId,
      chatId: request.chatId,
      projectPath: request.projectPath,
      client,
      capabilities,
      permissionMode: request.permissionMode,
    });
    // Registered only once restored, so a failed restore leaves nothing a later
    // turn could mistake for a live session.
    let connected = false;
    try {
      connected = await this.#reconnectSession(baseSession, request, order);
    } finally {
      if (!connected) client.close();
    }
    if (!connected) {
      throw new Error(`Unable to restore ${this.#policy.agentId} session ${request.agentSessionId}. Start a new chat session.`);
    }
    if (isCancelled() || this.#stopped) {
      client.close();
      throw this.#releasedError(request.agentSessionId);
    }
    this.#registerSession(baseSession);
    return baseSession;
  }

  async #reconnectSession(
    session: AcpAgentRuntimeSession,
    request: AcpResumeRequest,
    order: ReconnectStrategy[],
  ): Promise<boolean> {
    const restored = await reconnectAcpSession(session.client, {
      sessionId: session.remoteSessionId,
      cwd: request.projectPath,
      mcpServers: this.#policy.mcpServers,
      allowNewSession: this.#policy.reconnectAllowNewSession === true,
      newSessionModel: newSessionModelFor(this.#policy, request),
    }, order);
    if (!restored) return false;
    session.remoteSessionId = restored.sessionId;
    session.configOptions = restored.configOptions;
    session.models = restored.models;
    session.agentDefaultModelId ??= restored.models?.currentModelId;
    return true;
  }

  async #runPrompt(
    session: AcpAgentRuntimeSession,
    request: AcpStartRequest | AcpResumeRequest,
    prompt: AcpPrompt,
    onExecutionStarted?: () => void,
  ): Promise<void> {
    assertAcpExecutionOpen(request);
    const turn = this.#createTurn(session, request);
    // Reserved before the first await, so the busy check that admitted this
    // turn cannot admit another one.
    session.pendingTurn = turn;
    session.state = 'running';
    const releasePending = () => {
      if (session.pendingTurn === turn) session.pendingTurn = null;
    };
    this.#bindTurnSource(turn);
    this.#converter.beginTurn?.(session.id);

    let success = false;
    let shouldThrow = false;
    let failureMessage = '';
    let executionStarted = false;
    let admissionClosed = false;

    try {
      const promptConfig = promptConfigFor(this.#policy, request);
      await configureSessionFor(this.#policy, session, request);
      // Stopped while configuring: end before admission records the turn as started.
      if (turn.aborted) return;
      if (request.executionAdmission) await markAcpExecutionStarted(request);
      if (turn.aborted) return;
      const promptRequest = session.client.promptSession({
        sessionId: session.remoteSessionId,
        prompt,
        ...(promptConfig ? { config: promptConfig } : {}),
      }, () => {
        releasePending();
        if (!this.#activateTurnSource(turn, request.projectPath)) return;
        executionStarted = true;
        onExecutionStarted?.();
      });
      await promptRequest;
      const reportedFailure = this.#converter.takeTurnFailure?.(session.id) ?? null;
      if (reportedFailure && !turn.aborted) {
        shouldThrow = true;
        failureMessage = reportedFailure;
      } else {
        success = !turn.aborted;
      }
    } catch (error) {
      admissionClosed = request.executionAdmission?.signal.aborted === true;
      // The transport failure is reported; an in-band failure the agent sent
      // first must not add a second error row at the final flush.
      this.#converter.takeTurnFailure?.(session.id);
      if (turn.aborted) {
        success = false;
      } else {
        shouldThrow = true;
        failureMessage = humanizeError(error);
      }
    } finally {
      releasePending();
      const finalMessages = executionStarted ? this.#emitFlushedMessages(turn)
        .filter((message) => message.type === 'assistant-message') : [];
      if (turn.aborted) {
        session.state = 'aborted';
      } else if (admissionClosed) {
        session.state = 'idle';
      } else {
        session.state = failureMessage ? 'failed' : 'idle';
      }
      session.lastActivityAt = Date.now();
      this.#completeTurn(turn);

      if (success && !turn.sourceRetired) {
        this.#publishTurnEvent(turn, {
          type: 'run-ended',
          runId: turn.operation.runId,
          outcome: 'finished',
          ...(finalMessages.length > 0 ? { finalResponse: { type: 'text' as const,
            text: finalMessages.map((message) => message.content).join('\n\n') } } : {}),
        });
      } else if (!turn.aborted && !admissionClosed && failureMessage && !turn.sourceRetired) {
        this.#publishMessages(turn, [
          new ErrorMessage(new Date().toISOString(), failureMessage),
        ]);
        this.#publishTurnEvent(turn, {
          type: 'run-ended',
          runId: turn.operation.runId,
          outcome: 'failed',
          error: { code: 'PROVIDER_FAILURE', message: failureMessage },
        });
      }

      this.#cancelPermissionsForTurn(turn, turn.aborted ? 'aborted' : 'session-complete');
      if (!executionStarted) this.#retireTurnSource(turn, 'cancelled');
    }

    if (shouldThrow) {
      throw new Error(failureMessage);
    }
  }

  #createTurn(
    session: AcpAgentRuntimeSession,
    request: AcpStartRequest | AcpResumeRequest,
  ): AcpTurnContext {
    return {
      session,
      operation: request.operation,
      pendingPermissions: new Set(),
      detachSourceListeners: [],
      permissionMode: request.permissionMode,
      running: false,
      completed: false,
      aborted: false,
      sourceActive: false,
      sourceRetired: false,
      settled: Promise.withResolvers<void>(),
      cancelTimer: null,
    };
  }

  #activateTurnSource(turn: AcpTurnContext, projectPath: string): boolean {
    const session = turn.session;
    if (session.retired) return false;
    const previous = session.sourceTurn;
    if (previous && previous !== turn) {
      this.#retireTurnSource(previous, 'session-complete');
    }
    turn.sourceActive = true;
    turn.running = true;
    session.sourceTurn = turn;
    session.activeTurn = turn;
    session.permissionMode = turn.permissionMode;
    session.projectPath = projectPath;
    session.state = 'running';
    session.lastActivityAt = Date.now();
    return true;
  }

  #bindTurnSource(turn: AcpTurnContext): void {
    const session = turn.session;
    turn.detachSourceListeners.push(session.client.onRpcMessage((message) => {
      if (!this.#canRouteSource(turn)) return;
      if (message.method === 'session/update') {
        this.#onSessionUpdate(turn, message.params);
        return;
      }
      if (message.method === 'session/request_permission' && isJsonRpcId(message.id)) {
        this.#onPermissionRequest(turn, message.id, message.params);
        return;
      }
      if (typeof message.method === 'string' && isJsonRpcId(message.id)) {
        if (!this.#onCustomBlockingRequest(turn, message.id, message.method, message.params)) {
          session.client.respondError(message.id, -32601, `Unsupported ACP request method: ${message.method}`);
        }
      }
    }));

    turn.detachSourceListeners.push(session.client.onExit((exitCode) => {
      if (!this.#canRouteSource(turn)) return;
      if (turn.running && !turn.aborted) {
        // Text streamed before the crash is published ahead of the one failure row.
        this.#converter.takeTurnFailure?.(session.id);
        this.#emitFlushedMessages(turn);
        const message = `${this.#policy.agentId} ACP process exited with code ${exitCode}`;
        this.#publishMessages(turn, [new ErrorMessage(new Date().toISOString(), message)]);
        session.state = 'failed';
        session.lastActivityAt = Date.now();
        this.#completeTurn(turn);
        this.#publishTurnEvent(turn, {
          type: 'run-ended',
          runId: turn.operation.runId,
          outcome: 'failed',
          error: { code: 'PROVIDER_FAILURE', message },
        });
      }
      this.#retireSession(session, 'cancelled', true);
    }));

    turn.detachSourceListeners.push(session.client.onStderr((line) => {
      if (!this.#canRouteSource(turn)) return;
      if (!line.trim()) return;
      this.#publishMessages(turn, [new ErrorMessage(new Date().toISOString(), line)]);
    }));
  }

  #onSessionUpdate(turn: AcpTurnContext, rawParams: unknown): void {
    const params = asObject(rawParams) as AcpSessionUpdateNotification;
    const remoteSessionId = asString(params.sessionId);
    const session = turn.session;
    if (!remoteSessionId || remoteSessionId !== session.remoteSessionId) {
      this.#logger.warn('Dropped an ACP session update without its owning native session.', {
        agentId: this.#policy.agentId,
        sessionId: session.id,
      });
      return;
    }

    session.lastActivityAt = Date.now();
    const context = this.#sessionUpdateContext(turn);
    const converted = this.#converter.fromSessionUpdate(params, context);
    if (turn.completed) {
      converted.push(...(this.#converter.endTurn?.(session.id, context) ?? []));
    }
    this.#publishMessages(turn, converted);
  }

  #onPermissionRequest(turn: AcpTurnContext, requestId: AcpJsonRpcId, rawParams: unknown): void {
    const params = asObject(rawParams) as AcpSessionRequestPermission;
    const remoteSessionId = asString(params.sessionId);
    const session = turn.session;
    if (!remoteSessionId || remoteSessionId !== session.remoteSessionId) {
      this.#logger.warn('Dropped an ACP permission request without its owning native session.', {
        agentId: this.#policy.agentId,
        sessionId: session.id,
      });
      return;
    }

    const options = (Array.isArray(params.options) ? params.options : [])
      .map((option) => asObject(option));
    const toolCall = asObject(params.toolCall);
    const context = this.#sessionUpdateContext(turn);
    // The converter sees requests the runtime answers itself too, since one can
    // carry arguments that no earlier frame of its call had.
    const convertedTool = this.#converter.permissionToolUse?.(toolCall, context) ?? null;

    // A cooperative cancel keeps the turn routable until the prompt settles;
    // nothing the agent asks for after Stop may run.
    if (turn.aborted) {
      session.client.respond(requestId, permissionCancelledOutcome());
      return;
    }

    if (isAutoApproveMode(turn.permissionMode, this.#policy)) {
      session.client.respond(requestId, permissionChoiceOutcome(options, 'auto-approve'));
      return;
    }

    const permissionOccurrenceId = crypto.randomUUID();
    const requestedTool = convertedTool
      ?? fallbackPermissionToolUse(toolCall, permissionOccurrenceId, context.timestamp);

    const pending = this.#registerPendingPermission(
      turn,
      permissionOccurrenceId,
      requestId,
      (decision) => permissionChoiceOutcome(
        options,
        decision.allow ? (decision.alwaysAllow ? 'allow-always' : 'allow-once') : 'reject',
      ),
      permissionCancelledOutcome,
    );
    this.#publishTurnEvent(turn, {
      type: 'permission',
      runId: turn.operation.runId,
      lifecycle: {
        kind: 'requested',
        permissionOccurrenceId: pending.permissionOccurrenceId,
        requestedTool,
        options: [],
      },
      decision: this.#decisionCapability(pending),
    });
  }

  #onCustomBlockingRequest(
    turn: AcpTurnContext,
    requestId: AcpJsonRpcId,
    method: string,
    params: unknown,
  ): boolean {
    const context = this.#sessionUpdateContext(turn);
    const permissionOccurrenceId = crypto.randomUUID();
    const converted = this.#converter.customRequestToolUse?.({
      method,
      permissionOccurrenceId,
      params,
    }, context) ?? null;
    if (!converted) return false;
    if (turn.aborted) {
      turn.session.client.respond(requestId, converted.responseForCancellation('aborted'));
      return true;
    }

    const pending = this.#registerPendingPermission(
      turn,
      permissionOccurrenceId,
      requestId,
      converted.responseForDecision,
      converted.responseForCancellation,
    );
    this.#publishTurnEvent(turn, {
      type: 'permission',
      runId: turn.operation.runId,
      lifecycle: {
        kind: 'requested',
        permissionOccurrenceId: pending.permissionOccurrenceId,
        requestedTool: converted.tool,
        options: [],
      },
      decision: this.#decisionCapability(pending),
    });
    return true;
  }

  #registerPendingPermission(
    turn: AcpTurnContext,
    permissionOccurrenceId: string,
    requestId: AcpJsonRpcId,
    responseForDecision: PendingPermissionRequest['responseForDecision'],
    responseForCancellation: PendingPermissionRequest['responseForCancellation'],
  ): PendingPermissionRequest {
    const pending: PendingPermissionRequest = {
      permissionOccurrenceId,
      session: turn.session,
      turn,
      requestId,
      responseForDecision,
      responseForCancellation,
    };
    turn.pendingPermissions.add(pending);
    this.#pendingPermissions.add(pending);
    return pending;
  }

  #decisionCapability(pending: PendingPermissionRequest) {
    return Object.freeze({
      permissionOccurrenceId: pending.permissionOccurrenceId,
      respond: (decision: PermissionDecisionPayload) => this.#resolvePermission(pending, decision),
    });
  }

  #cancelPermissionsForTurn(
    turn: AcpTurnContext,
    reason: 'cancelled' | 'session-complete' | 'aborted',
  ): void {
    for (const pending of [...turn.pendingPermissions]) {
      if (!this.#pendingPermissions.delete(pending)) continue;
      try {
        pending.session.client.respond(pending.requestId, pending.responseForCancellation(reason));
      } catch {}
      this.#publishTurnEvent(turn, {
        type: 'permission',
        runId: turn.operation.runId,
        lifecycle: {
          kind: 'cancelled',
          permissionOccurrenceId: pending.permissionOccurrenceId,
          reason,
        },
      });
    }
    turn.pendingPermissions.clear();
  }

  #completeTurn(turn: AcpTurnContext): void {
    if (turn.completed) return;
    turn.completed = true;
    turn.running = false;
    const session = turn.session;
    if (session.activeTurn === turn) session.activeTurn = null;
    turn.settled.resolve();
  }

  #emitFlushedMessages(turn: AcpTurnContext): ChatMessage[] {
    // Retiring flushed the turn and released the converter's session; flushing
    // again would recreate converter state for a session that is gone.
    if (turn.sourceRetired) return [];
    const messages = this.#converter.endTurn?.(
      turn.session.id,
      this.#sessionUpdateContext(turn),
    ) ?? [];
    this.#publishMessages(turn, messages);
    return messages;
  }

  #publishMessages(
    turn: AcpTurnContext,
    messages: ChatMessage[],
  ): void {
    if (messages.length === 0 || turn.sourceRetired) return;
    this.#publishTurnEvent(turn, {
      type: 'rows',
      rows: runtimeRows(messages),
    });
  }

  #publishTurnEvent(turn: AcpTurnContext, event: AgentRuntimeEvent): void {
    if (turn.sourceRetired) return;
    try {
      turn.operation.publish(event);
    } catch (error) {
      this.#logger.warn('ACP publisher rejected an event.', {
        agentId: this.#policy.agentId,
        sessionId: turn.session.id,
        eventType: event.type,
        error: humanizeError(error),
      });
    }
  }

  #canRouteSource(turn: AcpTurnContext): boolean {
    return turn.sourceActive && !turn.sourceRetired;
  }

  #retireSupersededChatSessions(current: AcpAgentRuntimeSession): void {
    for (const session of [...this.#sessions.values()]) {
      if (session === current || session.chatId !== current.chatId) continue;
      this.#retireSession(session, 'session-complete');
    }
  }

  #retireTurnSource(
    turn: AcpTurnContext,
    reason: 'cancelled' | 'session-complete' | 'aborted',
  ): void {
    if (turn.sourceRetired) return;
    this.#cancelPermissionsForTurn(turn, reason);
    turn.sourceActive = false;
    turn.sourceRetired = true;
    for (const detach of turn.detachSourceListeners.splice(0)) detach();
    if (turn.session.sourceTurn === turn) turn.session.sourceTurn = null;
  }

  #retireSession(
    session: AcpAgentRuntimeSession,
    reason: 'cancelled' | 'session-complete' | 'aborted',
    processExited = false,
  ): void {
    if (session.retired) return;
    session.retired = true;
    session.lastActivityAt = Date.now();
    const turns = new Set([session.activeTurn, session.sourceTurn, session.pendingTurn].filter(
      (turn): turn is AcpTurnContext => turn !== null,
    ));
    for (const turn of turns) {
      // Buffered text still belongs to the transcript; the agent kept it. A held
      // in-band failure does not: the stop or crash is what ended the turn.
      if (this.#canRouteSource(turn)) {
        this.#converter.takeTurnFailure?.(session.id);
        this.#emitFlushedMessages(turn);
      }
      // A turn deliberately retired before its prompt went out never ran, so it
      // ends as aborted; a crash still fails it.
      if (reason === 'aborted' || (turn === session.pendingTurn && !processExited)) turn.aborted = true;
      this.#completeTurn(turn);
      this.#retireTurnSource(turn, reason);
    }
    if (this.#sessions.get(session.id) === session) {
      this.#sessions.delete(session.id);
      this.#converter.releaseSession?.(session.id);
    }
    session.client.close();
  }

  // Each session watches its own process, so a death while no turn is routing
  // (idle, restored, or still configuring) still retires it. A routable turn's
  // own listener reports the failure first and retires the session.
  #registerSession(session: AcpAgentRuntimeSession): void {
    this.#sessions.set(session.id, session);
    session.client.onExit(() => {
      const turn = session.activeTurn;
      if (turn && this.#canRouteSource(turn)) return;
      this.#retireSession(session, 'cancelled', true);
    });
  }

  #sessionUpdateContext(turn: AcpTurnContext): AcpSessionUpdateContext {
    return {
      chatId: turn.session.chatId,
      sessionId: turn.session.id,
      timestamp: new Date().toISOString(),
    };
  }
}
