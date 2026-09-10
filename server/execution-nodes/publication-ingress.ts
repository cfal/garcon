import {
  decodeWireProducerEvent,
  MAX_NODE_OUTPUT_SEQUENCE,
  parseProducerStreamIdentity,
  producerStreamKey,
  type AgentPermissionResponseCapability,
  type AgentProducerSink,
  type NodeOutputAck,
  type NodeOutputFrame,
  type ProducerStreamIdentity,
} from '@garcon/server-agent-interface';

export type PublicationResult =
  | { readonly kind: 'ack'; readonly ack: NodeOutputAck }
  | { readonly kind: 'replay-needed'; readonly afterSequence: number }
  | { readonly kind: 'retired' }
  | { readonly kind: 'stale-stream' };

export interface PublicationIngressOptions {
  readonly stream: ProducerStreamIdentity;
  readonly sink: AgentProducerSink;
  /** Reconstructs history even for expired occurrences; its response capability then rejects as unavailable. */
  readonly permission: (handle: string, runId: string, occurrenceId: string) => AgentPermissionResponseCapability;
}

/** Deduplicates transport before invoking one captured synchronous V5 publisher. */
export class OrderedPublicationIngress {
  readonly #stream: ProducerStreamIdentity;
  readonly #streamKey: string;
  readonly #sink: AgentProducerSink;
  readonly #permission: PublicationIngressOptions['permission'];
  #accepted = 0;
  #retired = false;
  #receiving = false;

  constructor(options: PublicationIngressOptions) {
    const stream = parseProducerStreamIdentity(options.stream);
    if (!stream) throw new TypeError('Invalid producer stream');
    this.#stream = Object.freeze(stream);
    this.#streamKey = producerStreamKey(stream);
    this.#sink = options.sink;
    this.#permission = options.permission;
  }

  receive(frame: NodeOutputFrame): PublicationResult {
    if (producerStreamKey(frame.stream) !== this.#streamKey) return { kind: 'stale-stream' };
    if (this.#retired) return { kind: 'retired' };
    if (!Number.isSafeInteger(frame.sequence) || frame.sequence < 1 || frame.sequence > MAX_NODE_OUTPUT_SEQUENCE) {
      throw new TypeError('Invalid producer sequence');
    }
    if (this.#receiving) throw new Error('Producer publication is already in progress');
    if (frame.sequence <= this.#accepted) return this.#ack();
    if (frame.sequence !== this.#accepted + 1) return { kind: 'replay-needed', afterSequence: this.#accepted };
    this.#receiving = true;
    try {
      const event = decodeWireProducerEvent(frame.event, this.#permission);
      if (this.#retired) return { kind: 'retired' };
      try {
        this.#sink.publish(event);
      } catch (error) {
        this.#retired = true;
        throw error;
      }
      this.#accepted = frame.sequence;
      return this.#ack();
    } finally {
      this.#receiving = false;
    }
  }

  retire(): void {
    this.#retired = true;
  }

  get acceptedSequence(): number {
    return this.#accepted;
  }

  #ack(): PublicationResult {
    return { kind: 'ack', ack: { type: 'node-output-ack', stream: this.#stream, throughSequence: this.#accepted } };
  }
}
