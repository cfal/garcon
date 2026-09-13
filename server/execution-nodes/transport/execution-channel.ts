import { NODE_WIRE_VERSION } from '@garcon/server-agent-interface';
import { sameExecutionLocation } from '../../../common/execution-location.js';
import { parseNodeSessionIdentity, sameNodeSession, type NodeOperationIdentity, type NodeSessionIdentity } from '../../../common/node-operation.js';
import {
  parseNodeExecutionEnvelopeText, parseNodeExecutionCancellationText, serializeNodeExecutionCall, serializeNodeExecutionCancellation,
  isNodeExecutionReconciliation, type NodeExecutionCall, type NodeExecutionCommand,
} from './execution-wire.js';
import { parseNodeExecutionReplyText, serializeNodeExecutionReply, type NodeExecutionResult } from './execution-receipt-wire.js';
import type { NodeReplyAuthority, NodeReplyPort } from './reply-port.js';
import { isNodeRequestTimeout, NodeDeadline } from '../deadline.js';
import type { LeaseClock } from '../../execution-node/lease-clock.js';

export interface NodeExecutionWriteAuthority {
  readonly deadline: NodeDeadline;
  expired(): void;
}

export interface NodeExecutionChannelWriter {
  send(text: string, authority?: NodeExecutionWriteAuthority): boolean;
  close(): void;
}

export interface NodeExecutionChannelOptions {
  readonly session: NodeSessionIdentity;
  readonly signal: AbortSignal;
  readonly maxRequests?: number;
  readonly reservedControlRequests?: number;
  readonly budget?: NodeExecutionRequestBudget;
  readonly requestTimeoutMs?: number;
  readonly createClock?: () => LeaseClock;
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => { cancel(): void };
  /** Validates the exact physical connection without reopening admission during recovery. */
  validate(): void;
}

interface PendingCall {
  readonly deadline: NodeDeadline;
  readonly cancel: () => void;
  readonly result: PromiseWithResolvers<NodeExecutionResult>;
  readonly accepts: (result: NodeExecutionResult) => boolean;
  readonly detach: () => void;
  readonly priority: boolean;
  readonly release: (() => void) | null;
  timer: { cancel(): void } | null;
}

/** Shares request capacity across instance channels, with space reserved for reconciliation. */
export class NodeExecutionRequestBudget {
  readonly #limits: ChannelLimits;
  #total = 0;
  #ordinary = 0;

  constructor(options: Pick<NodeExecutionChannelOptions, 'maxRequests' | 'reservedControlRequests'> = {}) {
    this.#limits = channelLimits(options);
  }

  acquire(command: NodeExecutionCommand): (() => void) | null {
    const priority = isNodeExecutionReconciliation(command);
    if (atCapacity(this.#total, this.#ordinary, priority, this.#limits)) return null;
    this.#total++;
    if (!priority) this.#ordinary++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#total--;
      if (!priority) this.#ordinary--;
    };
  }
}

/** Owns physical requests only; sent mutations become unknown on reply loss and are never retried. */
export class NodeExecutionClient {
  readonly #session: NodeSessionIdentity;
  readonly #limits: ChannelLimits;
  readonly #pending = new Map<number, PendingCall>();
  readonly #detach: () => void;
  #ordinary = 0;
  #sent = 0;
  #closed = false;

  constructor(private readonly writer: NodeExecutionChannelWriter, private readonly options: NodeExecutionChannelOptions) {
    this.#session = sessionIdentity(options.session);
    this.#limits = channelLimits(options);
    const close = () => this.close();
    options.signal.addEventListener('abort', close, { once: true });
    this.#detach = () => options.signal.removeEventListener('abort', close);
    if (options.signal.aborted) this.close();
  }

