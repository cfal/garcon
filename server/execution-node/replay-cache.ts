import {
  MAX_NODE_OUTPUT_SEQUENCE,
  parseProducerStreamIdentity,
  producerStreamKey,
  type NodeReplayReply,
  type ProducerStreamIdentity,
} from '@garcon/server-agent-interface';

export interface NodeReplayOptions {
  readonly enabled: boolean;
  readonly maxAgeMs: number;
  readonly maxBytes: number;
}

export const DEFAULT_NODE_REPLAY: NodeReplayOptions = Object.freeze({
  enabled: true,
  maxAgeMs: 5 * 60 * 1_000,
  maxBytes: 20 * 1024 * 1024,
});

// Includes retired grants; reaching the limit rejects new grants without evicting live publishers.
export const MAX_NODE_STREAM_IDENTITIES = 16_384;

export class NodeReplayUnavailableError extends Error {
  readonly code = 'NODE_REPLAY_GAP';

  constructor() {
    super('Producer stream is retired or unknown');
    this.name = 'NodeReplayUnavailableError';
  }
}

interface StreamRecords {
  readonly identity: ProducerStreamIdentity;
  readonly records: Map<number, CachedOutput>;
  produced: number;
}

interface CachedOutput {
  readonly owner: StreamRecords;
  readonly sequence: number;
  readonly serialized: string;
  readonly bytes: number;
  readonly createdAt: number;
}

export type ReplayRead =
  | { readonly kind: 'record'; readonly sequence: number; readonly serialized: string }
  | Extract<NodeReplayReply, { readonly type: 'node-replay-gap' }>;

/** Retains only process-local immutable output, bounded across all streams in one paired namespace. */
export class NodeReplayCache {
  readonly #options: NodeReplayOptions;
  readonly #now: () => number;
  readonly #streams = new Map<string, StreamRecords | null>();
  readonly #oldestFirst = new Set<CachedOutput>();
  #liveStreams = 0;
  #closed = false;
  #bytes = 0;
  #lastTime = 0;

  constructor(options: NodeReplayOptions = DEFAULT_NODE_REPLAY, now: () => number = () => performance.now()) {
    if (typeof options.enabled !== 'boolean' || !Number.isSafeInteger(options.maxAgeMs) || options.maxAgeMs < 1
      || !Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
      throw new TypeError('Invalid node replay configuration');
    }
    this.#options = { ...options };
    this.#now = now;
  }

  register(stream: ProducerStreamIdentity): void {
    if (this.#closed) throw new Error('Node replay namespace is closed');
    const identity = parseProducerStreamIdentity(stream);
    if (!identity) throw new TypeError('Invalid producer stream');
    const key = producerStreamKey(identity);
    if (this.#streams.has(key)) throw new Error('Producer stream already registered');
    if (this.#streams.size >= MAX_NODE_STREAM_IDENTITIES) {
      throw new RangeError('Node stream identity limit reached; a fresh execution session is required for new grants');
    }
    this.#streams.set(key, { identity: Object.freeze(identity), records: new Map(), produced: 0 });
    this.#liveStreams += 1;
  }

  append(stream: ProducerStreamIdentity, sequence: number, serialized: string): void {
    const owner = this.#require(stream);
    if (!Number.isSafeInteger(sequence) || sequence > MAX_NODE_OUTPUT_SEQUENCE || sequence !== owner.produced + 1) {
      throw new TypeError('Node output must be produced contiguously');
    }
    const createdAt = this.#time();
    this.#prune(createdAt);
    owner.produced = sequence;
    if (!this.#options.enabled) return;
    const record: CachedOutput = { owner, sequence, serialized, bytes: Buffer.byteLength(serialized), createdAt };
    owner.records.set(sequence, record);
    this.#oldestFirst.add(record);
    this.#bytes += record.bytes;
    this.#prune(createdAt);
  }

  acknowledge(stream: ProducerStreamIdentity, throughSequence: number): void {
    const owner = this.#streams.get(producerStreamKey(stream));
    if (!owner) return;
    assertCursor(throughSequence, owner.produced);
    for (const record of owner.records.values()) {
      if (record.sequence > throughSequence) break;
      this.#remove(record);
    }
    this.prune();
  }

  capture(stream: ProducerStreamIdentity, afterSequence: number): NodeReplayReply {
    const owner = this.#require(stream);
    assertCursor(afterSequence, owner.produced);
    this.prune();
    if (afterSequence < owner.produced && !owner.records.has(afterSequence + 1)) {
      return this.#gap(owner, afterSequence);
    }
    return {
      type: 'node-replay-ready', stream: owner.identity, afterSequence, throughSequence: owner.produced,
    };
  }

  read(stream: ProducerStreamIdentity, sequence: number, throughSequence: number): ReplayRead {
    const owner = this.#require(stream);
    assertCursor(throughSequence, owner.produced);
    if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > throughSequence) {
      throw new TypeError('Invalid output replay range');
    }
    this.prune();
    const record = owner.records.get(sequence);
    return record ? { kind: 'record', sequence, serialized: record.serialized } : this.#gap(owner, sequence - 1);
  }

  retire(stream: ProducerStreamIdentity): void {
    const key = producerStreamKey(stream);
    const owner = this.#streams.get(key);
    if (!owner) return;
    for (const record of owner.records.values()) this.#remove(record);
    this.#streams.set(key, null);
    this.#liveStreams -= 1;
  }

  /** Releases a retired namespace permanently; a fresh logical session uses a new cache. */
  clear(): void {
    this.#closed = true;
    this.#oldestFirst.clear();
    this.#streams.clear();
    this.#liveStreams = 0;
    this.#bytes = 0;
  }

  prune(): void {
    this.#prune(this.#time());
  }

  get retainedBytes(): number {
    this.prune();
    return this.#bytes;
  }

  get streamCount(): number {
    return this.#liveStreams;
  }

  #require(stream: ProducerStreamIdentity): StreamRecords {
    const owner = this.#streams.get(producerStreamKey(stream));
    if (!owner) throw new NodeReplayUnavailableError();
    return owner;
  }

  #gap(owner: StreamRecords, requestedAfter: number): Extract<NodeReplayReply, { type: 'node-replay-gap' }> {
    const first = owner.records.keys().next().value;
    return {
      type: 'node-replay-gap', stream: owner.identity, requestedAfter,
      firstRetainedSequence: first ?? owner.produced + 1, lastProducedSequence: owner.produced,
    };
  }

  #time(): number {
    const now = this.#now();
    if (!Number.isFinite(now) || now < 0) throw new TypeError('Invalid replay clock');
    if (now < this.#lastTime) {
      for (const record of this.#oldestFirst) this.#remove(record);
    }
    this.#lastTime = now;
    return now;
  }

  #prune(now: number): void {
    for (const record of this.#oldestFirst) {
      if (this.#bytes <= this.#options.maxBytes && now - record.createdAt < this.#options.maxAgeMs) break;
      this.#remove(record);
    }
  }

  #remove(record: CachedOutput): void {
    record.owner.records.delete(record.sequence);
    this.#oldestFirst.delete(record);
    this.#bytes -= record.bytes;
  }
}

function assertCursor(cursor: number, produced: number): void {
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > produced) {
    throw new TypeError('Invalid node output cursor');
  }
}
