import crypto from 'node:crypto';
import type {
  AgentLogger,
  AgentSteerRequest,
  AgentSteerResult,
  AgentSteerTarget,
} from '@garcon/server-agent-interface';
import type { AgentRuntimeOperation } from '@garcon/server-agent-common/execution/runtime-events';
import type { ClaudeProcessTransport } from './cli-process-transport.js';
import type { ClaudeCLIMessage, ClaudeTurnState } from './cli-protocol.js';
import {
  buildClaudeSteeringUserContent,
  buildClaudeUserInputFrame,
} from './user-input.js';

export const CLAUDE_STEER_WRITE_TIMEOUT_MS = 15_000;
export const CLAUDE_STEER_IDLE_FENCE_TIMEOUT_MS = 15_000;

export type ClaudeSteeringInputObservation =
  | { readonly kind: 'queued'; readonly uuid: string }
  | {
      readonly kind: 'started';
      readonly uuid: string;
      readonly source: 'lifecycle' | 'replay';
      readonly waitMs: number;
    }
  | { readonly kind: 'duplicate-replay'; readonly uuid: string }
  | {
      readonly kind: 'terminal';
      readonly uuid: string;
      readonly phase: 'before-start' | 'after-start';
      readonly state: 'completed' | 'cancelled' | 'discarded';
    };

type ClaudeSteeringInputPhase = 'submitted' | 'queued' | 'active';

interface ClaudeSteeringNativeInput {
  readonly submittedAt: number;
  readonly phase: ClaudeSteeringInputPhase;
}

export class ClaudeTurnSteeringState {
  #deliveryReservations = new Set<symbol>();
  #inputs = new Map<string, ClaudeSteeringNativeInput>();
  #idleDeferred = false;
  #idleTimer: ReturnType<typeof setTimeout> | null = null;
  #settlementFailure: string | null = null;

  reserveDelivery(): () => void {
    const reservation = Symbol('claude-steering-delivery');
    this.#deliveryReservations.add(reservation);
    return () => {
      this.#deliveryReservations.delete(reservation);
    };
  }

  markSubmitted(uuid: string): void {
    this.#inputs.set(uuid, { submittedAt: Date.now(), phase: 'submitted' });
  }

  removeSubmitted(uuid: string): void {
    this.#dropNativeInput(uuid);
  }

  observe(message: ClaudeCLIMessage): ClaudeSteeringInputObservation | null {
    const uuid = message.type === 'command_lifecycle'
      ? message.command_uuid
      : message.type === 'user' && message.isReplay === true
        ? message.uuid
        : undefined;
    if (!uuid) return null;
    const input = this.#inputs.get(uuid);

    if (
      message.type === 'command_lifecycle'
      && message.state === 'queued'
      && input?.phase === 'submitted'
    ) {
      this.#inputs.set(uuid, { ...input, phase: 'queued' });
      return { kind: 'queued', uuid };
    }

    if (message.type === 'command_lifecycle' && message.state === 'started') {
      if (!input || input.phase === 'active') return null;
      const waitMs = Date.now() - input.submittedAt;
      this.#inputs.set(uuid, { ...input, phase: 'active' });
      return { kind: 'started', uuid, source: 'lifecycle', waitMs };
    }

    if (message.type === 'user' && message.isReplay === true) {
      if (!input || input.phase === 'active') return null;
      if (input.phase !== 'queued') {
        this.#dropNativeInput(uuid);
        return { kind: 'duplicate-replay', uuid };
      }
      const waitMs = Date.now() - input.submittedAt;
      this.#inputs.set(uuid, { ...input, phase: 'active' });
      return { kind: 'started', uuid, source: 'replay', waitMs };
    }

    if (
      message.type === 'command_lifecycle'
      && (
        message.state === 'completed'
        || message.state === 'cancelled'
        || message.state === 'discarded'
      )
    ) {
      if (!input) return null;
      const phase = input.phase === 'active' ? 'after-start' : 'before-start';
      this.#dropNativeInput(uuid);
      return { kind: 'terminal', uuid, phase, state: message.state };
    }
    return null;
  }

  get blocksIdleSettlement(): boolean {
    return this.#deliveryReservations.size > 0 || this.#inputs.size > 0;
  }

  get hasDeferredIdle(): boolean {
    return this.#idleDeferred;
  }

  get submittedCount(): number {
    let count = 0;
    for (const input of this.#inputs.values()) {
      if (input.phase !== 'active') count += 1;
    }
    return count;
  }