  async call(command: NodeExecutionCommand, signal: AbortSignal, deadline = new NodeDeadline(this.#limits.timeoutMs, this.options.createClock?.())): Promise<NodeExecutionResult> {
    signal.throwIfAborted();
    if (deadline.remainingMs === 0) return { kind: 'unknown' };
    if (!this.#validate()) return { kind: 'rejected', code: 'NODE_UNAVAILABLE' };
    const priority = isNodeExecutionReconciliation(command);
    if (atCapacity(this.#pending.size, this.#ordinary, priority, this.#limits)) return { kind: 'rejected', code: 'NODE_CAPACITY' };
    if (this.#sent === Number.MAX_SAFE_INTEGER) { this.close(); return { kind: 'rejected', code: 'NODE_UNAVAILABLE' }; }
    const requestId = this.#sent + 1;
    let serialized: string;
    try {
      const timeoutMs = deadline.remainingMs;
      if (timeoutMs === 0) return { kind: 'unknown' };
      serialized = serializeNodeExecutionCall({ type: 'node-execution-request', version: NODE_WIRE_VERSION,
        session: this.#session, requestId, timeoutMs, command });
    } catch { return { kind: 'rejected', code: 'VALIDATION_FAILED' }; }
    const release = this.options.budget?.acquire(command) ?? null;
    if (this.options.budget && !release) return { kind: 'rejected', code: 'NODE_CAPACITY' };
    let handedOff = false;
    const cancel = () => {
      if (!this.#pending.has(requestId)) return;
      this.#settle(requestId, { kind: 'unknown' });
      if (!handedOff || !this.#validate()) return;
      try { this.writer.send(serializeNodeExecutionCancellation({ type: 'node-execution-cancel', version: NODE_WIRE_VERSION,
        session: this.#session, requestId })); }
      catch { this.close(); }
    };
    const pending: PendingCall = { deadline, cancel, result: Promise.withResolvers<NodeExecutionResult>(), accepts: expectedResult(command), priority, release,
      timer: null, detach: () => signal.removeEventListener('abort', cancel) };
    this.#pending.set(requestId, pending);
    if (!priority) this.#ordinary += 1;
    this.#sent = requestId;
    signal.addEventListener('abort', cancel, { once: true });
    pending.timer = (this.options.scheduleTimeout ?? scheduleTimeout)(cancel, deadline.remainingMs);
    try {
      if (deadline.remainingMs === 0 || signal.aborted) cancel();
      if (!this.#pending.has(requestId)) return pending.result.promise;
      handedOff = true;
      if (!this.writer.send(serialized, { deadline, expired: cancel })) {
        this.#settle(requestId, { kind: 'rejected', code: 'NODE_CAPACITY' });
      }
    }
    catch { if (this.#pending.has(requestId)) this.close(); }
    return pending.result.promise;
  }

  receive(serialized: string): void {
    if (!this.#validate()) return;
    const reply = parseNodeExecutionReplyText(serialized);
    if (!reply || !sameNodeSession(reply.session, this.#session) || reply.requestId > this.#sent) { this.close(); return; }
    const pending = this.#pending.get(reply.requestId);
    if (!pending) return;
    if (pending.deadline.remainingMs === 0) { pending.cancel(); return; }
    if (!pending.accepts(reply.result)) { this.close(); return; }
    this.#settle(reply.requestId, reply.result);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#detach();
    for (const requestId of this.#pending.keys()) this.#settle(requestId, { kind: 'unknown' });
    this.writer.close();
  }

  #settle(requestId: number, result: NodeExecutionResult): void {
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    this.#pending.delete(requestId);
    if (!pending.priority) this.#ordinary -= 1;
    pending.release?.();
    pending.detach();
    pending.timer?.cancel();
    pending.result.resolve(result);
  }

  #validate(): boolean {
    if (this.#closed) return false;
    try { this.options.signal.throwIfAborted(); this.options.validate(); }
    catch { this.close(); }
    return !this.#closed;
  }
}

export interface NodeExecutionRequestHandler {
  execute(command: NodeExecutionCommand, signal: AbortSignal, deadline: NodeDeadline): Promise<NodeExecutionResult>;
}

/** Cancellation keeps a handler's slot until settlement; reconciliation has reserved capacity. */
export class NodeExecutionServer {
  readonly #session: NodeSessionIdentity;
  readonly #limits: ChannelLimits;
  readonly #pending = new Map<number, AbortController>();
  readonly #closing = new AbortController();
  readonly #detach: () => void;
  readonly #replyAuthority: NodeReplyAuthority;
  #ordinary = 0;
  #received = 0;
  #closed = false;

  constructor(
    private readonly replies: NodeReplyPort,
    private readonly handler: NodeExecutionRequestHandler,
    private readonly options: NodeExecutionChannelOptions,
  ) {
    this.#session = sessionIdentity(options.session);
    this.#limits = channelLimits(options);
    this.#replyAuthority = { signal: this.#closing.signal, validate: () => { if (!this.#validate()) throw new Error('Node reply authority is closed'); }, failed: () => this.close() };
    const close = () => this.close();
    options.signal.addEventListener('abort', close, { once: true });
    this.#detach = () => options.signal.removeEventListener('abort', close);
    if (options.signal.aborted) this.close();
  }

  receive(serialized: string): void {
    if (!this.#validate()) return;
    const call = parseNodeExecutionEnvelopeText(serialized);
    if (!call) {
      const cancel = parseNodeExecutionCancellationText(serialized);
      if (!cancel || !sameNodeSession(cancel.session, this.#session) || cancel.requestId > this.#received) { this.close(); return; }
      this.#pending.get(cancel.requestId)?.abort(new DOMException('Node request cancelled', 'AbortError'));
      this.replies.cancel(cancel.requestId);
      return;
    }
    if (!sameNodeSession(call.session, this.#session) || call.requestId <= this.#received) { this.close(); return; }
    this.#received = call.requestId;
    if (!call.command) {
      this.#reply(call.requestId, { kind: 'rejected', code: 'VALIDATION_FAILED' });
      return;
    }
    const priority = isNodeExecutionReconciliation(call.command);
    if (atCapacity(this.#pending.size, this.#ordinary, priority, this.#limits)) {
      this.#reply(call.requestId, { kind: 'rejected', code: 'NODE_CAPACITY' });
      return;
    }
    const release = this.options.budget?.acquire(call.command) ?? null;
    if (this.options.budget && !release) {
      this.#reply(call.requestId, { kind: 'rejected', code: 'NODE_CAPACITY' });
      return;
    }
    const cancellation = new AbortController();
    this.#pending.set(call.requestId, cancellation);
    if (!priority) this.#ordinary += 1;
    void this.#execute({ ...call, command: call.command }, cancellation, priority, release);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#detach();
    this.#closing.abort(new DOMException('Node connection closed', 'AbortError'));
    this.replies.close();
  }

  async #execute(call: NodeExecutionCall, cancellation: AbortController, priority: boolean, release: (() => void) | null): Promise<void> {
    const deadline = NodeDeadline.receive(call.timeoutMs, this.options.createClock?.());
    const signal = AbortSignal.any([cancellation.signal, this.#closing.signal, this.options.signal]);
    let completed = false;
    const expire = () => {
      if (completed || signal.aborted) return;
      this.#reply(call.requestId, { kind: 'unknown' });
      cancellation.abort(new DOMException('Node request timed out', 'TimeoutError'));
    };
    const timer = (this.options.scheduleTimeout ?? scheduleTimeout)(expire, deadline.remainingMs);
    try {
      if (deadline.remainingMs === 0) expire();
      signal.throwIfAborted();
      const result = await this.handler.execute(call.command, signal, deadline);
      if (deadline.remainingMs === 0) expire();
      if (!signal.aborted) this.#reply(call.requestId, result, signal);
    } catch { if (!signal.aborted) this.#reply(call.requestId, { kind: 'unknown' }, signal); }
    finally {
      completed = true;
      timer.cancel();
      this.#pending.delete(call.requestId);
      if (!priority) this.#ordinary -= 1;
      release?.();
    }
  }

  #reply(requestId: number, result: NodeExecutionResult, signal = this.#closing.signal): void {
    if (!this.#validate()) return;
    let serialized: string;
    try { serialized = serializeNodeExecutionReply({ type: 'node-execution-result', version: NODE_WIRE_VERSION,
      session: this.#session, requestId, result }); }
    catch {
      serialized = serializeNodeExecutionReply({ type: 'node-execution-result', version: NODE_WIRE_VERSION,
        session: this.#session, requestId, result: { kind: 'unknown' } });
    }
    try { this.replies.enqueue(requestId, serialized, { ...this.#replyAuthority, signal }); }
    catch { if (!signal.aborted) this.close(); }
  }

  #validate(): boolean {
    if (this.#closed) return false;
    try { this.options.signal.throwIfAborted(); this.options.validate(); }
    catch { this.close(); }
    return !this.#closed;
  }
}

interface ChannelLimits { readonly ordinary: number; readonly total: number; readonly timeoutMs: number }

function channelLimits(options: Pick<NodeExecutionChannelOptions, 'maxRequests' | 'reservedControlRequests' | 'requestTimeoutMs'>): ChannelLimits {
  const ordinary = options.maxRequests ?? 32;
  const reserved = options.reservedControlRequests ?? 8;
  const timeoutMs = options.requestTimeoutMs ?? 10_000;
  if (!isNodeRequestTimeout(timeoutMs) || ![ordinary, reserved, ordinary + reserved].every((n) => Number.isSafeInteger(n) && n > 0)) throw new TypeError('Invalid execution channel limits');
  return { ordinary, total: ordinary + reserved, timeoutMs };
}

function atCapacity(total: number, ordinary: number, priority: boolean, limits: ChannelLimits): boolean {
  return total >= limits.total || !priority && ordinary >= limits.ordinary;
}

function sessionIdentity(value: NodeSessionIdentity): NodeSessionIdentity {
  const session = parseNodeSessionIdentity(value);
  if (!session) throw new TypeError('Invalid execution channel session');
  return Object.freeze(session);
}

function expectedResult(command: NodeExecutionCommand): (result: NodeExecutionResult) => boolean {
  // Retains only body-free correlation after sending credentials and execution input.
  const { method } = command;
  const identity = 'identity' in command ? { ...command.identity } : null;
  const location = command.method === 'prepare' ? { ...command.location } : null;
  const runId = command.method === 'prepare' ? command.request.runId : command.method === 'prepare-goal' ? command.runId : null;
  return (result) => {
    if (result.kind === 'rejected' || result.kind === 'unknown') return true;
    switch (method) {
      case 'prepare': return result.kind === 'prepared' && result.ticket.runId === runId && sameExecutionLocation(result.ticket.location, location!);
      case 'dispatch': return result.kind === 'dispatched';
      case 'release': return result.kind === 'released';
      case 'abort': case 'abort-run': return result.kind === 'abort-result';
      case 'status': return result.kind === 'status' && (!result.receipt || sameOperation(result.receipt.identity, identity!));
      case 'prepare-steer': case 'prepare-goal': return result.kind === 'control-prepared' && (result.preparation.kind !== 'ready'
        || sameOperation(result.preparation.ticket.identity, identity!)
          && result.preparation.ticket.kind === (method === 'prepare-goal' ? 'goal' : 'steer')
          && (runId === null || result.preparation.ticket.runId === runId));
      case 'commit-steer': return result.kind === 'steer-result';
      case 'commit-goal': return result.kind === 'goal-result';
      case 'cancel-control': return result.kind === 'control-cancelled';
    }
  };
}

function sameOperation(a: NodeOperationIdentity, b: NodeOperationIdentity): boolean {
  return sameNodeSession(a, b) && a.operationId === b.operationId;
}

function scheduleTimeout(callback: () => void, delayMs: number): { cancel(): void } {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return { cancel: () => clearTimeout(timer) };
}
