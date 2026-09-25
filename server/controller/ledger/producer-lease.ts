import type { AgentProducerEvent, AgentProducerSink } from '@garcon/server-agent-interface';
import { TranscriptSinkClosedError } from './errors.js';
import type { TranscriptProducerLease } from './service.js';

export class ProducerLease implements TranscriptProducerLease {
  #closed = false;
  readonly #closeListeners = new Set<() => void>();

  readonly sink: AgentProducerSink;

  constructor(
    publish: (event: AgentProducerEvent) => void,
    private readonly onClose: () => void,
  ) {
    this.sink = Object.freeze({
      publish: (event: AgentProducerEvent) => {
        if (this.#closed) throw new TranscriptSinkClosedError();
        publish(event);
      },
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  onClosed(listener: () => void): () => void {
    if (this.#closed) listener();
    else this.#closeListeners.add(listener);
    return () => { this.#closeListeners.delete(listener); };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.onClose();
    for (const listener of this.#closeListeners) listener();
    this.#closeListeners.clear();
  }
}