  get activeCount(): number {
    let count = 0;
    for (const input of this.#inputs.values()) {
      if (input.phase === 'active') count += 1;
    }
    return count;
  }

  get reservationCount(): number {
    return this.#deliveryReservations.size;
  }

  rememberProviderIdle(): void {
    this.#idleDeferred = true;
  }

  deferIdle(onTimeout: () => void, timeoutMs: number): void {
    this.#idleDeferred = true;
    if (!this.#hasNativeInputWork || this.#idleTimer) return;
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null;
      if (!this.#idleDeferred || !this.#hasNativeInputWork) return;
      onTimeout();
    }, timeoutMs);
  }

  clearDeferredIdle(): void {
    this.#idleDeferred = false;
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }

  recordProtocolFailure(message: string): void {
    this.#settlementFailure = message;
  }

  get settlementFailureMessage(): string | null {
    return this.#settlementFailure;
  }

  observeInterruptReceipt(input: {
    readonly cancelled: readonly string[];
    readonly stillQueued: readonly string[];
  }): { readonly cancelledCount: number; readonly stillQueuedCount: number } {
    const cancelled = new Set(input.cancelled);
    const stillQueued = new Set(input.stillQueued);
    let cancelledCount = 0;
    let stillQueuedCount = 0;
    for (const uuid of this.#inputs.keys()) {
      if (stillQueued.has(uuid)) {
        stillQueuedCount += 1;
      } else if (cancelled.has(uuid)) {
        this.#dropNativeInput(uuid);
        cancelledCount += 1;
      }
    }
    return { cancelledCount, stillQueuedCount };
  }

  clear(): void {
    this.clearDeferredIdle();
    this.#inputs.clear();
    this.#deliveryReservations.clear();
  }

  #dropNativeInput(uuid: string): void {
    this.#inputs.delete(uuid);
    if (!this.#hasNativeInputWork && this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
  }

  get #hasNativeInputWork(): boolean {
    return this.#inputs.size > 0;
  }
}

export interface ClaudeSteerableTurn {
  readonly protocol: Pick<ClaudeTurnState, 'inputStarted' | 'abortRequested'>;
  readonly steering: ClaudeTurnSteeringState;
  readonly operation: Pick<AgentRuntimeOperation, 'runId'>;
}

export interface ClaudeSteerableSession {
  readonly id: string;
  readonly chatId: string;
  readonly activeTurn: ClaudeSteerableTurn | null;
  readonly process: ReturnType<typeof Bun.spawn> | null;
  readonly transport: ClaudeProcessTransport<ClaudeCLIMessage> | null;
}

interface CapturedClaudeSteerTarget {
  readonly session: ClaudeSteerableSession;
  readonly activeTurn: ClaudeSteerableTurn;
  readonly process: ReturnType<typeof Bun.spawn>;
  readonly transport: ClaudeProcessTransport<ClaudeCLIMessage>;
}

export interface ClaudeSteeringControllerOptions {
  readonly session: (agentSessionId: string) => ClaudeSteerableSession | null;
  readonly isShuttingDown: () => boolean;
  readonly logger: AgentLogger;
  readonly writeTimeoutMs: number;
  readonly flushDeferredIdle: (
    session: ClaudeSteerableSession,
    activeTurn: ClaudeSteerableTurn,
  ) => void;
}

export class ClaudeSteeringController {
  readonly #targets = new WeakMap<AgentSteerTarget, CapturedClaudeSteerTarget>();
  readonly #options: ClaudeSteeringControllerOptions;

  constructor(options: ClaudeSteeringControllerOptions) {
    this.#options = options;
  }

