import type { AgentEmissionSink, AgentProducerEvent, ProducerStreamIdentity } from '@garcon/server-agent-interface';
import { NodeOutputEncoder, type NodeOutputPermissionHandles } from './output-encoder.js';
import type { NodeReplayCache } from './replay-cache.js';

export type { NodeOutputPermissionHandles } from './output-encoder.js';

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
  readonly #encoder: NodeOutputEncoder;
  #sender: ((serialized: string) => void) | null = null;
  #attempt: OutputRecoveryAttempt | null = null;

  constructor(options: NodeOutputStreamOptions) {
    const { cache, onTransportFailure } = options;
    this.#encoder = new NodeOutputEncoder({ ...options,
      accept: (serialized, sequence) => cache.append(this.identity, sequence, serialized),
      retire: () => {
        this.#sender = null;
        this.#attempt = null;
        cache.retire(this.identity);
      },
      accepted: (serialized) => {
        const attempt = this.#attempt;
        try { this.#sender?.(serialized); }
        catch (error) {
          if (attempt && this.suspend(attempt)) {
            try { onTransportFailure(error); } catch { /* Observer failures cannot reject retained output. */ }
          }
        }
      },
    });
    cache.register(this.identity);
  }

  get identity(): ProducerStreamIdentity { return this.#encoder.identity; }
  get producedSequence(): number { return this.#encoder.producedSequence; }

  emit(event: AgentProducerEvent): void { this.#encoder.emit(event); }
  forOperation(isRunLive: (runId: string) => boolean): AgentEmissionSink { return this.#encoder.forOperation(isRunLive); }

  beginRecovery(): OutputRecoveryAttempt | null {
    if (this.#encoder.retired) return null;
    this.#sender = null;
    this.#attempt = Object.freeze({ token: Symbol('output-recovery') });
    return this.#attempt;
  }

  suspend(attempt: OutputRecoveryAttempt): boolean {
    if (this.#encoder.retired || this.#attempt === null || attempt !== this.#attempt) return false;
    this.#sender = null;
    this.#attempt = null;
    return true;
  }

  /** Binds live delivery only after the caller synchronously catches up to the produced watermark. */
  resumeLive(attempt: OutputRecoveryAttempt, throughSequence: number, sender: (serialized: string) => void): boolean {
    if (this.#encoder.retired || this.#attempt === null || attempt !== this.#attempt) return false;
    this.#sender = null;
    if (throughSequence !== this.producedSequence) return false;
    this.#sender = sender;
    return true;
  }

  /** Invalidates the publisher grant; physical disconnects suspend without discarding output. */
  retire(): void { this.#encoder.retire(); }
}
