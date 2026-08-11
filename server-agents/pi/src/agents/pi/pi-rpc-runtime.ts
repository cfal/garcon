// Runs one long-lived `pi --mode rpc` process per session. Turns end on `agent_settled`;
// `agent_end` can be followed by retries or queued continuations.

import crypto from 'node:crypto';
import path from 'node:path';
import {
  ErrorMessage,
} from '@garcon/common/chat-types';
import { isArtificialNativePath } from '@garcon/server-agent-common/chats/artificial-native-path';
import { errorMessage } from '@garcon/server-agent-common/lib/errors';
import { IdleSessionPurger } from '@garcon/server-agent-common/shared/idle-session-purger';
import { AgentEventEmitterRuntime } from '@garcon/server-agent-common/shared/event-emitter-runtime';
import { attachNativeMessageSource } from '@garcon/server-agent-common/shared/native-message-source';
import type {
  AgentLogger,
  AgentSteerRequestV4,
  AgentSteerResult,
  AgentSteerTarget,
} from '@garcon/server-agent-interface';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import type { PiConfig } from '../../config.js';
import {
  buildPiCliEnv,
  buildPiRpcSpawnCommand,
  mapThinkingMode,
  pipePiStderr,
  requireExplicitPiModel,
} from './pi-cli.js';
import {
  PiRpcClient,
  PiRpcCommandError,
  PiRpcTransportError,
} from './pi-rpc-client.js';
import {
  classifyPiSteerRejection,
  occurrenceCounts,
  piUserMessageText,
  preparePiRpcPrompt,
  rejectedPiSteer,
  resolvePiThinkingLevel,
  type PreparedPiRpcPrompt,
} from './pi-rpc-protocol.js';
import {
  assertPiExecutionOpen,
  markPiExecutionStarted,
  piEventMetadata,
  type PiResumeRequest,
  type PiStartedSession,
  type PiStartRequest,
} from './runtime-types.js';
import { canonicalExistingPiSessionPath } from './pi-session-paths.js';
import { convertPiMessage } from './message-converter.js';
import { terminatePiProcess } from './pi-process-lifecycle.js';
import type {
  CapturedPiSteerTarget,
  PiActiveTurn,
  PiPromptDispatch,
  PiRetireOptions,
  PiRpcSession,
  PiSteerSubmission,
  PiTurnSettlementRecord,
} from './pi-rpc-session-state.js';
import {
  addExpectedNativeMessage,
  snapshotPiSettlementBaseline,
  verifyPiTurnSettlement,
  type PiTurnSettlementProof,
} from './pi-turn-settlement.js';

export interface PiModelReader {
  getModels(): Promise<Array<{ value: string; label: string; supportsImages?: boolean }>>;
}

const READY_TIMEOUT_MS = 60_000;
const STEER_RESPONSE_TIMEOUT_MS = 15_000;

export class PiRpcRuntime extends AgentEventEmitterRuntime {
  // Settlement evidence for the most recently finished turn per chat. A turn
  // finishes only on agent_settled, and success additionally requires the
  // native session file to contain every finalized row the turn journalled.
  readonly #turnSettlements = new Map<string, PiTurnSettlementRecord>();

  readonly #config: PiConfig;
  readonly #logger: AgentLogger;
  readonly #models: PiModelReader;
  readonly #sessions = new Map<string, PiRpcSession>();
  readonly #liveSessions = new Set<PiRpcSession>();
  readonly #launchingSessionIds = new Set<string>();
  readonly #steerTargets = new WeakMap<AgentSteerTarget, CapturedPiSteerTarget>();
  #shuttingDown = false;
  readonly #idlePurger: IdleSessionPurger<PiRpcSession>;
  readonly #settlementWaitMs: number;