  captureTarget(agentSessionId: string): AgentSteerTarget | null {
    if (this.#options.isShuttingDown()) return null;
    const session = this.#options.session(agentSessionId);
    const activeTurn = session?.activeTurn;
    if (
      !session
      || !activeTurn
      || !activeTurn.protocol.inputStarted
      || activeTurn.protocol.abortRequested
      || !session.process
      || !session.transport
    ) return null;

    const target = Object.freeze({});
    this.#targets.set(target, {
      session,
      activeTurn,
      process: session.process,
      transport: session.transport,
    });
    return target;
  }

  async steer(request: AgentSteerRequest): Promise<AgentSteerResult> {
    const captured = request.target ? this.#targets.get(request.target) : undefined;
    if (!captured) return rejectedClaudeSteer('no-active-turn', 'No active Claude turn');
    this.#targets.delete(request.target!);

    const initialRejection = this.#validateTarget(request, captured);
    if (initialRejection) return initialRejection;

    const release = captured.activeTurn.steering.reserveDelivery();
    try {
      const nativeInputId = crypto.randomUUID();
      const frame = buildClaudeUserInputFrame({
        content: buildClaudeSteeringUserContent(request.input),
        sessionId: captured.session.id,
        uuid: nativeInputId,
        priority: 'next',
      });

      await request.prepareDelivery();
      const commitRejection = this.#validateTarget(request, captured);
      if (commitRejection) return commitRejection;

      let attempted = false;
      const writeStartedAt = Date.now();
      try {
        await captured.transport.writeLine(frame, {
          beforeWrite: () => {
            attempted = true;
            captured.activeTurn.steering.markSubmitted(nativeInputId);
          },
          attemptTimeoutMs: this.#options.writeTimeoutMs,
          killProcessAfterAttemptFailure: true,
        });
      } catch {
        captured.activeTurn.steering.removeSubmitted(nativeInputId);
        return {
          kind: 'failed',
          outcome: attempted ? 'unknown' : 'not-sent',
          message: attempted
            ? 'Claude steering delivery could not be confirmed'
            : 'Claude steering input was not sent',
        };
      }
      this.#options.logger.debug('Claude steering input accepted for native delivery', {
        chatId: captured.session.chatId,
        runId: captured.activeTurn.operation.runId,
        sessionId: captured.session.id.slice(0, 8),
        inputId: nativeInputId.slice(0, 8),
        writeMs: Date.now() - writeStartedAt,
        submittedSteers: captured.activeTurn.steering.submittedCount,
      });
      return { kind: 'accepted' };
    } finally {
      release();
      this.#options.flushDeferredIdle(captured.session, captured.activeTurn);
    }
  }

  handleObservation(
    session: ClaudeSteerableSession,
    activeTurn: ClaudeSteerableTurn,
    observation: ClaudeSteeringInputObservation,
  ): void {
    if (session.activeTurn !== activeTurn) return;
    if (observation.kind === 'queued') return;
    if (observation.kind === 'started') {
      this.#options.logger.debug('Claude steering input started', {
        chatId: session.chatId,
        runId: activeTurn.operation.runId,
        sessionId: session.id.slice(0, 8),
        inputId: observation.uuid.slice(0, 8),
        source: observation.source,
        submitToStartMs: observation.waitMs,
        remainingSubmitted: activeTurn.steering.submittedCount,
      });
      return;
    }

    if (observation.kind === 'duplicate-replay') {
      activeTurn.steering.recordProtocolFailure(
        'Claude CLI replayed steering input without accepting it into the command queue.',
      );
      this.#options.flushDeferredIdle(session, activeTurn);
      return;
    }

    if (observation.phase === 'after-start' && observation.state === 'completed') {
      this.#options.flushDeferredIdle(session, activeTurn);
      return;
    }
    if (!activeTurn.protocol.abortRequested) {
      activeTurn.steering.recordProtocolFailure(
        observation.phase === 'before-start'
          ? `Claude CLI ${observation.state} accepted steering input before it started.`
          : `Claude CLI ${observation.state} steering input before it completed.`,
      );
    }
    this.#options.logger.warn('Claude steering input ended without normal completion', {
      chatId: session.chatId,
      runId: activeTurn.operation.runId,
      sessionId: session.id.slice(0, 8),
      inputId: observation.uuid.slice(0, 8),
      phase: observation.phase,
      state: observation.state,
      abortRequested: activeTurn.protocol.abortRequested,
    });
    this.#options.flushDeferredIdle(session, activeTurn);
  }

  #validateTarget(
    request: AgentSteerRequest,
    captured: CapturedClaudeSteerTarget,
  ): AgentSteerResult | null {
    const current = this.#options.session(request.agentSessionId);
    if (!current || !current.activeTurn || this.#options.isShuttingDown()) {
      return rejectedClaudeSteer('no-active-turn', 'No active Claude turn');
    }
    if (
      current !== captured.session
      || current.chatId !== request.chatId
      || current.activeTurn !== captured.activeTurn
      || current.process !== captured.process
      || current.transport !== captured.transport
      || !captured.activeTurn.protocol.inputStarted
      || captured.activeTurn.protocol.abortRequested
    ) {
      return rejectedClaudeSteer('turn-changed', 'The active Claude turn changed');
    }
    return null;
  }
}

function rejectedClaudeSteer(
  reason: Extract<AgentSteerResult, { kind: 'rejected' }>['reason'],
  message: string,
): AgentSteerResult {
  return { kind: 'rejected', reason, message };
}
