import { randomUUID } from 'node:crypto';
import { NODE_WIRE_VERSION } from '@garcon/server-agent-interface';
import { isExecutionIdentity } from '../../../common/execution-location.js';
import { parseNodeSessionIdentity, sameNodeSession, type NodeSessionIdentity } from '../../../common/node-operation.js';
import { parseNodeWorkerBulkText, type NodeWorkerBulkFrame } from '../../execution-node/worker/bulk-protocol.js';
import { NodeWorkerTransportError } from '../../execution-node/worker/framing.js';
import { isNodeBulkData, isNodeBulkReply, parseNodeBulkFrameText, type NodeBulkFrame } from './bulk-channel-wire.js';
import { parseNodeBulkSessionFrameText, serializeNodeBulkSessionFrame } from './bulk-session-wire.js';
import { NODE_HANDSHAKE_TIMEOUT_MS } from './session-wire.js';
import type { NodeSocketWriter } from './socket-writer.js';
import type { PairedNodePrincipal } from '../pairing-store.js';

export interface NodeBulkControlBinding {
  readonly principal: PairedNodePrincipal;
  readonly session: NodeSessionIdentity;
  readonly connectionId: number;
  readonly instanceIds: ReadonlySet<string>;
  readonly signal: AbortSignal;
  validate(): void;
}

export interface NodeBulkSessionBinding extends NodeBulkControlBinding {
  readonly bulkAttemptId: string;
}

interface BulkSessionOptions {
  readonly signal: AbortSignal;
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => { cancel(): void };
  validate(): void;
  received(frame: NodeWorkerBulkFrame): void;
  disconnected(error: unknown): void;
}

export type NodeBulkSessionOptions = BulkSessionOptions & (
  | { readonly side: 'node'; readonly binding: NodeBulkControlBinding }
  | { readonly side: 'controller'; readonly principal: PairedNodePrincipal;
      /** Verifies the supplied principal against the current binding before any replacement or mutation. */
      capture(principal: PairedNodePrincipal, session: NodeSessionIdentity, connectionId: number, bulkAttemptId: string): NodeBulkControlBinding }
);

/** Binds a separately authenticated bulk socket to one current control connection without acquiring logical authority. */
export class NodeBulkSessionChannel {
  readonly #closing = new AbortController();
  readonly #ready = Promise.withResolvers<NodeBulkSessionBinding>();
  readonly #detach: () => void;
  #detachBinding: (() => void) | null = null;
  #binding: NodeBulkSessionBinding | null = null;
  #timer: { cancel(): void } | null = null;
  #started = false;
  #active = false;

