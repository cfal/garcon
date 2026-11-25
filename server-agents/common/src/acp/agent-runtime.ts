import crypto from 'node:crypto';
import {
  ErrorMessage,
  isToolUseMessage,
  type ChatMessage,
} from '@garcon/common/chat-types';
import type { PermissionDecisionPayload } from '@garcon/common/chat-command-contracts';
import {
  runtimeRows,
  type AgentRuntimeEvent,
  type AgentRuntimeOperation,
  type RuntimeSteerRequest,
  type RuntimeSteerTarget,
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
import {
  AgentIntegrationError,
  type AgentLogger,
  type AgentSteerRejectionReason,
  type AgentSteerResult,
} from '@garcon/server-agent-interface';
import { AcpClient } from './client.js';
import { AcpRpcError } from './errors.js';
import type {
  AcpJsonRpcId,
  AcpSessionPromptResult,
  AcpSessionRequestPermission,
  AcpSessionUpdateNotification,
} from './protocol.js';
import { reconnectAcpSession } from './reconnect-policy.js';
import { garconInitializeParams, isJsonRpcId } from './protocol.js';
import {
  childEnvironmentFor,
  nativePathFor,
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
import { asObject, asString, type AcpBlockingRequestToolUse, type AcpEventConverter, type AcpSessionUpdateContext } from './event-converter.js';
import { IdleSessionPurger } from '../shared/idle-session-purger.js';
import { waitUnlessAborted } from '../shared/shared-probe.js';
import {
  unlessSettled,
  fallbackPermissionToolUse,
  humanizeError,
  automaticPermissionChoice,
  permissionCancelledOutcome,
  permissionChoiceOutcome,
} from './runtime-helpers.js';

// How long a cancelled prompt may take to settle before the next turn replaces its process.
const DEFAULT_CANCEL_SETTLE_TIMEOUT_MS = 10_000;
// How long the agent may take to settle the prompt a steer superseded, or to refuse the steer.
const DEFAULT_STEER_DECISION_TIMEOUT_MS = 15_000;

export interface AcpAgentRuntimeOptions {
  converter: AcpEventConverter;
  createTransport?: () => AcpTransport;
  logger?: AgentLogger;
  cancelSettleTimeoutMs?: number;
  steerDecisionTimeoutMs?: number;
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
  #steerDecisionTimeoutMs: number;
  #sessions = new Map<string, AcpAgentRuntimeSession>();
  #steerTargets = new WeakMap<RuntimeSteerTarget, AcpTurnContext>();
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
    this.#steerDecisionTimeoutMs = options.steerDecisionTimeoutMs ?? DEFAULT_STEER_DECISION_TIMEOUT_MS;
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
      signal.addEventListener('abort', cancelStart, { once: true });
      const turn = this.#runPrompt(session, request, prompt, () => {
        // Publishing the binding also acknowledges any handoff prefix in this prompt.
        request.onSessionActivated?.(result);
        signal.throwIfAborted();
        this.#retireSupersededChatSessions(session);
        signal.removeEventListener('abort', cancelStart);
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
    const pending: PendingResume = {
      sessionId: request.agentSessionId,
      chatId: request.chatId,
      permissionMode: request.permissionMode,
      release: new AbortController(),
    };
    const signal = AbortSignal.any([this.#admissionSignal(request), pending.release.signal]);
    this.#pendingResumes.add(pending);
    try {
      let session = await this.#sessionForTurn(request, signal);
      signal.throwIfAborted();
      const cancelled = session.activeTurn ?? session.pendingTurn;
      if (cancelled?.aborted) {
        await waitUnlessAborted(cancelled.settled.promise, signal);
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
    return session.activeTurn !== null || session.pendingTurn !== null;
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
    const turn = session.activeTurn ?? session.pendingTurn;
    if (!turn) return false;

    turn.aborted = true;
    session.state = 'aborted';
    if (this.#policy.abortStrategy === 'process-restart') {
      if (session.activeTurn === turn) this.#completeTurn(turn);
      this.#retireSession(session, 'aborted');
      return true;
    }

    // A configuring turn has no prompt to cancel, but it still needs the settle deadline.
    if (session.activeTurn === turn) {
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

  captureSteerTarget(agentSessionId: string): RuntimeSteerTarget | null {
    const turn = this.#sessions.get(agentSessionId)?.activeTurn;
    if (!turn || this.#steerRejection(turn)) return null;
    const target = Object.freeze({});
    this.#steerTargets.set(target, turn);
    return target;
  }

  async steer(request: RuntimeSteerRequest): Promise<AgentSteerResult> {
    const turn = request.target ? this.#steerTargets.get(request.target) : undefined;
    if (!turn) return rejectedSteer('no-active-turn', 'No active turn');
    this.#steerTargets.delete(request.target!);
    if (turn.session.id !== request.agentSessionId || turn.session.chatId !== request.chatId) {
      return rejectedSteer('turn-changed', 'The steering target belongs to another session');
    }
    turn.steersInFlight += 1;
    try {
      return await this.#steerTurn(turn, request);
    } finally {
      turn.steersInFlight -= 1;
      this.#closePromptsIfDrained(turn);
    }
  }

  async #steerTurn(turn: AcpTurnContext, request: RuntimeSteerRequest): Promise<AgentSteerResult> {
    // Taken before delivery is prepared, so nothing waits between preparing and sending.
    while (turn.steerSlot) await turn.steerSlot;
    const slot = Promise.withResolvers<void>();
    turn.steerSlot = slot.promise;
    try {
      const rejection = this.#steerRejection(turn);
      if (rejection) return rejection;
      await request.prepareDelivery();
      // Checked and sent without an await between them, so the prompt cannot miss the turn's end.
      return this.#steerRejection(turn) ?? await this.#sendSteer(turn, request.input);
    } finally {
      turn.steerSlot = null;
      slot.resolve();
    }
  }

  #steerRejection(turn: AcpTurnContext): AgentSteerResult | null {
    if (!this.#policy.steersWithOverlappingPrompts) {
      return rejectedSteer('turn-not-steerable', `${this.#policy.agentId} does not take steering input`);
    }
    const session = turn.session;
    if (
      turn.completed
      || turn.promptsClosed
      || turn.aborted
      || turn.sourceRetired
      || session.retired
      || session.activeTurn !== turn
      || !session.client.isConnected
    ) {
      return rejectedSteer('turn-changed', 'The active turn changed');
    }
    // The agent refuses an overlapping prompt until the answer arrives.
    if (turn.pendingPermissions.size > 0) {
      return rejectedSteer('turn-not-steerable', 'The active turn is waiting for a permission answer');
    }
    return null;
  }

  // The agent accepts the steer by settling a prompt the steer supersedes, and
  // refuses it with an error on the steer's prompt while those still run. With
  // none open, as when the turn's prompt settled while this steer was held, the
  // agent runs the steer as the next prompt, so a written steer is accepted.
  #sendSteer(turn: AcpTurnContext, input: string): Promise<AgentSteerResult> {
    const superseded = [...turn.openPrompts];
    const decision = Promise.withResolvers<AgentSteerResult>();
    const accept = () => decision.resolve({ kind: 'accepted' });
    const prompt = turn.session.client.promptSession({
      sessionId: turn.session.id,
      prompt: [{ type: 'text', text: input }],
    }, superseded.length === 0 ? accept : undefined);
    this.#trackTurnPrompt(turn, prompt);
    // A superseded prompt that fails is an earlier refused steer or a lost
    // transport, which the steer's own prompt then reports.
    for (const open of superseded) open.then(accept, () => {});
    prompt.then(accept, (error: unknown) => decision.resolve(
      error instanceof AcpRpcError && superseded.some((open) => turn.openPrompts.has(open))
        ? rejectedSteer('provider-rejected', error.message)
        : unconfirmedSteer(humanizeError(error)),
    ));
    const timer = setTimeout(() => decision.resolve(unconfirmedSteer(
      `${this.#policy.agentId} did not confirm the steering input within ${this.#steerDecisionTimeoutMs}ms`,
    )), this.#steerDecisionTimeoutMs);
    timer.unref?.();
    return decision.promise.finally(() => clearTimeout(timer));
  }

  // Registered before any decision handler, so those see this prompt's settlement in `openPrompts`.
  #trackTurnPrompt(turn: AcpTurnContext, prompt: Promise<AcpSessionPromptResult>): void {
    turn.openPrompts.add(prompt);
    const settle = (failure: { readonly error: unknown } | null) => {
      turn.openPrompts.delete(prompt);
      // A failure while another prompt still runs is the agent refusing this one.
      if (!failure || turn.openPrompts.size === 0) turn.promptFailure = failure;
      this.#closePromptsIfDrained(turn);
    };
    prompt.then(() => settle(null), (error: unknown) => settle({ error }));
  }

  // Closes in the same step that observes the drain, so no later steer can pass its checks.
  #closePromptsIfDrained(turn: AcpTurnContext): void {
    if (turn.promptsClosed || turn.openPrompts.size > 0 || turn.steersInFlight > 0) return;
    turn.promptsClosed = true;
    turn.promptsDrained.resolve();
  }

  #announceSteerable(turn: AcpTurnContext): void {
    if (this.#steerRejection(turn)) return;
    this.#publishTurnEvent(turn, { type: 'steerable' });
  }

  async #resolvePermission(
    pending: PendingPermissionRequest,
    decision: PermissionDecisionPayload,
  ): Promise<void> {
    if (!this.#pendingPermissions.has(pending) || pending.turn.sourceRetired) {
      throw new Error('ACP permission occurrence is no longer pending');
    }
    pending.turn.session.client.respond(
      pending.requestId,
      pending.responseForDecision(decision),
    );
    this.#pendingPermissions.delete(pending);
    pending.turn.pendingPermissions.delete(pending);
    this.#announceSteerable(pending.turn);
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
        : await client.newSession(target);
      signal.throwIfAborted();
      const id = opened.sessionId;
      const owner = this.#sessions.get(id) ?? (!restoring ? this.#restores.get(id) : undefined);
      if (owner) {
        if (owner.chatId !== request.chatId) throw new Error(`ACP session ${id} is already bound to another chat`);
        throw new Error(`ACP session ${id} is already active`);
      }
      const currentModelId = opened.models?.currentModelId;
      // A new session opens on the native default; a resume reports only its current selection.
      if (!restoring && currentModelId) this.#agentDefaultModels.set(request.projectPath, currentModelId);
      const session = newRuntimeSession({
        id,
        chatId: request.chatId,
        projectPath: request.projectPath,
        client,
        configOptions: opened.configOptions,
        models: opened.models,
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
    const { agentSessionId, chatId } = request;
    // Re-checked after each wait: a waiter woken by a failed restore may find
    // another waiter's new restore already in flight.
    for (;;) {
      const restoring = this.#restores.get(agentSessionId);
      if (!restoring) break;
      if (restoring.chatId !== chatId) {
        throw new Error(`ACP session ${agentSessionId} is already bound to another chat`);
      }
      await waitUnlessAborted(restoring.settled, signal);
      signal.throwIfAborted();
    }
    const existing = this.#sessions.get(agentSessionId);
    if (existing) {
      if (existing.chatId !== chatId) {
        throw new Error(`ACP session ${agentSessionId} is already bound to another chat`);
      }
      if (existing.client.isConnected || this.#isBusy(existing)) return existing;
      this.#retireSession(existing, 'cancelled', true);
    }
    const settled = Promise.withResolvers<void>();
    this.#restores.set(agentSessionId, { chatId, settled: settled.promise });
    try {
      return await this.#openSession(request, signal);
    } finally {
      this.#restores.delete(agentSessionId);
      settled.resolve();
    }
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
    let failureMessage: string | null = null;
    let executionStarted = false;
    let admissionClosed = false;

    try {
      await configureSessionFor(this.#policy, session, request, this.#agentDefaultModels.get(session.projectPath));
      // Stopped while configuring: end before admission records the turn as started.
      if (turn.aborted) return;
      if (request.executionAdmission) await markAcpExecutionStarted(request);
      if (turn.aborted) return;
      assertAcpExecutionOpen(request);
      if (session.retired) throw new Error(`${this.#policy.agentId} ACP process exited before the prompt was sent`);
      this.#trackTurnPrompt(turn, session.client.promptSession({
        sessionId: session.id,
        prompt,
      }, () => {
        releasePending();
        if (!this.#activateTurnSource(turn, request.projectPath)) return;
        executionStarted = true;
        // A cooperative Stop during pipe backpressure can now cancel the delivered prompt.
        if (turn.aborted) this.abort(session.id);
        onExecutionStarted?.();
        this.#announceSteerable(turn);
      }));
      // Steers extend the turn, so it ends when all of its prompts have settled.
      await turn.promptsDrained.promise;
      if (turn.promptFailure) throw turn.promptFailure.error;
      const reportedFailure = this.#canRouteSource(turn) ? this.#converter.takeTurnFailure?.(session.id) : null;
      if (reportedFailure && !turn.aborted) {
        failureMessage = reportedFailure;
      } else {
        success = !turn.aborted;
      }
    } catch (error) {
      admissionClosed = request.executionAdmission?.signal.aborted === true;
      // The transport failure is reported; an in-band failure the agent sent
      // first must not add a second error row at the final flush.
      if (this.#canRouteSource(turn)) this.#converter.takeTurnFailure?.(session.id);
      if (!turn.aborted) failureMessage = humanizeError(error);
    } finally {
      releasePending();
      const flushed = executionStarted ? this.#emitFlushedMessages(turn) : [];
      // A deferred tool can publish earlier prose at turn end. Only the trailing
      // answer belongs in notifications and the command result.
      const lastTool = flushed.findLastIndex(message => isToolUseMessage(message) || message.type === 'tool-result');
      const finalMessages = flushed.slice(lastTool + 1).filter(message => message.type === 'assistant-message');
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
      // A broken pipe is terminal even if the OS has not reported the exit yet.
      if (!session.client.isConnected) this.#retireSession(session, 'cancelled', true);
    }

    if (failureMessage !== null) {
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
      completed: false,
      aborted: false,
      sourceRetired: false,
      settled: Promise.withResolvers<void>(),
      cancelTimer: null,
      openPrompts: new Set(),
      steersInFlight: 0,
      steerSlot: null,
      promptFailure: null,
      promptsDrained: Promise.withResolvers<void>(),
      promptsClosed: false,
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

    turn.detachSourceListeners.push(session.client.onStderr((line) => {
      if (!this.#canRouteSource(turn)) return;
      if (!line.trim()) return;
      this.#flushBeforeRuntimeRow(turn);
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
    this.#requestPermission(turn, requestId, permissionOccurrenceId, {
      tool: convertedTool ?? fallbackPermissionToolUse(toolCall, permissionOccurrenceId, context.timestamp),
      responseForDecision: (decision) => {
        if (!decision.allow) return permissionChoiceOutcome(options, 'reject');
        return permissionChoiceOutcome(options, decision.alwaysAllow ? 'allow-always' : 'allow-once');
      },
      responseForCancellation: permissionCancelledOutcome,
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

    this.#requestPermission(turn, requestId, permissionOccurrenceId, converted);
    return true;
  }

  #requestPermission(
    turn: AcpTurnContext,
    requestId: AcpJsonRpcId,
    permissionOccurrenceId: string,
    request: AcpBlockingRequestToolUse,
  ): void {
    const pending: PendingPermissionRequest = {
      permissionOccurrenceId,
      turn,
      requestId,
      responseForDecision: request.responseForDecision,
      responseForCancellation: request.responseForCancellation,
    };
    turn.pendingPermissions.add(pending);
    this.#pendingPermissions.add(pending);
    this.#publishTurnEvent(turn, {
      type: 'permission',
      runId: turn.operation.runId,
      lifecycle: { kind: 'requested', permissionOccurrenceId, requestedTool: request.tool, options: [] },
      decision: Object.freeze({
        permissionOccurrenceId,
        respond: (decision: PermissionDecisionPayload) => this.#resolvePermission(pending, decision),
      }),
    });
  }

  #cancelPermissionsForTurn(
    turn: AcpTurnContext,
    reason: 'cancelled' | 'session-complete' | 'aborted',
  ): void {
    for (const pending of [...turn.pendingPermissions]) {
      if (!this.#pendingPermissions.delete(pending)) continue;
      try {
        turn.session.client.respond(pending.requestId, pending.responseForCancellation(reason));
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
    // Each row travels on its own: one flush can contain more than a remote
    // frame even when every row fits. The relay bounds an individual row.
    for (const message of messages) this.#publishTurnEvent(turn, { type: 'rows', rows: runtimeRows([message]) });
  }

  #flushBeforeRuntimeRow(turn: AcpTurnContext): void {
    if (!this.#canRouteSource(turn)) return;
    this.#publishMessages(turn, this.#converter.flushPending?.(this.#sessionUpdateContext(turn)) ?? []);
  }

  #publishTurnEvent(turn: AcpTurnContext, event: AgentRuntimeEvent): void {
    if (event.type === 'permission') this.#flushBeforeRuntimeRow(turn);
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
    return turn.session.sourceTurn === turn && !turn.sourceRetired;
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

  #registerSession(session: AcpAgentRuntimeSession): void {
    this.#sessions.set(session.id, session);
    session.client.onExit(() => {
      // An active prompt settles its own outcome before retiring the session.
      if (!session.activeTurn) this.#retireSession(session, 'cancelled', true);
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

function rejectedSteer(reason: AgentSteerRejectionReason, message: string): AgentSteerResult {
  return { kind: 'rejected', reason, message };
}

// The steer was written, so the agent may have taken it.
function unconfirmedSteer(message: string): AgentSteerResult {
  return { kind: 'failed', outcome: 'unknown', message };
}
