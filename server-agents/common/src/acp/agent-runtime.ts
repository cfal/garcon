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
import { AcpClient } from './client.js';
import type {
  AcpJsonRpcId,
  AcpSessionRequestPermission,
  AcpSessionUpdateNotification,
} from './protocol.js';
import { reconnectAcpSession } from './reconnect-policy.js';
import { garconInitializeParams, isJsonRpcId } from './protocol.js';
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
  automaticPermissionChoice,
  permissionCancelledOutcome,
  permissionChoiceOutcome,
} from './runtime-helpers.js';

// How long a cancelled prompt may take to settle before the next turn replaces its process.
const DEFAULT_CANCEL_SETTLE_TIMEOUT_MS = 10_000;

export interface AcpAgentRuntimeOptions {
  converter: AcpEventConverter;
  createTransport?: () => AcpTransport;
  logger?: AgentLogger;
  cancelSettleTimeoutMs?: number;
}

interface PendingResume {
  readonly chatId: string;
  readonly sessionId: string;
  readonly release: AbortController;
  permissionMode: AcpResumeRequest['permissionMode'];
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
  #createTransport: () => AcpTransport;
  #logger: AgentLogger;
  #cancelSettleTimeoutMs: number;
  #sessions = new Map<string, AcpAgentRuntimeSession>();
  #restores = new Map<string, { chatId: string; settled: Promise<void> }>();
  #pendingResumes = new Set<PendingResume>();
  #lifetime = new AbortController();
  // The model a session opens with when session/new names none, per project
  // path, since agent settings can differ by workspace. It stands in for the
  // default of a resumed session, which reports only its current model.
  #agentDefaultModels = new Map<string, string>();
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
    this.#createTransport = options.createTransport ?? (() => new AcpTransport());
    this.#logger = options.logger ?? SILENT_LOGGER;
    this.#cancelSettleTimeoutMs = options.cancelSettleTimeoutMs ?? DEFAULT_CANCEL_SETTLE_TIMEOUT_MS;
  }

  async startSession(request: AcpStartRequest): Promise<AcpStartedSession> {
    assertAcpExecutionOpen(request);
    // Built first, so an unusable attachment fails before any process or native
    // conversation exists.
    const prompt = promptFor(this.#policy, request);
    const signal = this.#admissionSignal(request);
    const session = await this.#openSession(request, signal);
    const sessionId = session.id;
    const result = {
      agentSessionId: sessionId,
      nativePath: nativePathFor(this.#policy, sessionId),
    };
    const started = Promise.withResolvers<void>();
    const cancelStart = () => {
      this.#retireSession(session, 'cancelled');
      started.reject(signal.reason);
    };
    try {
      signal.throwIfAborted();
      if (session.retired) throw new Error(`ACP session ${sessionId} retired before activation`);
      request.onSessionActivated?.(result);
      signal.throwIfAborted();
      signal.addEventListener('abort', cancelStart, { once: true });
      const turn = this.#runPrompt(session, request, prompt, () => {
        signal.removeEventListener('abort', cancelStart);
        this.#retireSupersededChatSessions(session);
        started.resolve();
      });
      void turn.then(() => started.reject(new Error('ACP session ended before execution started')), started.reject);
      await started.promise;
    } catch (error) {
      this.#retireSession(session, 'cancelled');
      throw error;
    } finally {
      signal.removeEventListener('abort', cancelStart);
    }

    return result;
  }

  async runTurn(request: AcpResumeRequest): Promise<void> {
    assertAcpExecutionOpen(request);
    const prompt = promptFor(this.#policy, request);
    const pending = { sessionId: request.agentSessionId, chatId: request.chatId,
      permissionMode: request.permissionMode, release: new AbortController() };
    const signal = AbortSignal.any([this.#admissionSignal(request), pending.release.signal]);
    this.#pendingResumes.add(pending);
    try {
      let session = await this.#sessionForTurn(request, signal);
      signal.throwIfAborted();
      const cancelled = session.activeTurn?.running ? session.activeTurn : session.pendingTurn;
      if (cancelled?.aborted) {
        await untilSettledOrClosed(cancelled.settled.promise, signal);
        signal.throwIfAborted();
      }
      if (session.retired) {
        session = await this.#sessionForTurn(request, signal);
        signal.throwIfAborted();
        if (session.retired) throw new Error(`ACP session ${session.id} retired before activation`);
      }
      if (this.#isBusy(session)) throw new Error(`Session ${session.id} is already running`);
      // runPrompt reserves the turn before its first await; it now owns live updates.
      return this.#runPrompt(session, { ...request, permissionMode: pending.permissionMode }, prompt);
    } finally {
      this.#pendingResumes.delete(pending);
    }
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

    if (this.#restores.has(agentSessionId)) {
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
    for (const pending of this.#pendingResumes) {
      if (pending.chatId === chatId && pending.sessionId === agentSessionId) {
        pending.release.abort(this.#releasedError(agentSessionId));
      }
    }
    const session = this.#sessions.get(agentSessionId);
    if (session?.chatId !== chatId) return;
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
      session.client.cancelSession({ sessionId: session.id });
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
    const mode = patch.permissionMode;
    if (mode === undefined) return;
    for (const pending of this.#pendingResumes) {
      if (pending.sessionId === agentSessionId) pending.permissionMode = mode;
    }
    const session = this.#sessions.get(agentSessionId);
    if (!session) return;
    // A turn still configuring becomes the source when its prompt goes out.
    for (const turn of [session.sourceTurn, session.pendingTurn]) {
      if (turn) turn.permissionMode = mode;
    }
  }

  shutdown(): void {
    this.#lifetime.abort(new Error(`The ${this.#policy.agentId} runtime stopped while the session was starting.`));
    this.#idlePurger.stop();
    for (const session of [...this.#sessions.values()]) {
      this.#retireSession(session, 'session-complete');
    }
    this.#sessions.clear();
    this.#pendingPermissions.clear();
  }

  startPurgeTimer(): void {
    if (this.#lifetime.signal.aborted) this.#lifetime = new AbortController();
    this.#idlePurger.start();
  }

  #admissionSignal(request: AcpStartRequest | AcpResumeRequest): AbortSignal {
    const lifetime = this.#lifetime.signal;
    if (lifetime.aborted) throw new Error(`The ${this.#policy.agentId} runtime is shutting down.`);
    return request.executionAdmission ? AbortSignal.any([lifetime, request.executionAdmission.signal]) : lifetime;
  }

  async #openSession(request: AcpStartRequest | AcpResumeRequest, signal: AbortSignal): Promise<AcpAgentRuntimeSession> {
    signal.throwIfAborted();
    const command = typeof this.#policy.command === 'function'
      ? this.#policy.command()
      : this.#policy.command;
    const transport = this.#createTransport();
    const client = new AcpClient(transport, {
      initialize: garconInitializeParams({
        clientCapabilities: this.#policy.clientCapabilities,
        mcpServers: this.#policy.mcpServers ?? [],
      }),
      authenticateMethodId: typeof this.#policy.authenticateMethodId === 'function'
        ? this.#policy.authenticateMethodId()
        : this.#policy.authenticateMethodId,
    });
    // Before registration the admission owns the process, including a stalled
    // handshake or native open. After registration the session owns it.
    const close = () => client.close();
    signal.addEventListener('abort', close, { once: true });
    try {
      await client.connect({
        command,
        args: this.#policy.args ?? ['acp'],
        cwd: request.projectPath,
        env: childEnvironmentFor(this.#policy, request),
      });
      signal.throwIfAborted();
      const target = { cwd: request.projectPath, mcpServers: this.#policy.mcpServers };
      const restoring = 'agentSessionId' in request;
      const opened = restoring
        ? await reconnectAcpSession(client, { ...target, sessionId: request.agentSessionId })
        : await client.newSession({ ...target, model: newSessionModelFor(this.#policy, request) });
      signal.throwIfAborted();
      const id = opened.sessionId;
      const owner = this.#sessions.get(id) ?? (!restoring ? this.#restores.get(id) : undefined);
      if (owner) {
        if (owner.chatId !== request.chatId) throw new Error(`ACP session ${id} is already bound to another chat`);
        throw new Error(`ACP session ${id} is already active`);
      }
      const session = newRuntimeSession({
        id, chatId: request.chatId, projectPath: request.projectPath,
        client, configOptions: opened.configOptions, models: opened.models,
        agentDefaultModelId: restoring
          ? this.#agentDefaultModels.get(request.projectPath) ?? opened.models?.currentModelId
          : this.#learnAgentDefaultModel(request, opened.models?.currentModelId),
      });
      this.#registerSession(session);
      return session;
    } catch (error) {
      client.close();
      signal.throwIfAborted();
      throw error;
    } finally {
      signal.removeEventListener('abort', close);
    }
  }

  async #sessionForTurn(request: AcpResumeRequest, signal: AbortSignal): Promise<AcpAgentRuntimeSession> {
    // Re-checked after each wait: a waiter woken by a failed restore may find
    // another waiter's new restore already in flight.
    for (let restoring = this.#restores.get(request.agentSessionId); restoring;
      restoring = this.#restores.get(request.agentSessionId)) {
      if (restoring.chatId !== request.chatId) {
        throw new Error(`ACP session ${request.agentSessionId} is already bound to another chat`);
      }
      await untilSettledOrClosed(restoring.settled, signal);
      signal.throwIfAborted();
    }
    const existing = this.#sessions.get(request.agentSessionId);
    if (existing) {
      if (existing.chatId !== request.chatId) {
        throw new Error(`ACP session ${request.agentSessionId} is already bound to another chat`);
      }
      return existing;
    }
    const settled = Promise.withResolvers<void>();
    this.#restores.set(request.agentSessionId, { chatId: request.chatId, settled: settled.promise });
    try {
      return await this.#openSession(request, signal);
    } finally {
      this.#restores.delete(request.agentSessionId);
      settled.resolve();
    }
  }

  #learnAgentDefaultModel(request: AcpStartRequest, currentModelId: string | undefined): string | undefined {
    if (currentModelId && !newSessionModelFor(this.#policy, request)) {
      this.#agentDefaultModels.set(request.projectPath, currentModelId);
    }
    return this.#agentDefaultModels.get(request.projectPath) ?? currentModelId;
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

    let success = false;
    let shouldThrow = false;
    let failureMessage = '';
    let executionStarted = false;
    let admissionClosed = false;

    try {
      const promptConfig = promptConfigFor(this.#policy, request);
      // A default learned after this session was resumed replaces its guess.
      session.agentDefaultModelId = this.#agentDefaultModels.get(session.projectPath) ?? session.agentDefaultModelId;
      await configureSessionFor(this.#policy, session, request);
      // Stopped while configuring: end before admission records the turn as started.
      if (turn.aborted) return;
      if (request.executionAdmission) await markAcpExecutionStarted(request);
      if (turn.aborted) return;
      assertAcpExecutionOpen(request);
      if (session.retired) throw new Error(`${this.#policy.agentId} ACP process exited before the prompt was sent`);
      const promptRequest = session.client.promptSession({
        sessionId: session.id,
        prompt,
        ...(promptConfig ? { config: promptConfig } : {}),
      }, () => {
        releasePending();
        if (!this.#activateTurnSource(turn, request.projectPath)) return;
        executionStarted = true;
        onExecutionStarted?.();
      });
      await promptRequest;
      const reportedFailure = this.#canRouteSource(turn) ? this.#converter.takeTurnFailure?.(session.id) : null;
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
      if (this.#canRouteSource(turn)) this.#converter.takeTurnFailure?.(session.id);
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
    this.#converter.beginTurn?.(session.id);
    turn.sourceActive = true;
    turn.running = true;
    session.sourceTurn = turn;
    session.activeTurn = turn;
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
    if (!remoteSessionId || remoteSessionId !== session.id) {
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
      // An abandoned request can fail after Stop; the user ended that turn.
      if (turn.aborted) this.#converter.takeTurnFailure?.(session.id);
      converted.push(...(this.#converter.endTurn?.(session.id, context) ?? []));
    }
    this.#publishMessages(turn, converted);
  }

  #onPermissionRequest(turn: AcpTurnContext, requestId: AcpJsonRpcId, rawParams: unknown): void {
    const params = asObject(rawParams) as AcpSessionRequestPermission;
    const remoteSessionId = asString(params.sessionId);
    const session = turn.session;
    if (!remoteSessionId || remoteSessionId !== session.id) {
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

    const automatic = automaticPermissionChoice(turn.permissionMode, toolCall.kind, this.#policy);
    const approval = permissionChoiceOutcome(options, automatic ?? 'allow-once');
    // Interactive controls offer Allow once, never a persistent grant.
    if (automatic || approval.outcome.outcome === 'cancelled') {
      session.client.respond(requestId, approval);
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
