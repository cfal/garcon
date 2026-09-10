import {
  encodeWireProducerEvent,
  MAX_NODE_OUTPUT_SEQUENCE,
  parseProducerStreamIdentity,
  serializeNodeOutputFrame,
  type AgentEmissionSink,
  type AgentPermissionResponseCapability,
  type AgentProducerEvent,
  type NodePermissionHandleRegistrar,
  type ProducerStreamIdentity,
} from '@garcon/server-agent-interface';
import { NodeReplayCache } from './replay-cache.js';

export interface NodeOutputPermissionHandles {
  createHandle(): string;
  /** Applies the registrar's atomic, registry-lifetime unique binding contract to this stream. */
  register(stream: ProducerStreamIdentity, handle: string, decision: AgentPermissionResponseCapability, runId: string): void;
  /** Invalidates all authority for exactly this stream synchronously without throwing. */
  retire(stream: ProducerStreamIdentity): void;
}

export interface NodeOutputStreamOptions {
  readonly identity: ProducerStreamIdentity;
  readonly cache: NodeReplayCache;
  readonly permissionHandles: NodeOutputPermissionHandles;
  readonly onOutputFailure: (error: unknown) => void;
  readonly onTransportFailure: (error: unknown) => void;
}

export interface OutputRecoveryAttempt {
  readonly token: symbol;
}

export class NodeOutputStream implements AgentEmissionSink {
  readonly identity: ProducerStreamIdentity;
  readonly #cache: NodeReplayCache;
  readonly #permissionHandles: NodeOutputPermissionHandles;
  readonly #permissionRegistrar: NodePermissionHandleRegistrar;
  readonly #onOutputFailure: NodeOutputStreamOptions['onOutputFailure'];
  readonly #onTransportFailure: NodeOutputStreamOptions['onTransportFailure'];
  #sender: ((serialized: string) => void) | null = null;
  #attempt: OutputRecoveryAttempt | null = null;
  #produced = 0;
  #retired = false;

  constructor(options: NodeOutputStreamOptions) {
    const identity = parseProducerStreamIdentity(options.identity);
    if (!identity) throw new TypeError('Invalid producer stream');
    this.identity = Object.freeze(identity);
    this.#cache = options.cache;
    this.#permissionHandles = options.permissionHandles;
    this.#permissionRegistrar = {
      createHandle: () => this.#permissionHandles.createHandle(),
      register: (handle, decision, runId) => {
        this.#assertOpen();
        this.#permissionHandles.register(this.identity, handle, decision, runId);
      },
    };
    this.#onOutputFailure = options.onOutputFailure;
    this.#onTransportFailure = options.onTransportFailure;
    this.#cache.register(this.identity);
  }

  emit(event: AgentProducerEvent): void {
    this.#assertOpen();
    let serialized: string;
    try {
      const sequence = this.#produced + 1;
      // Reserves a safe integer for the first-retained cursor of a fully evicted stream.
      if (sequence > MAX_NODE_OUTPUT_SEQUENCE) throw new RangeError('Producer sequence exhausted');
      serialized = serializeNodeOutputFrame({
        type: 'node-output', stream: this.identity, sequence,
        event: encodeWireProducerEvent(event, this.#permissionRegistrar),
      });
      this.#cache.append(this.identity, sequence, serialized);
      this.#produced = sequence;
    } catch (error) {
      let failure = error;
      try {
        this.retire();
      } catch (cleanupError) {
        failure = new AggregateError([error, cleanupError], 'Producer output and retirement failed', { cause: error });
      }
      notifyFailure(this.#onOutputFailure, failure);
      throw error;
    }
    const attempt = this.#attempt;
    try {
      this.#sender?.(serialized);
    } catch (error) {
      if (attempt && this.suspend(attempt)) notifyFailure(this.#onTransportFailure, error);
    }
  }

  beginRecovery(): OutputRecoveryAttempt | null {
    if (this.#retired) return null;
    this.#sender = null;
    this.#attempt = Object.freeze({ token: Symbol('output-recovery') });
    return this.#attempt;
  }

  suspend(attempt: OutputRecoveryAttempt): boolean {
    if (this.#retired || this.#attempt === null || attempt !== this.#attempt) return false;
    this.#sender = null;
    this.#attempt = null;
    return true;
  }

  /** Binds live delivery only after the caller synchronously catches up to the produced watermark. */
  resumeLive(attempt: OutputRecoveryAttempt, throughSequence: number, sender: (serialized: string) => void): boolean {
    if (this.#retired || this.#attempt === null || attempt !== this.#attempt) return false;
    this.#sender = null;
    if (throughSequence !== this.#produced) return false;
    this.#sender = sender;
    return true;
  }

  /** Invalidates the publisher grant; physical disconnects suspend without discarding output. */
  retire(): void {
    if (this.#retired) return;
    this.#retired = true;
    this.#sender = null;
    this.#attempt = null;
    try {
      this.#cache.retire(this.identity);
    } finally {
      this.#permissionHandles.retire(this.identity);
    }
  }

  get producedSequence(): number {
    return this.#produced;
  }

  #assertOpen(): void {
    if (this.#retired) throw new Error('Producer output stream is retired');
  }
}

function notifyFailure(observer: (error: unknown) => void, error: unknown): void {
  try {
    observer(error);
  } catch {
    // Observer failures cannot change local emission's outcome.
  }
}
