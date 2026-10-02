import { AgentCallError } from '@garcon/server-agent-interface';
import { BULK_ACQUIRE_TIMEOUT_MS, BULK_SETUP_TIMEOUT_MS } from './limits.js';
import type { BulkConnectionControl } from './rpc-lane.js';
import { DEFAULT_RPC_TIMEOUT_MS, type ExecutorRpc } from './rpc.js';
import type { SessionTransport } from './session-transport.js';
import { REDIAL_DELAYS_MS, type WebSocketLink } from './websocket-link.js';
import { failureReason } from './failure-reason.js';
import type { MessageQueueSnapshot } from './message-queue-budget.js';

export type BulkPhase = 'offline' | 'preparing' | 'connecting' | 'reconciling' | 'activating' | 'ready' | 'reconnecting';

export interface BulkConnectionStatus {
  readonly phase: BulkPhase;
  readonly sessionId: string | null;
  readonly error: Error | null;
  readonly retries: number;
}

interface Attempt {
  readonly id: string;
  rpc: ExecutorRpc | null;
  phase: BulkPhase;
  timer: ReturnType<typeof setTimeout> | null;
  readyAt: number | null;
  dialed: boolean;
}

interface PendingControl {
  readonly frame: BulkConnectionControl;
  readonly sent?: () => void;
}

export interface BulkConnectionOptions {
  install(transport: SessionTransport): ExecutorRpc;
  changed(status: BulkConnectionStatus): void;
  failed?(failure: BulkAttemptFailure): void;
  readonly setupTimeoutMs?: number;
  readonly redialDelaysMs?: readonly number[];
  readonly stableSessionMs?: number;
}

export interface BulkAttemptFailure {
  readonly lane: 'bulk';
  readonly primarySessionId: string;
  readonly sessionId: string;
  readonly phase: BulkPhase;
  readonly reason: string;
  readonly retries: number;
  readonly setupTimeoutMs: number;
  readonly queues: MessageQueueSnapshot | null;
}

// One retry owner per primary generation, regardless of which peer dials.
export class BulkConnection {
  readonly #off: (() => void)[] = [];
  readonly #outbox: PendingControl[] = [];
  readonly #waiters = new Set<{ ready(rpc: ExecutorRpc): void; reject(error: Error): void }>();
  #attempt: Attempt | null = null;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #retries = 0;
  #error: Error | null = null;
  #flushing = false;
  #disposed = false;
  #started = false;

