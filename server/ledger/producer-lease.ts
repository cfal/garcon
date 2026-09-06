import type { AgentProducerEvent, AgentProducerSink } from '@garcon/server-agent-interface';
import { TranscriptSinkClosedError } from './service.js';
import type { TranscriptProducerLease } from './service.js';

export class ProducerLease implements TranscriptProducerLease {
  #closed = false;

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

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.onClose();
  }
}
