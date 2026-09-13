import {
  NODE_WIRE_VERSION, parseNodeOutputText, producerStreamKey,
  type NodeOutputAck, type NodeReplayReply, type ProducerStreamIdentity,
} from '@garcon/server-agent-interface';
import type { NodeOutputReplayCursor } from '../execution-node/worker/output-delivery.js';
import {
  NodeWorkerOutputDeliveryReceiver, type NodeWorkerOutputDeliveryReceiverOptions,
} from '../execution-node/worker/output-delivery-receiver.js';
import type { NodeWorkerOutputRetirement } from '../execution-node/worker/output-retirement.js';
import { NodeWorkerTransportError } from '../execution-node/worker/framing.js';
import { NodeOutputRetirements } from '../execution-node/output-retirements.js';
import { DomainError } from '../lib/domain-error.js';
import type { ProviderExecutionOutput } from './provider-execution.js';
import { OrderedPublicationIngress, type PublicationIngressOptions } from './publication-ingress.js';

export interface NodePublicationRoute {
  readonly stream: ProducerStreamIdentity;
  readonly signal: AbortSignal;
  readonly acceptedSequence: number;
  retire(): void;
}

export interface NodePublicationRouteOptions {
  readonly instanceId: string;
  readonly stream: ProducerStreamIdentity;
  readonly output: ProviderExecutionOutput;
  readonly permission: PublicationIngressOptions['permission'];
  failed(error: unknown): void;
}

interface PublicationOwner {
  readonly route: NodePublicationRoute;
  readonly instanceId: string;
  readonly ingress: OrderedPublicationIngress;
  readonly cancellation: AbortController;
  readonly detach: () => void;
  readonly failed: NodePublicationRouteOptions['failed'];
}

export interface NodePublicationDeliveryResult {
  readonly kind: 'record' | 'chunk' | 'retired';
  readonly ack: NodeOutputAck | null;
}

/** Owns immutable controller publishers and body-free retirements for one logical node session. */
export class NodePublicationRoutes {
  readonly #receiver: NodeWorkerOutputDeliveryReceiver;
  readonly #retirements: NodeOutputRetirements;
  readonly #owners = new Map<string, PublicationOwner>();
  readonly #detach: () => void;
  #closed = false;
  #receiving = false;
  #ack: NodeOutputAck | null = null;

