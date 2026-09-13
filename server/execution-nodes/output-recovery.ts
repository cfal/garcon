import type { NodeReplayReply } from '@garcon/server-agent-interface';
import { parseNodeSessionIdentity, sameNodeSession, type NodeSessionIdentity } from '../../common/node-operation.js';
import { NODE_RECOVERY_TIMEOUT_MS } from '../execution-node/supervisor.js';
import { NodeWorkerTransportError } from '../execution-node/worker/framing.js';
import type { NodeOutputReplayCursor } from '../execution-node/worker/output-delivery.js';
import type { NodeOutputReceiverAttempt, NodeWorkerOutputDeliveryReceiver } from '../execution-node/worker/output-delivery-receiver.js';
import type { NodeWorkerServiceClient } from '../execution-node/worker/service-channel.js';
import { MAX_NODE_WORKER_REPLAY_CURSORS, parseNodeWorkerOutputSuspensionText } from '../execution-node/worker/service-protocol.js';

export interface NodeOutputRecoveryOptions {
  readonly session: NodeSessionIdentity;
  readonly connectionId: number;
  readonly signal: AbortSignal;
  readonly service: Pick<NodeWorkerServiceClient, 'call'>;
  readonly receiver: Pick<NodeWorkerOutputDeliveryReceiver, 'begin' | 'suspend' | 'receiveSuspension' | 'waitForAccepted'>;
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => { cancel(): void };
  cursors(): readonly NodeOutputReplayCursor[];
  retireGap(range: Extract<NodeReplayReply, { type: 'node-replay-gap' }>): void;
  /** Reconciles exact operation/permission receipts and drains pending retirement controls. */
  reconcile(signal: AbortSignal): Promise<void>;
  validate(): void;
  recovering(): void;
  recovered(): void;
  failed(error: unknown): void;
}

interface RecoveryGeneration {
  readonly attempt: NodeOutputReceiverAttempt;
  readonly cancellation: AbortController;
}

/** Owns one physical connection's output barrier while publication routes outlive reconnects. */
export class NodeOutputRecovery {
  readonly #closing = new AbortController();
  readonly #detach: () => void;
  #running: Promise<void> | null = null;
  #rejectRecovery: ((error: unknown) => void) | null = null;
  #generation: RecoveryGeneration | null = null;
  #beginning = false;
  #earlySuspension: number | null = null;
  #lastGeneration = 0;

  constructor(private readonly options: NodeOutputRecoveryOptions) {
    const session = parseNodeSessionIdentity(options.session);
    if (!session || !Number.isSafeInteger(options.connectionId) || options.connectionId < 1) throw protocol();
    this.options = Object.freeze({ ...options, session: Object.freeze(session) });
    const close = () => this.close();
    this.#detach = () => options.signal.removeEventListener('abort', close);
    options.signal.addEventListener('abort', close, { once: true });
    if (options.signal.aborted) this.close();
  }

  get attempt(): NodeOutputReceiverAttempt | null {
    return this.#generation?.attempt ?? null;
  }

  recover(): Promise<void> {
    if (this.#running) return this.#running;
    const result = Promise.withResolvers<void>();
    this.#running = result.promise;
    this.#rejectRecovery = result.reject;
    // The owner may observe failure through its callback before awaiting startup/recovery.
    void result.promise.catch(() => {});
    try {
      this.#validate();
      this.options.recovering();
      this.#validate();
    } catch (error) {
      this.#running = null;
      this.#rejectRecovery = null;
      this.#fail(error);
      result.reject(error);
      return result.promise;
    }
    void this.#recover(() => {
      this.#running = null;
      this.#rejectRecovery = null;
      this.options.recovered();
      result.resolve();
    }).catch((error) => {
      if (this.#running === result.promise) { this.#running = null; this.#rejectRecovery = null; }
      this.#fail(error);
      result.reject(error);
    });
    return result.promise;
  }