  constructor(
    private readonly link: WebSocketLink,
    private readonly primary: ExecutorRpc,
    private readonly options: BulkConnectionOptions,
  ) {
    primary.onBulkControl((frame) => this.#receive(frame));
    this.#off.push(
      primary.transport.channel.onCapacity(() => this.#flush()),
      primary.transport.onFailure(() => this.dispose()),
      link.onBulkSession((transport) => this.#install(transport)),
      link.onQuiesce(() => this.#quiesce()),
    );
  }

  get current(): ExecutorRpc | null {
    const attempt = this.#attempt;
    return !this.#disposed && attempt?.phase === 'ready' && attempt.rpc?.active ? attempt.rpc : null;
  }

  start(): void {
    if (this.#started || this.link.role !== 'controller' || !this.#live()) return;
    this.#started = true;
    this.#prepare();
  }

  wait(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ExecutorRpc> {
    if (options.signal?.aborted) return Promise.reject(new AgentCallError('not-dispatched', 'Bulk connection wait cancelled'));
    if (this.current) return Promise.resolve(this.current);
    if (!this.#live()) return Promise.reject(new AgentCallError('not-dispatched', 'Executor primary connection is unavailable'));
    const result = Promise.withResolvers<ExecutorRpc>();
    const finish = () => {
      this.#waiters.delete(waiter);
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
    };
    const waiter = {
      ready: (rpc: ExecutorRpc) => { finish(); result.resolve(rpc); },
      reject: (error: Error) => { finish(); result.reject(error); },
    };
    const cancel = () => waiter.reject(new AgentCallError('not-dispatched', 'Bulk connection wait cancelled'));
    const timeout = Math.min(BULK_ACQUIRE_TIMEOUT_MS, options.timeoutMs ?? BULK_ACQUIRE_TIMEOUT_MS);
    const timer = setTimeout(() => waiter.reject(new AgentCallError('not-dispatched', 'Executor bulk connection did not become ready in time')), Math.max(0, timeout));
    timer.unref?.();
    options.signal?.addEventListener('abort', cancel, { once: true });
    this.#waiters.add(waiter);
    return result.promise;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const off of this.#off) off();
    this.#quiesce();
    this.#clearAttempt();
    this.#publish('offline');
  }

  #quiesce(): void {
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = null;
    for (const waiter of [...this.#waiters]) waiter.reject(new AgentCallError('not-dispatched', 'Executor connection is shutting down'));
    // Keeps established endpoints available for the owner's shutdown cleanup.
    if (this.#attempt?.phase !== 'ready') this.#clearAttempt();
  }

  #live(): boolean {
    return !this.#disposed && !this.link.quiescing && this.link.current === this.primary.transport && this.primary.transport.connected;
  }

  #prepare(): void {
    if (!this.#live()) return;
    this.#clearAttempt();
    const attempt: Attempt = { id: crypto.randomUUID(), rpc: null, phase: 'preparing', timer: null, readyAt: null, dialed: false };
    this.#attempt = attempt;
    this.link.prepareBulk(this.primary.transport, attempt.id);
    this.#phase(attempt, 'preparing');
    this.#send({ type: 'bulk-prepare', sessionId: attempt.id });
  }

  #receive(frame: BulkConnectionControl): void {
    if (!this.#live()) return;
    const controllerFrame = ['bulk-prepare', 'bulk-connect', 'bulk-activate'].includes(frame.type);
    if (controllerFrame !== (this.link.role === 'worker')) {
      this.#fail(this.#attempt, new Error('Invalid bulk control direction'));
      return;
    }
    if (frame.type === 'bulk-prepare') {
      if (this.#attempt?.id === frame.sessionId) return;
      this.primary.activate();
      this.#clearAttempt();
      const attempt: Attempt = { id: frame.sessionId, rpc: null, phase: 'connecting', timer: null, readyAt: null, dialed: false };
      this.#attempt = attempt;
      this.link.prepareBulk(this.primary.transport, attempt.id);
      this.#phase(attempt, 'connecting');
      this.#send({ type: 'bulk-prepared', sessionId: attempt.id });
      return;
    }
    const attempt = this.#attempt;
    if (!attempt || attempt.id !== frame.sessionId) return;
    if (frame.type === 'bulk-lost') { this.#fail(attempt, new Error('Peer lost the bulk connection')); return; }
    if (frame.type === 'bulk-prepared' && attempt.phase === 'preparing') {
      this.#phase(attempt, 'connecting');
      if (this.link.isDialer) this.#dial(attempt);
      else this.#send({ type: 'bulk-connect', sessionId: attempt.id });
    } else if (frame.type === 'bulk-connect' && attempt.phase === 'connecting' && this.link.isDialer) {
      this.#dial(attempt);
    } else if (frame.type === 'bulk-activate' && attempt.phase === 'activating' && attempt.rpc?.reconciled) {
      attempt.rpc.activateIncoming();
      this.#send({ type: 'bulk-active', sessionId: attempt.id }, () => this.#activate(attempt));
    } else if (frame.type === 'bulk-active' && attempt.phase === 'activating') {
      this.#activate(attempt);
    }
  }

  #dial(attempt: Attempt): void {
    if (attempt.dialed) return;
    attempt.dialed = true;
    try { this.link.dialBulk(this.primary.transport, attempt.id); }
    catch (error) { this.#fail(attempt, error); }
  }

  #install(transport: SessionTransport): void {
    const attempt = this.#attempt;
    if (!this.#live() || !attempt || transport.id !== attempt.id || transport.primarySessionId !== this.primary.transport.id) return;
    if (attempt.rpc) { transport.close(new Error('Duplicate bulk endpoint')); return; }
    const rpc = this.options.install(transport);
    attempt.rpc = rpc;
    rpc.onReconciled(() => {
      if (this.link.role === 'worker' && this.#isCurrent(attempt)) this.#phase(attempt, 'activating');
    });
    transport.onFailure((error) => this.#fail(attempt, error));
    void transport.ready.then(async () => {
      if (!this.#isCurrent(attempt)) return;
      // A peer can reconcile before this ready continuation gets its microtask.
      if (attempt.phase === 'connecting') this.#phase(attempt, 'reconciling', DEFAULT_RPC_TIMEOUT_MS);
      if (this.link.role !== 'controller') return;
      await rpc.reconcileParked();
      if (!this.#isCurrent(attempt)) return;
      rpc.activateIncoming();
      this.#phase(attempt, 'activating');
      this.#send({ type: 'bulk-activate', sessionId: attempt.id });
    }).catch((error: unknown) => this.#fail(attempt, error));
  }

  #activate(attempt: Attempt): void {
    if (!this.#isCurrent(attempt) || !attempt.rpc?.transport.connected) return;
    attempt.rpc.activate();
    attempt.readyAt = performance.now();
    this.#error = null;
    this.#phase(attempt, 'ready');
    for (const waiter of [...this.#waiters]) waiter.ready(attempt.rpc);
  }

  #isCurrent(attempt: Attempt): boolean { return this.#live() && this.#attempt === attempt; }

  #phase(attempt: Attempt, phase: BulkPhase, timeoutMs = this.options.setupTimeoutMs ?? BULK_SETUP_TIMEOUT_MS): void {
    if (attempt.timer) clearTimeout(attempt.timer);
    attempt.phase = phase;
    attempt.timer = phase === 'ready' ? null : setTimeout(() => this.#fail(attempt, new Error(`Bulk ${phase} timed out`)), timeoutMs);
    attempt.timer?.unref?.();
    this.#publish(phase);
  }

  #fail(attempt: Attempt | null, failure: unknown): void {
    if (!attempt || !this.#isCurrent(attempt)) return;
    if (attempt.readyAt !== null && performance.now() - attempt.readyAt >= (this.options.stableSessionMs ?? 10_000)) this.#retries = 0;
    this.#error = failure instanceof Error ? failure : new Error('Bulk connection failed');
    this.options.failed?.({ lane: 'bulk', primarySessionId: this.primary.transport.id, sessionId: attempt.id,
      phase: attempt.phase, reason: failureReason(this.#error), retries: this.#retries,
      setupTimeoutMs: this.options.setupTimeoutMs ?? BULK_SETUP_TIMEOUT_MS,
      queues: attempt.rpc?.transport.channel.queueSnapshot ?? this.primary.transport.channel.queueSnapshot });
    this.#clearAttempt();
    this.#publish('reconnecting');
    if (this.link.role === 'worker') {
      this.#send({ type: 'bulk-lost', sessionId: attempt.id });
      this.#retries++;
    } else {
      const delays = this.options.redialDelaysMs ?? REDIAL_DELAYS_MS;
      this.#retry = setTimeout(() => { this.#retry = null; this.#prepare(); }, delays[Math.min(this.#retries++, delays.length - 1)]);
      this.#retry.unref?.();
    }
  }

  #clearAttempt(): void {
    const attempt = this.#attempt;
    this.#attempt = null;
    this.#outbox.length = 0;
    if (attempt?.timer) clearTimeout(attempt.timer);
    if (this.link.current === this.primary.transport) this.link.fenceBulk();
  }

  #send(frame: BulkConnectionControl, sent?: () => void): void {
    if (!this.#live() || this.#outbox.some((pending) => pending.frame.type === frame.type && pending.frame.sessionId === frame.sessionId)) return;
    // Each phase emits one fixed-size frame; obsolete phases are discarded on replacement.
    if (this.#outbox.length >= 4) { this.#fail(this.#attempt, new Error('Bulk control outbox exhausted')); return; }
    this.#outbox.push({ frame, sent });
    this.#flush();
  }

  #flush(): void {
    if (this.#flushing || !this.#live()) return;
    this.#flushing = true;
    try {
      while (this.#outbox.length) {
        const pending = this.#outbox[0]!;
        if (!this.primary.transport.channel.offerBulkControl(pending.frame)) return;
        this.#outbox.shift();
        pending.sent?.();
      }
    } finally { this.#flushing = false; }
  }

  #publish(phase: BulkPhase): void {
    this.options.changed({ phase, sessionId: this.#attempt?.id ?? null, error: this.#error, retries: this.#retries });
  }
}