  constructor(private readonly options: NodeWorkerOutputDeliveryReceiverOptions) {
    this.options = Object.freeze({ ...options });
    this.#receiver = new NodeWorkerOutputDeliveryReceiver({ ...options, failed: (error) => {
      this.close(); options.failed(error);
    } });
    this.#retirements = new NodeOutputRetirements(options);
    const close = () => this.close();
    this.#detach = () => options.signal.removeEventListener('abort', close);
    options.signal.addEventListener('abort', close, { once: true });
    if (options.signal.aborted) this.close();
  }

  install(options: NodePublicationRouteOptions): NodePublicationRoute {
    this.#validate(); options.output.signal.throwIfAborted();
    const stream = Object.freeze({ ...options.stream });
    const cancellation = new AbortController();
    const output = options.output;
    const { signal, emit } = output;
    const failed = options.failed;
    const ingress = new OrderedPublicationIngress({ stream, sink: { publish: (event) => Reflect.apply(emit, output, [event]) },
      permission: options.permission });
    const retire = () => this.#retire(owner);
    const route: NodePublicationRoute = Object.freeze({ stream, signal: cancellation.signal,
      get acceptedSequence() { return ingress.acceptedSequence; }, retire });
    const owner: PublicationOwner = { route, instanceId: options.instanceId, ingress, cancellation,
      detach: () => signal.removeEventListener('abort', retire),
      failed: (error) => { if (!signal.aborted) failed(error); } };
    let installed = false;
    try {
      this.#receiver.install(options.instanceId, stream, cancellation.signal, (text) => {
        const frame = parseNodeOutputText(text);
        if (!this.#receiving || !frame) throw protocol();
        const result = ingress.receive(frame);
        if (result.kind === 'ack') this.#ack = result.ack;
        else if (result.kind !== 'retired') throw protocol();
      }, (error) => this.#retire(owner, error));
      installed = true;
      if (this.#closed) throw closed();
      signal.throwIfAborted();
    } catch (error) {
      ingress.retire(); if (installed) this.#receiver.retire(stream); cancellation.abort(error); throw error;
    }
    this.#owners.set(producerStreamKey(stream), owner);
    signal.addEventListener('abort', retire, { once: true });
    return route;
  }

  cursors(): readonly NodeOutputReplayCursor[] {
    this.#validate();
    return [...this.#owners.values()].map(({ route }) => ({ stream: route.stream, afterSequence: route.acceptedSequence }));
  }

  begin(...args: Parameters<NodeWorkerOutputDeliveryReceiver['begin']>): ReturnType<NodeWorkerOutputDeliveryReceiver['begin']> {
    this.#validate();
    return this.#receiver.begin(...args);
  }

  suspend(...args: Parameters<NodeWorkerOutputDeliveryReceiver['suspend']>): boolean {
    return this.#receiver.suspend(...args);
  }

  waitForAccepted(...args: Parameters<NodeWorkerOutputDeliveryReceiver['waitForAccepted']>): Promise<void> {
    this.#validate();
    return this.#receiver.waitForAccepted(...args);
  }

  receiveSuspension(text: string): boolean {
    return !this.#closed && this.#receiver.receiveSuspension(text);
  }

  /** ACK transmission happens after this synchronous boundary; its failure cannot undo or retire publication. */
  receive(text: string): NodePublicationDeliveryResult {
    this.#validate();
    if (this.#receiving) throw protocol();
    this.#receiving = true;
    this.#ack = null;
    try {
      const result = this.#receiver.receive(text);
      if (this.#closed) return { kind: 'retired', ack: null };
      if (result.kind === 'duplicate') {
        const owner = this.#owners.get(producerStreamKey(result.stream));
        if (!owner) return { kind: 'retired', ack: null };
        return { kind: 'record', ack: { type: 'node-output-ack', stream: owner.route.stream, throughSequence: owner.ingress.acceptedSequence } };
      }
      return { kind: result.kind, ack: this.#ack };
    } finally { this.#receiving = false; this.#ack = null; }
  }

  receiveRetirement(text: string): void {
    this.#validate(); this.#receiver.receiveRetirement(text);
  }

  retireGap(range: Extract<NodeReplayReply, { type: 'node-replay-gap' }>): void {
    this.#validate();
    const owner = this.#owners.get(producerStreamKey(range.stream));
    if (owner) this.#retire(owner, new DomainError('NODE_REPLAY_GAP', 'Required node output is no longer available', 409));
  }

  flushRetirements(send: (frame: NodeWorkerOutputRetirement, signal: AbortSignal) => Promise<void>, signal: AbortSignal): Promise<void> {
    this.#validate();
    return this.#retirements.replay(send, signal);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true; this.#detach(); this.#receiver.close();
    this.#retirements.close(); this.#ack = null;
    for (const owner of this.#owners.values()) {
      owner.detach(); owner.ingress.retire(); owner.cancellation.abort(closed());
    }
    this.#owners.clear();
  }

  #retire(owner: PublicationOwner, error?: unknown): void {
    if (this.#closed) return;
    const { route, ingress, cancellation, instanceId } = owner;
    if (this.#owners.get(producerStreamKey(route.stream)) !== owner) return;
    this.#owners.delete(producerStreamKey(route.stream));
    owner.detach(); ingress.retire(); this.#receiver.retire(route.stream);
    try {
      const reason = error instanceof DomainError && error.code === 'NODE_REPLAY_GAP' ? 'replay-gap' : 'output-retired';
      this.#retirements.record({ type: 'node-worker-output-retired', reason, version: NODE_WIRE_VERSION, instanceId, stream: route.stream });
    } finally {
      cancellation.abort(error ?? closed());
      if (error !== undefined) {
        try { owner.failed(error); } catch { /* A failed publisher cannot affect a sibling's route. */ }
      }
    }
  }

  #validate(): void {
    if (this.#closed) throw closed();
    try {
      this.options.signal.throwIfAborted(); this.options.validate(); this.options.signal.throwIfAborted();
      if (this.#closed) throw closed();
    } catch (error) {
      if (!this.#closed) {
        this.close();
        try { this.options.failed(error); } catch { /* Session authority has already retired. */ }
      }
      throw error;
    }
  }
}

function closed(): NodeWorkerTransportError { return new NodeWorkerTransportError('NODE_WORKER_CLOSED'); }
function protocol(): NodeWorkerTransportError { return new NodeWorkerTransportError('NODE_WORKER_PROTOCOL'); }