  receiveSuspension(text: string): void {
    if (this.#closing.signal.aborted) return;
    this.#validate();
    const frame = parseNodeWorkerOutputSuspensionText(text);
    if (!frame || !sameNodeSession(frame.session, this.options.session)) throw protocol();
    if (frame.connectionId < this.options.connectionId) return;
    if (frame.connectionId !== this.options.connectionId) throw protocol();
    if (this.#beginning && frame.generation > this.#lastGeneration) {
      // The control lane can deliver suspension before the data-lane reply names its generation.
      this.#earlySuspension = Math.max(this.#earlySuspension ?? 0, frame.generation);
      return;
    }
    const generation = this.#generation;
    if (!generation || frame.generation !== generation.attempt.generation) return;
    if (!this.options.receiver.receiveSuspension(text)) return;
    generation.cancellation.abort(protocol());
    void this.recover();
  }

  close(): void { this.#close(new NodeWorkerTransportError('NODE_WORKER_CLOSED')); }

  #close(error: unknown): void {
    if (this.#closing.signal.aborted) return;
    this.#closing.abort(error);
    this.#rejectRecovery?.(error);
    this.#rejectRecovery = null;
    this.#running = null;
    this.#detach();
    this.#suspend();
    this.#earlySuspension = null;
  }

  async #recover(complete: () => void): Promise<void> {
    const deadline = new AbortController();
    const timeout = (this.options.scheduleTimeout ?? scheduleTimeout)(() => {
      const error = new NodeWorkerTransportError('NODE_WORKER_TIMEOUT');
      deadline.abort(error);
      this.#fail(error);
    }, NODE_RECOVERY_TIMEOUT_MS);
    const cancelTimeout = () => timeout.cancel();
    this.#closing.signal.addEventListener('abort', cancelTimeout, { once: true });
    const signal = AbortSignal.any([this.#closing.signal, deadline.signal]);
    try {
      while (true) {
        this.#validate(); signal.throwIfAborted();
        this.#suspend();
        this.#beginning = true;
        let begin;
        try { begin = await this.options.service.call({ method: 'begin-output-recovery' }, signal); }
        finally { this.#beginning = false; }
        this.#validate(); signal.throwIfAborted();
        if (begin.kind !== 'output-recovery' || begin.generation <= this.#lastGeneration) throw protocol();
        this.#lastGeneration = begin.generation;
        if (this.#earlySuspension !== null) {
          const suspended = this.#earlySuspension;
          this.#earlySuspension = null;
          if (suspended > begin.generation) throw protocol();
          if (suspended === begin.generation) continue;
        }
        const cancellation = new AbortController();
        const attemptSignal = AbortSignal.any([signal, cancellation.signal]);
        const generation: RecoveryGeneration = {
          cancellation,
          attempt: this.options.receiver.begin(this.options.connectionId, begin.generation, this.options.cursors(), attemptSignal),
        };
        this.#generation = generation;
        try {
          while (true) {
            this.#validate(); attemptSignal.throwIfAborted();
            const cursors = this.options.cursors();
            for (let offset = 0; offset < cursors.length; offset += MAX_NODE_WORKER_REPLAY_CURSORS) {
              const result = await this.options.service.call({ method: 'replay-output', generation: begin.generation,
                cursors: cursors.slice(offset, offset + MAX_NODE_WORKER_REPLAY_CURSORS) }, attemptSignal);
              this.#validate(); attemptSignal.throwIfAborted();
              if (result.kind !== 'output-replayed') throw protocol();
              for (const range of result.ranges) if (range.type === 'node-replay-gap') this.options.retireGap(range);
              await this.options.receiver.waitForAccepted(generation.attempt,
                result.ranges.filter((range) => range.type === 'node-replay-ready'), attemptSignal);
              this.#validate(); attemptSignal.throwIfAborted();
            }
            await this.options.reconcile(attemptSignal);
            this.#validate(); attemptSignal.throwIfAborted();
            const resumed = await this.options.service.call({ method: 'resume-output', generation: begin.generation }, attemptSignal);
            this.#validate(); attemptSignal.throwIfAborted();
            if (resumed.kind !== 'output-live') throw protocol();
            if (!resumed.live) continue;
            complete();
            return;
          }
        } catch (error) {
          if (!cancellation.signal.aborted || signal.aborted) throw error;
        }
      }
    } finally {
      this.#closing.signal.removeEventListener('abort', cancelTimeout);
      timeout.cancel();
    }
  }

  #suspend(): void {
    const generation = this.#generation;
    this.#generation = null;
    if (!generation) return;
    this.options.receiver.suspend(generation.attempt);
    generation.cancellation.abort(protocol());
  }

  #validate(): void {
    this.#closing.signal.throwIfAborted();
    this.options.validate();
    this.#closing.signal.throwIfAborted();
  }

  #fail(error: unknown): void {
    if (this.#closing.signal.aborted) return;
    this.#close(error);
    try { this.options.failed(error); } catch { /* The failed connection cannot release its recovery gate. */ }
  }
}

function protocol(): NodeWorkerTransportError { return new NodeWorkerTransportError('NODE_WORKER_PROTOCOL'); }
function scheduleTimeout(callback: () => void, delayMs: number): { cancel(): void } {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return { cancel: () => clearTimeout(timer) };
}