  constructor(private readonly writer: Pick<NodeSocketWriter, 'send' | 'sendData' | 'sendApplication' | 'sendWhenWritable' | 'sendApplicationWhenWritable' | 'close'>,
    private readonly options: NodeBulkSessionOptions) {
    this.options = Object.freeze(options.side === 'controller'
      ? { ...options, principal: Object.freeze({ ...options.principal }) } : { ...options });
    void this.#ready.promise.catch(() => {});
    const close = () => this.close();
    this.#detach = () => options.signal.removeEventListener('abort', close);
    options.signal.addEventListener('abort', close, { once: true });
    if (options.signal.aborted) this.close();
    else {
      this.#timer = (options.scheduleTimeout ?? scheduleTimeout)(() => this.#close(new NodeWorkerTransportError('NODE_WORKER_TIMEOUT')),
        NODE_HANDSHAKE_TIMEOUT_MS);
      try { if (options.side === 'node') this.#bind(options.binding, randomUUID()); }
      catch (error) { this.#close(error); }
    }
  }

  get ready(): Promise<NodeBulkSessionBinding> { return this.#ready.promise; }

  start(): void {
    if (this.#started || this.#closing.signal.aborted) return;
    this.#started = true;
    if (this.options.side !== 'node') return;
    try {
      this.#validate();
      const { session, connectionId, bulkAttemptId } = this.#binding!;
      if (!this.writer.send(serializeNodeBulkSessionFrame({ type: 'node-bulk-session-hello', version: NODE_WIRE_VERSION,
        session, connectionId, bulkAttemptId }))) throw capacity();
    } catch (error) { this.#close(error); }
  }

  receive(text: string): void {
    if (this.#closing.signal.aborted) return;
    try {
      this.#validate();
      if (!this.#active) {
        const frame = parseNodeBulkSessionFrameText(text);
        if (!frame) throw protocol();
        if (this.options.side === 'controller') {
          if (frame.type !== 'node-bulk-session-hello') throw protocol();
          const binding = this.options.capture(this.options.principal, frame.session, frame.connectionId, frame.bulkAttemptId);
          if (!sameNodeSession(frame.session, binding.session) || frame.connectionId !== binding.connectionId
            || binding.principal.nodeId !== this.options.principal.nodeId
            || binding.principal.controllerId !== this.options.principal.controllerId) throw protocol();
          this.#bind(binding, frame.bulkAttemptId);
          this.#validate();
          if (!this.writer.send(serializeNodeBulkSessionFrame({ ...frame, type: 'node-bulk-session-ready' }))) throw capacity();
        } else {
          if (!this.#started || frame.type !== 'node-bulk-session-ready' || !sameNodeSession(frame.session, this.#binding!.session)
            || frame.connectionId !== this.#binding!.connectionId || frame.bulkAttemptId !== this.#binding!.bulkAttemptId) throw protocol();
        }
        this.#validate();
        this.#active = true;
        this.#timer?.cancel(); this.#timer = null;
        this.#ready.resolve(this.#binding!);
        return;
      }
      const { frame } = this.#parse(text, this.options.side === 'node' ? 'request' : 'reply');
      this.options.received(frame);
    } catch (error) { this.#close(error); }
  }

  send(frame: NodeWorkerBulkFrame): boolean {
    this.#assertActive();
    const text = JSON.stringify(frame);
    const parsed = this.#parse(text, this.options.side === 'controller' ? 'request' : 'reply');
    return isNodeBulkData(parsed.bulk) ? this.writer.sendData(text) : this.writer.sendApplication(text);
  }

  async sendWhenWritable(frame: NodeWorkerBulkFrame, signal: AbortSignal): Promise<void> {
    this.#assertActive(); signal.throwIfAborted();
    const text = JSON.stringify(frame);
    const parsed = this.#parse(text, this.options.side === 'controller' ? 'request' : 'reply');
    const caller = AbortSignal.any([signal, this.#closing.signal]);
    const validate = () => this.#assertActive();
    if (isNodeBulkData(parsed.bulk)) await this.writer.sendWhenWritable(text, caller, validate);
    else await this.writer.sendApplicationWhenWritable(text, caller, validate);
  }

  close(): void { this.#close(new NodeWorkerTransportError('NODE_WORKER_CLOSED')); }

  #bind(binding: NodeBulkControlBinding, bulkAttemptId: string): void {
    const session = parseNodeSessionIdentity(binding.session);
    if (this.#binding || !session || !isExecutionIdentity(bulkAttemptId) || !Number.isSafeInteger(binding.connectionId) || binding.connectionId < 1
      || !isExecutionIdentity(binding.principal.nodeId) || !isExecutionIdentity(binding.principal.controllerId)
      || !binding.instanceIds.size || binding.instanceIds.size > 64 || [...binding.instanceIds].some((id) => !isExecutionIdentity(id))) throw protocol();
    binding.signal.throwIfAborted();
    this.#binding = Object.freeze({ ...binding, bulkAttemptId, principal: Object.freeze({ ...binding.principal }),
      session: Object.freeze(session), instanceIds: new Set(binding.instanceIds),
      signal: AbortSignal.any([binding.signal, this.#closing.signal]) });
    const close = () => this.close();
    this.#detachBinding = () => binding.signal.removeEventListener('abort', close);
    binding.signal.addEventListener('abort', close, { once: true });
    this.#validate();
  }

  #parse(text: string, direction: 'request' | 'reply'): { frame: NodeWorkerBulkFrame; bulk: NodeBulkFrame } {
    const frame = parseNodeWorkerBulkText(text);
    const binding = this.#binding!;
    if (!frame || !sameNodeSession(frame.session, binding.session) || frame.connectionId !== binding.connectionId
      || !binding.instanceIds.has(frame.instanceId)) throw protocol();
    const bulk = parseNodeBulkFrameText(frame.payload)!;
    const reply = isNodeBulkReply(bulk);
    if ((direction === 'reply') !== reply) throw protocol();
    return { frame, bulk };
  }

  #assertActive(): void { this.#validate(); if (!this.#active) throw new NodeWorkerTransportError('NODE_WORKER_CLOSED'); }

  #validate(): void {
    this.#closing.signal.throwIfAborted(); this.options.signal.throwIfAborted(); this.options.validate();
    this.#binding?.signal.throwIfAborted(); this.#binding?.validate(); this.#closing.signal.throwIfAborted();
  }

  #close(error: unknown): void {
    if (this.#closing.signal.aborted) return;
    this.#closing.abort(error); this.#ready.reject(error); this.#detach(); this.#detachBinding?.();
    this.#timer?.cancel(); this.#timer = null;
    this.writer.close();
    try { this.options.disconnected(error); } catch { /* Bulk failure cannot retire its control connection. */ }
  }
}

function protocol(): NodeWorkerTransportError { return new NodeWorkerTransportError('NODE_WORKER_PROTOCOL'); }
function capacity(): NodeWorkerTransportError { return new NodeWorkerTransportError('NODE_WORKER_CAPACITY'); }
function scheduleTimeout(callback: () => void, delayMs: number): { cancel(): void } {
  const timer = setTimeout(callback, delayMs); timer.unref();
  return { cancel: () => clearTimeout(timer) };
}
