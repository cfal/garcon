import {
  encodeWireProducerEvent, MAX_NODE_OUTPUT_SEQUENCE, parseProducerStreamIdentity, serializeNodeOutputFrame,
  type AgentEmissionSink, type AgentPermissionResponseCapability, type AgentProducerEvent,
  type NodePermissionHandleRegistrar, type ProducerStreamIdentity,
} from '@garcon/server-agent-interface';

export interface NodeOutputPermissionHandles {
  createHandle(): string;
  /** Applies the registrar's atomic, registry-lifetime unique binding contract to this stream. */
  register(stream: ProducerStreamIdentity, handle: string, decision: AgentPermissionResponseCapability, runId: string,
    isRunLive?: (runId: string) => boolean): void;
  /** Invalidates all authority for exactly this stream synchronously without throwing. */
  retire(stream: ProducerStreamIdentity): void;
}

export interface NodeOutputEncoderOptions {
  readonly identity: ProducerStreamIdentity;
  readonly permissionHandles: NodeOutputPermissionHandles;
  accept(serialized: string, sequence: number): void;
  retire(): void;
  onOutputFailure(error: unknown): void;
  /** Runs after admission advances the sequence, allowing inline delivery to reenter safely. */
  accepted?(serialized: string): void;
}

/** Assigns transport sequences only to immutable records admitted by the owning sink. */
export class NodeOutputEncoder implements AgentEmissionSink {
  readonly identity: ProducerStreamIdentity;
  readonly #permissionRegistrar: NodePermissionHandleRegistrar;
  #produced = 0;
  #retired = false;
  #emitting = false;
  #failureReported = false;

  constructor(private readonly options: NodeOutputEncoderOptions) {
    const identity = parseProducerStreamIdentity(options.identity);
    if (!identity) throw new TypeError('Invalid producer stream');
    this.identity = Object.freeze(identity);
    this.options = Object.freeze({ ...options });
    this.#permissionRegistrar = this.#registrar();
  }

  forOperation(isRunLive: (runId: string) => boolean): AgentEmissionSink {
    this.#assertOpen();
    const registrar = this.#registrar(isRunLive);
    return Object.freeze({ emit: (event: AgentProducerEvent) => this.#emit(event, registrar) });
  }

  emit(event: AgentProducerEvent): void { this.#emit(event, this.#permissionRegistrar); }

  retire(): void {
    if (this.#retired) return;
    this.#retired = true;
    try { this.options.permissionHandles.retire(this.identity); }
    finally { this.options.retire(); }
  }

  get producedSequence(): number { return this.#produced; }
  get retired(): boolean { return this.#retired; }

  #emit(event: AgentProducerEvent, registrar: NodePermissionHandleRegistrar): void {
    this.#assertOpen();
    if (this.#emitting) {
      const error = new Error('Producer output reentered during record admission');
      this.#fail(error);
      throw error;
    }
    this.#emitting = true;
    let serialized: string;
    try {
      const sequence = this.#produced + 1;
      // Reserves a safe integer for the first-retained cursor of a fully evicted stream.
      if (sequence > MAX_NODE_OUTPUT_SEQUENCE) throw new RangeError('Producer sequence exhausted');
      serialized = serializeNodeOutputFrame({ type: 'node-output', stream: this.identity, sequence,
        event: encodeWireProducerEvent(event, registrar) });
      this.#assertOpen();
      this.options.accept(serialized, sequence);
      this.#assertOpen();
      this.#produced = sequence;
    } catch (error) {
      this.#fail(error);
      throw error;
    } finally { this.#emitting = false; }
    try { this.options.accepted?.(serialized); }
    catch (error) { this.#fail(error); throw error; }
  }

  #registrar(isRunLive?: (runId: string) => boolean): NodePermissionHandleRegistrar {
    return {
      createHandle: () => { this.#assertOpen(); return this.options.permissionHandles.createHandle(); },
      register: (handle, decision, runId) => {
        this.#assertOpen();
        this.options.permissionHandles.register(this.identity, handle, decision, runId, isRunLive);
        this.#assertOpen();
      },
    };
  }

  #fail(error: unknown): void {
    if (this.#failureReported) return;
    this.#failureReported = true;
    let failure = error;
    try { this.retire(); }
    catch (cleanupError) {
      failure = new AggregateError([error, cleanupError], 'Producer output and retirement failed', { cause: error });
    }
    try { this.options.onOutputFailure(failure); }
    catch { /* Observer failures cannot change local emission's outcome. */ }
  }

  #assertOpen(): void {
    if (this.#retired) throw new Error('Producer output stream is retired');
  }
}