  constructor(options: {
    readonly config: PiConfig;
    readonly logger: AgentLogger;
    readonly models: PiModelReader;
    readonly settlementWaitMs?: number;
    readonly idlePurgeTiming?: {
      readonly intervalMs?: number;
      readonly maxIdleMs?: number;
    };
  }) {
    super();
    this.#config = options.config;
    this.#logger = options.logger;
    this.#models = options.models;
    this.#settlementWaitMs = options.settlementWaitMs ?? 1_500;
    this.#idlePurger = new IdleSessionPurger<PiRpcSession>(
      {
        sessions: () => this.#sessions.entries(),
        isRunning: (session) =>
          session.turn !== null || session.state === 'starting' || session.state === 'retiring',
        lastActivityAt: (session) => session.lastActivityAt,
        purge: (_id, session) => {
          this.#retireInBackground(session, 'idle purge');
        },
      },
      options.idlePurgeTiming,
    );
  }

  async getModels(): Promise<Array<{ value: string; label: string; supportsImages?: boolean }>> {
    return this.#models.getModels();
  }

  async startSession(request: PiStartRequest): Promise<PiStartedSession> {
    assertPiExecutionOpen(request);
    this.#assertAcceptingOperations();
    const prompt = preparePiRpcPrompt(request);
    let session: PiRpcSession | null = null;
    try {
      session = await this.#spawnSession(request, null);
      assertPiExecutionOpen(request);
      this.#assertAcceptingOperations();
      this.#sessions.set(session.id, session);
      this.emitSessionCreated(session.chatId);
      const dispatch = await this.#dispatchPrompt(session, request, prompt);
      // Initial session identity must bind before an unbounded prompt preflight can wedge.
      void dispatch.accepted.catch(() => undefined);
      return { agentSessionId: session.id, nativePath: session.nativePath };
    } catch (error) {
      if (session) {
        await this.#retireAndLog(session, 'initial turn failed', {
          turnOutcome: session.turn?.completion === 'pending' ? 'failed' : 'preserve',
          failureMessage: errorMessage(error),
        });
      }
      throw error;
    }
  }

  async runTurn(request: PiResumeRequest): Promise<void> {
    assertPiExecutionOpen(request);
    this.#assertAcceptingOperations();
    const prompt = preparePiRpcPrompt(request);
    if (this.#launchingSessionIds.has(request.agentSessionId)) {
      throw new Error(`Session ${request.agentSessionId} is already starting a turn`);
    }
    this.#launchingSessionIds.add(request.agentSessionId);

    let session: PiRpcSession | null = null;
    let spawned = false;
    try {
      const existing = this.#sessions.get(request.agentSessionId);
      if (existing?.state === 'retiring') await existing.exitPromise;
      const current = this.#sessions.get(request.agentSessionId);
      if (current?.turn || current?.state === 'starting' || current?.state === 'prompting') {
        throw new Error(`Session ${request.agentSessionId} is already running`);
      }

      const requestedModel = requireExplicitPiModel(request.model);
      const requestedThinking = mapThinkingMode(request.thinkingMode);
      const currentPathExists = current?.nativePath
        ? await canonicalExistingPiSessionPath(current.nativePath) !== null
        : false;
      const reusable = Boolean(
        current
        && current.state === 'idle'
        && current.process
        && !current.process.killed
        && current.client
        && current.model === requestedModel
        && current.thinking === requestedThinking
        && currentPathExists,
      );

      if (reusable) {
        session = current!;
      } else {
        if (current) await this.#retire(current, 'model, thinking, or session-file drift');
        const nativePath = await this.#resolveResumePath(request);
        session = await this.#spawnSession(request, {
          agentSessionId: request.agentSessionId,
          nativePath,
        });
        spawned = true;
      }

      assertPiExecutionOpen(request);
      this.#assertAcceptingOperations();
      if (spawned) this.#sessions.set(request.agentSessionId, session);
      session.chatId = request.chatId;
      session.eventMetadata = piEventMetadata(request);
      session.lastActivityAt = Date.now();
      const dispatch = await this.#dispatchPrompt(session, request, prompt);
      this.#launchingSessionIds.delete(request.agentSessionId);
      await dispatch.accepted;
      await dispatch.settle;
    } catch (error) {
      if (session && (spawned || session.turn?.completion === 'pending')) {
        await this.#retireAndLog(session, 'turn launch failed', {
          turnOutcome: session.turn?.completion === 'pending' ? 'failed' : 'preserve',
          failureMessage: errorMessage(error),
        });
      }
      throw error;
    } finally {
      this.#launchingSessionIds.delete(request.agentSessionId);
    }
  }

  // Kills the process because RPC abort can restart a queued steering message as a new run.
  abort(agentSessionId: string): boolean {
    const session = this.#sessions.get(agentSessionId);
    if (!session?.turn || session.state === 'retiring' || !session.process) return false;
    const turn = session.turn;
    turn.stopRequested = true;
    session.lastActivityAt = Date.now();
    this.#completeTurn(session, turn, 'stopped');
    this.#retireInBackground(session, 'stop requested');
    return true;
  }

  isRunning(agentSessionId: string): boolean {
    return this.#sessions.get(agentSessionId)?.turn != null;
  }

  getRunningSessions(): Array<{ id: string; startedAt: string; status: string }> {
    return Array.from(this.#sessions.values())
      .filter((session) => session.turn !== null)
      .map((session) => ({
        id: session.id,
        startedAt: new Date(session.startTime).toISOString(),
        status: 'running',
      }));
  }

  captureSteerTarget(agentSessionId: string): AgentSteerTarget | null {
    if (this.#shuttingDown) return null;
    const session = this.#sessions.get(agentSessionId);
    const turn = session?.turn;
    if (
      !session
      || !turn
      || session.state !== 'active'
      || turn.stopRequested
      || turn.settleObserved
      || session.pendingFinish !== null
      || !session.process
      || session.process.killed
      || !session.client
    ) return null;
    const target = Object.freeze({});
    this.#steerTargets.set(target, { session, generation: session.generation, turn });
    return target;
  }

  async steer(request: AgentSteerRequestV4): Promise<AgentSteerResult> {
    // Rejects command syntax because Pi expands slash-prefixed steering before enqueue.
    if (request.input.trimStart().startsWith('/')) {
      return rejectedPiSteer(
        'invalid-input',
        'Pi interprets leading-/ steering text as a command; rephrase without the slash',
      );
    }
    const captured = request.target ? this.#steerTargets.get(request.target) : undefined;
    if (!captured) return rejectedPiSteer('no-active-turn', 'No active Pi turn');
    this.#steerTargets.delete(request.target!);

    let rejection = this.#validateSteerTarget(request, captured);
    if (rejection) return rejection;

    captured.session.deliveryReservations += 1;
    try {
      await request.prepareDelivery();
      rejection = this.#validateSteerTarget(request, captured);
      if (rejection) return rejection;

      const submission: PiSteerSubmission = {
        input: request.input,
        accepted: false,
        delivered: false,
        persisted: false,
      };
      captured.turn.steerSubmissions.add(submission);
      try {
        await captured.session.client!.send(
          { type: 'steer', message: request.input },
          STEER_RESPONSE_TIMEOUT_MS,
        );
      } catch (error) {
        if (error instanceof PiRpcCommandError) {
          captured.turn.steerSubmissions.delete(submission);
          return classifyPiSteerRejection(error);
        }
        if (error instanceof PiRpcTransportError) {
          if (error.writeAttempted) {
            this.#retireInBackground(captured.session, 'steering delivery became uncertain', {
              turnOutcome: 'failed',
              failureMessage: error.message,
            });
          } else {
            captured.turn.steerSubmissions.delete(submission);
          }
          return {
            kind: 'failed',
            outcome: error.writeAttempted ? 'unknown' : 'not-sent',
            message: error.message,
          };
        }
        throw error;
      }

      submission.accepted = true;
      rejection = this.#validateSteerTarget(request, captured);
      if (rejection) {
        if (submission.persisted && captured.turn.settleObserved) {
          return { kind: 'accepted' };
        }
        captured.turn.steerSubmissions.delete(submission);
        this.#retireInBackground(captured.session, 'steer missed the run', {
          turnOutcome: 'preserve',
        });
        return rejection;
      }
      this.#logger.debug('Pi steering accepted', {
        chatId: captured.session.chatId,
        turnId: captured.turn.turnId ?? null,
        sessionId: captured.session.id.slice(0, 8),
      });
      return { kind: 'accepted' };
    } finally {
      captured.session.deliveryReservations -= 1;
      this.#flushPendingFinish(captured.session);
    }
  }

  startPurgeTimer(): void {
    this.#idlePurger.start();
  }

  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    this.#idlePurger.stop();
    const retirements = Array.from(this.#liveSessions).map((session) => {
      const turn = session.turn;
      if (turn) this.#completeTurn(session, turn, 'shutdown');
      return this.#retire(session, 'server shutdown');
    });
    const results = await Promise.allSettled(retirements);
    this.#sessions.clear();
    const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length > 0) {
      throw new AggregateError(failures, 'One or more Pi processes did not shut down cleanly');
    }
  }

  #assertAcceptingOperations(): void {
    if (this.#shuttingDown) throw new DOMException('Pi runtime is shutting down', 'AbortError');
  }

  #validateSteerTarget(
    request: AgentSteerRequestV4,
    captured: CapturedPiSteerTarget,
  ): AgentSteerResult | null {
    const { session, turn } = captured;
    const current = this.#sessions.get(request.agentSessionId);
    if (this.#shuttingDown) {
      return rejectedPiSteer('no-active-turn', 'No active Pi turn');
    }
    if (
      !current
      || current !== session
      || session.chatId !== request.chatId
      || session.state !== 'active'
      || session.turn !== turn
      || session.generation !== captured.generation
      || turn.stopRequested
    ) {
      return rejectedPiSteer('turn-changed', 'The active Pi turn changed');
    }
    if (turn.settleObserved || session.pendingFinish !== null) {
      return rejectedPiSteer('turn-changed', 'The active Pi turn settled before steering');
    }
    return null;
  }

  #flushPendingFinish(session: PiRpcSession): void {
    if (session.deliveryReservations > 0 || !session.pendingFinish) return;
    const finish = session.pendingFinish;
    session.pendingFinish = null;
    finish();
  }

  async #resolveResumePath(request: PiResumeRequest): Promise<string> {
    // Prevents Pi from treating a missing path as a fresh session or a bare id as an
    // interactive confirmation request on the RPC channel.
    if (request.nativePath && !isArtificialNativePath(request.nativePath)) {
      const nativePath = await canonicalExistingPiSessionPath(request.nativePath);
      if (nativePath) return nativePath;
    }
    const { findPiSessionFileBySessionId } = await import('./pi-session-paths.js');
    const found = await findPiSessionFileBySessionId(
      request.agentSessionId,
      request.projectPath,
      this.#config,
    );
    if (found) {
      const nativePath = await canonicalExistingPiSessionPath(found);
      if (nativePath) return nativePath;
    }
    throw new AgentIntegrationError(
      'PROVIDER_FAILURE',
      `Pi session file for ${request.agentSessionId} could not be resolved`,
      false,
    );
  }

  async #spawnSession(
    request: PiStartRequest | PiResumeRequest,
    resume: { agentSessionId: string; nativePath: string } | null,
  ): Promise<PiRpcSession> {
    this.#assertAcceptingOperations();
    const model = requireExplicitPiModel(request.model);
    const thinking = mapThinkingMode(request.thinkingMode);
    const proc = Bun.spawn(buildPiRpcSpawnCommand({
      config: this.#config,
      model,
      thinking,
      permissionMode: request.permissionMode,
      projectPath: request.projectPath,
      resumePath: resume?.nativePath ?? null,
    }), {
      cwd: request.projectPath,
      env: buildPiCliEnv(request.envOverrides),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const now = Date.now();
    const session: PiRpcSession = {
      generation: 0,
      state: 'starting',
      id: resume?.agentSessionId ?? `pending-${crypto.randomUUID()}`,
      chatId: request.chatId,
      nativePath: resume?.nativePath ?? null,
      model,
      thinking,
      process: proc,
      client: null,
      turn: null,
      deliveryReservations: 0,
      pendingFinish: null,
      startTime: now,
      lastActivityAt: now,
      eventMetadata: piEventMetadata(request, resume ? undefined : 'chat-start'),
      exitPromise: null,
    };
    this.#liveSessions.add(session);

    const generation = session.generation;
    const client = new PiRpcClient(proc, {
      onEvent: (event) => {
        try {
          this.#routeEvent(session, generation, event);
        } catch (error) {
          this.#logger.warn('Pi RPC event handling failed', {
            sessionId: session.id,
            eventType: typeof event.type === 'string' ? event.type : 'unknown',
            error: errorMessage(error),
          });
        }
      },
      onMalformed: (line) => this.#logger.warn('Pi emitted malformed RPC JSON', {
        sessionId: session.id,
        line: line.slice(0, 120),
      }),
    });
    session.client = client;
    void pipePiStderr(this.#logger, session.id, proc);
    void client.exited
      .then((code) => this.#handleExit(session, generation, code))
      .catch((error) => {
        this.#logger.error('Pi process exit handling failed', {
          sessionId: session.id,
          error: errorMessage(error),
        });
      });

    try {
      await this.#completeHandshake(session, client, request, resume);
    } catch (error) {
      await this.#retireAndLog(session, 'readiness handshake failed');
      throw error instanceof AgentIntegrationError
        ? error
        : new AgentIntegrationError(
          'PROVIDER_FAILURE',
          error instanceof Error ? error.message : String(error),
          false,
        );
    }
    return session;
  }

  async #completeHandshake(
    session: PiRpcSession,
    client: PiRpcClient,
    request: PiStartRequest | PiResumeRequest,
    resume: { agentSessionId: string; nativePath: string } | null,
  ): Promise<void> {
    assertPiExecutionOpen(request);
    this.#assertAcceptingOperations();
    await client.send({ type: 'set_steering_mode', mode: 'all' }, READY_TIMEOUT_MS);
    assertPiExecutionOpen(request);
    this.#assertAcceptingOperations();
    const state = await client.send({ type: 'get_state' }, READY_TIMEOUT_MS);
    assertPiExecutionOpen(request);
    this.#assertAcceptingOperations();
    const data = state.data ?? {};
    const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
    const sessionFile = typeof data.sessionFile === 'string' ? data.sessionFile : '';
    if (!sessionId || !sessionFile) {
      throw new Error('Pi readiness handshake returned no session identity');
    }

    if (resume) {
      if (sessionId !== resume.agentSessionId) {
        throw new Error(
          `Pi resumed session ${sessionId} instead of ${resume.agentSessionId}`,
        );
      }
      const canonicalSessionFile = await canonicalExistingPiSessionPath(sessionFile);
      assertPiExecutionOpen(request);
      this.#assertAcceptingOperations();
      if (!canonicalSessionFile || canonicalSessionFile !== resume.nativePath) {
        throw new Error(
          `Pi resumed session file ${sessionFile} instead of ${resume.nativePath}`,
        );
      }
    } else {
      if (!path.isAbsolute(sessionFile)) {
        throw new Error(`Pi readiness handshake returned a relative session file: ${sessionFile}`);
      }
      session.id = sessionId;
      session.nativePath = path.normalize(sessionFile);
    }

    // --model is a pattern; verify what actually resolved.
    const model = data.model && typeof data.model === 'object'
      ? data.model as Record<string, unknown>
      : null;
    const resolvedModel = model
      && typeof model.provider === 'string'
      && typeof model.id === 'string'
      ? `${model.provider}/${model.id}`
      : '';
    if (resolvedModel !== session.model) {
      throw new Error(`Pi resolved model ${resolvedModel || 'unknown'} instead of ${session.model}`);
    }
    const expectedThinking = mapThinkingMode(request.thinkingMode);
    const effectiveThinking = expectedThinking && model
      ? resolvePiThinkingLevel(model, expectedThinking)
      : expectedThinking;
    if (effectiveThinking && data.thinkingLevel !== effectiveThinking) {
      throw new Error(
        `Pi thinking level is ${String(data.thinkingLevel)} instead of ${effectiveThinking}`,
      );
    }
    assertPiExecutionOpen(request);
    this.#assertAcceptingOperations();
    session.state = 'idle';
  }

  async #dispatchPrompt(
    session: PiRpcSession,
    request: PiStartRequest | PiResumeRequest,
    prompt: PreparedPiRpcPrompt,
  ): Promise<PiPromptDispatch> {
    const client = session.client;
    if (!client) throw new Error('Pi session has no RPC client');
    let resolveSettle!: () => void;
    const settle = new Promise<void>((resolve) => {
      resolveSettle = resolve;
    });
    this.#turnSettlements.delete(session.chatId);
    const turn: PiActiveTurn = {
      turnId: request.turnId,
      stopRequested: false,
      settleObserved: false,
      completion: 'pending',
      failureMessage: null,
      steerSubmissions: new Set(),
      steeringQueue: [],
      settlementBaseline: await snapshotPiSettlementBaseline(session.nativePath),
      expectedNative: [],
      settle: resolveSettle,
    };
    if (typeof prompt.message === 'string' && prompt.message.length > 0) {
      addExpectedNativeMessage(turn.expectedNative, 'user');
    }
    assertPiExecutionOpen(request);
    if (request.executionAdmission) await markPiExecutionStarted(request);
    session.turn = turn;
    session.state = 'prompting';
    session.startTime = Date.now();
    session.lastActivityAt = session.startTime;
    this.#emitLifecycle(session, 'processing-started', () => {
      this.emitProcessing(session.chatId, true);
    });
    const response = client.sendUnbounded({
      type: 'prompt',
      message: prompt.message,
      ...(prompt.images.length > 0 ? { images: prompt.images } : {}),
    });
    request.onAbortable?.();
    return {
      accepted: this.#awaitPromptAcceptance(session, turn, response),
      settle,
    };
  }

  async #awaitPromptAcceptance(
    session: PiRpcSession,
    turn: PiActiveTurn,
    response: Promise<unknown>,
  ): Promise<void> {
    try {
      await response;
    } catch (error) {
      if (turn.completion === 'stopped') return;
      if (turn.completion === 'shutdown') {
        throw new DOMException('Pi turn stopped during shutdown', 'AbortError');
      }
      if (turn.completion === 'failed') {
        throw new AgentIntegrationError(
          'PROVIDER_FAILURE',
          turn.failureMessage ?? errorMessage(error),
          false,
        );
      }
      const message = errorMessage(error);
      this.#completeTurn(session, turn, 'failed', `Pi rejected the turn: ${message}`);
      this.#retireInBackground(session, 'prompt rejected');
      throw new AgentIntegrationError('PROVIDER_FAILURE', message, false);
    }
    if (turn.completion === 'pending') {
      session.state = 'active';
    }
  }

  #routeEvent(session: PiRpcSession, generation: number, event: Record<string, unknown>): void {
    if (session.generation !== generation || session.state === 'retiring') return;
    const timestamp = new Date().toISOString();
    const type = event.type;

    if (type === 'queue_update') {
      this.#observeSteeringQueue(session, event.steering);
      return;
    }

    if (type === 'extension_ui_request') {
      this.#logger.warn('Pi extension requested unsupported RPC UI', {
        sessionId: session.id,
        method: typeof event.method === 'string' ? event.method : 'unknown',
      });
      return;
    }

    if (type === 'message_end') {
      const message = event.message as unknown;
      const role = message && typeof message === 'object'
        ? (message as Record<string, unknown>).role
        : null;
      if (role === 'user') {
        this.#observeSteeringPersistence(session, message);
        return;
      }
      // Every finalized non-user message persists one session entry, whether
      // or not it renders: tool-only assistant and toolResult occurrences
      // count by role, never by content. The occurrence index doubles as the
      // durable integration identity for the rendered rows, so a repeated
      // notification cannot mint a second identity for the same occurrence.
      const occurrenceOrdinal = session.turn?.expectedNative.length ?? null;
      if (session.turn && typeof role === 'string') {
        addExpectedNativeMessage(session.turn.expectedNative, role);
      }
      // Rendering the full occurrence here, tools included, keeps live rows
      // identical to the evidence conversion of the same session entry, so
      // the audit matches by identity without per-event reassembly.
      const messages = convertPiMessage(message, { includeUser: false });
      if (occurrenceOrdinal !== null && session.turn?.turnId) {
        messages.forEach((rendered, withinSourceOrdinal) => {
          attachNativeMessageSource(rendered, {
            entryId: `turn:${session.turn!.turnId}:end:${occurrenceOrdinal}`,
            withinSourceOrdinal,
          });
        });
      }
      if (messages.length > 0) this.emitMessages(session.chatId, messages, session.eventMetadata);

      const stopReason = message && typeof message === 'object'
        ? (message as Record<string, unknown>).stopReason
        : null;
      if (stopReason === 'error') {
        const errorMessage = message && typeof message === 'object'
          ? (message as Record<string, unknown>).errorMessage
          : null;
        this.emitMessages(session.chatId, [
          new ErrorMessage(timestamp, typeof errorMessage === 'string' ? errorMessage : 'Pi turn failed.'),
        ], session.eventMetadata);
      }
      return;
    }

    if (type === 'agent_settled') {
      this.#handleSettle(session);
      return;
    }

    // Ignores per-run and streaming events that do not change Garcon's rendered contract.
  }

  #observeSteeringQueue(session: PiRpcSession, value: unknown): void {
    const turn = session.turn;
    if (!turn || !Array.isArray(value) || !value.every((item) => typeof item === 'string')) return;
    const next = value as string[];
    const remaining = occurrenceCounts(next);
    for (const input of turn.steeringQueue) {
      const count = remaining.get(input) ?? 0;
      if (count > 0) {
        remaining.set(input, count - 1);
        continue;
      }
      const delivered = Array.from(turn.steerSubmissions).find(
        (submission) => !submission.delivered && submission.input === input,
      );
      if (delivered) delivered.delivered = true;
    }
    turn.steeringQueue = [...next];
  }

  #observeSteeringPersistence(session: PiRpcSession, value: unknown): void {
    const turn = session.turn;
    const input = piUserMessageText(value);
    if (!turn || input === null) return;
    const persisted = Array.from(turn.steerSubmissions).find(
      (submission) => submission.delivered && !submission.persisted && submission.input === input,
    );
    if (persisted) {
      persisted.persisted = true;
      addExpectedNativeMessage(turn.expectedNative, 'user');
    }
  }

  #handleSettle(session: PiRpcSession): void {
    const turn = session.turn;
    if (!turn) return;
    turn.settleObserved = true;
    session.lastActivityAt = Date.now();
    if (session.deliveryReservations > 0) {
      session.pendingFinish = () => this.#finishSettle(session);
      return;
    }
    this.#finishSettle(session);
  }

  #finishSettle(session: PiRpcSession): void {
    const turn = session.turn;
    if (!turn) return;
    const steeringUnresolved = this.#recordSettlement(session, turn);
    this.#completeTurn(session, turn, 'finished');
    if (steeringUnresolved) {
      this.#retireInBackground(session, 'steering remained uncertain at settle');
    }
  }

  // Captures the turn's persistence proof: the ordered occurrences finalized
  // so far, the pre-prompt baseline, and whether accepted steering ever left
  // an unpersisted or queued remainder. A stopped turn records the same
  // proof so its persisted prefix is provable at the settled boundary.
  #recordSettlement(session: PiRpcSession, turn: PiActiveTurn): boolean {
    const hasUnpersistedSteer = Array.from(turn.steerSubmissions).some(
      (submission) => submission.accepted && !submission.persisted,
    );
    const hasQueuedSteering = turn.steeringQueue.length > 0;
    this.#turnSettlements.set(session.chatId, {
      steeringUnresolved: hasUnpersistedSteer || hasQueuedSteering,
      baseline: turn.settlementBaseline,
      expected: [...turn.expectedNative],
      nativePath: session.nativePath,
      turnId: turn.turnId ?? null,
    });
    return hasUnpersistedSteer || hasQueuedSteering;
  }

  // Verifies the last finished turn's native persistence evidence with a
  // bounded wait: Pi appends the session entry after message_end, so the
  // proof polls briefly for occurrence-safe persistence instead of failing a
  // write that is still flushing. Unresolved steering never resolves by
  // waiting, and failure withholds terminal success.
  async verifyTurnSettlement(chatId: string): Promise<PiTurnSettlementProof> {
    const record = this.#turnSettlements.get(chatId);
    if (!record || record.steeringUnresolved) return verifyPiTurnSettlement(record);
    const deadline = Date.now() + this.#settlementWaitMs;
    for (;;) {
      const proof = await verifyPiTurnSettlement(record);
      if (proof.verdict === 'confirmed' || Date.now() >= deadline) return proof;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  #handleExit(session: PiRpcSession, generation: number, code: number): void {
    if (session.generation !== generation) return;
    const turn = session.turn;
    session.process = null;
    session.client = null;
    session.state = 'retiring';
    session.lastActivityAt = Date.now();
    this.#liveSessions.delete(session);
    if (this.#sessions.get(session.id) === session) this.#sessions.delete(session.id);
    if (turn && turn.completion === 'pending') {
      this.#completeTurn(
        session,
        turn,
        'failed',
        `Pi process exited before completion (code ${code})`,
      );
    }
  }

  #completeTurn(
    session: PiRpcSession,
    turn: PiActiveTurn,
    outcome: Exclude<PiActiveTurn['completion'], 'pending'>,
    failureMessage?: string,
  ): void {
    if (turn.completion !== 'pending') return;
    turn.completion = outcome;
    turn.failureMessage = failureMessage ?? null;
    if (session.turn === turn) session.turn = null;
    session.pendingFinish = null;
    session.lastActivityAt = Date.now();
    this.#emitLifecycle(session, 'processing-finished', () => {
      this.emitProcessing(session.chatId, false);
    });
    if (outcome === 'finished') {
      this.#emitLifecycle(session, 'turn-finished', () => {
        this.emitFinished(session.chatId, 0, session.eventMetadata);
      });
    } else if (outcome === 'stopped') {
      // A stop is turn-terminal work like any other: the terminal event is
      // what releases the projection operation and drives the stop-settled
      // sequence, with success still gated on the recorded persistence proof.
      this.#recordSettlement(session, turn);
      this.#emitLifecycle(session, 'turn-stopped', () => {
        this.emitFinished(session.chatId, 0, session.eventMetadata);
      });
    } else if (outcome === 'failed') {
      this.#emitLifecycle(session, 'turn-failed', () => {
        this.emitFailed(
          session.chatId,
          failureMessage ?? 'Pi turn failed before completion',
          session.eventMetadata,
        );
      });
    }
    turn.settle();
    if (session.state !== 'retiring' && session.process && session.client) {
      session.state = 'idle';
    }
  }

  #emitLifecycle(session: PiRpcSession, event: string, emit: () => void): void {
    try {
      emit();
    } catch (error) {
      try {
        this.#logger.error('Pi lifecycle event handling failed', {
          sessionId: session.id,
          event,
          error: errorMessage(error),
        });
      } catch {
        // Lifecycle completion must not depend on a logger implementation.
      }
    }
  }

  #retire(
    session: PiRpcSession,
    reason: string,
    options: PiRetireOptions = {},
  ): Promise<void> {
    if (session.state === 'retiring' && session.exitPromise) return session.exitPromise;
    session.state = 'retiring';
    session.generation += 1;
    const turn = session.turn;
    if (turn && options.turnOutcome && options.turnOutcome !== 'preserve') {
      this.#completeTurn(
        session,
        turn,
        options.turnOutcome,
        options.failureMessage,
      );
    }
    const client = session.client;
    const proc = session.process;
    client?.dispose(reason);
    const exitPromise = (async () => {
      if (proc) {
        await terminatePiProcess(proc);
      }
      if (session.process === proc) {
        session.process = null;
        session.client = null;
      }
      this.#liveSessions.delete(session);
      if (this.#sessions.get(session.id) === session) this.#sessions.delete(session.id);
    })();
    session.exitPromise = exitPromise;
    this.#logger.debug('Pi session retired', {
      sessionId: session.id.slice(0, 8),
      reason,
    });
    return exitPromise;
  }

  async #retireAndLog(
    session: PiRpcSession,
    reason: string,
    options?: PiRetireOptions,
  ): Promise<void> {
    try {
      await this.#retire(session, reason, options);
    } catch (error) {
      this.#logger.error('Pi session retirement failed', {
        sessionId: session.id.slice(0, 8),
        reason,
        error: errorMessage(error),
      });
    }
  }

  #retireInBackground(
    session: PiRpcSession,
    reason: string,
    options?: PiRetireOptions,
  ): void {
    void this.#retire(session, reason, options).catch((error) => {
      this.#logger.error('Pi session retirement failed', {
        sessionId: session.id.slice(0, 8),
        reason,
        error: errorMessage(error),
      });
    });
  }

}
