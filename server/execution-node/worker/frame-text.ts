import { NodeWorkerTransportError } from './framing.js';

export type NodeFrameText = string | DeferredNodeFrameText;

/** Retains a bounded snapshot until its deadline can be encoded immediately before submission. */
export class DeferredNodeFrameText {
  readonly maxWireBytes: number;
  readonly retainedBytes: number;
  #source: string | null;
  #prepare: ((source: string) => string) | null;

  constructor(source: string, prepare: (source: string) => string) {
    this.maxWireBytes = Buffer.byteLength(source);
    this.retainedBytes = source.length * 2;
    this.#source = source;
    this.#prepare = prepare;
  }

  materialize(): string {
    if (this.#source === null || this.#prepare === null) throw new NodeWorkerTransportError('NODE_WORKER_PROTOCOL');
    try {
      const text = this.#prepare(this.#source);
      if (!text.length || Buffer.byteLength(text) > this.maxWireBytes) throw new NodeWorkerTransportError('NODE_WORKER_PROTOCOL');
      return text;
    } finally { this.clear(); }
  }

  clear(): void { this.#source = null; this.#prepare = null; }
}

export function materializeNodeFrameText(text: NodeFrameText): string {
  return typeof text === 'string' ? text : text.materialize();
}
