import type { AgentProducerEvent, AgentProducerSink } from '@garcon/server-agent-interface';
import { TranscriptSinkClosedError } from './errors.js';
import type { AutomationExecutionScope } from '../../../common/automation.js';

export interface TranscriptProducerLease {
  readonly sink: AgentProducerSink;
  publish(event: AgentProducerEvent, scope: AutomationExecutionScope | null): void;
  close(): void;
  readonly closed: boolean;
  onClosed(listener: () => void): () => void;
}

export class ProducerLease implements TranscriptProducerLease {
  #closed = false;
  readonly #closeListeners = new Set<() => void>();

  readonly sink: AgentProducerSink;

  constructor(
    private readonly publishEvent: (event: AgentProducerEvent, scope: AutomationExecutionScope | null) => void,
    private readonly onClose: () => void,
  ) {
    this.sink = Object.freeze({
      publish: (event: AgentProducerEvent) => {
        this.publish(event, null);
      },
    });
  }

  publish(event: AgentProducerEvent, scope: AutomationExecutionScope | null): void {
    if (this.#closed) throw new TranscriptSinkClosedError();
    this.publishEvent(event, scope);
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
