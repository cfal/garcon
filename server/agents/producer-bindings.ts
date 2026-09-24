import {
  createAgentResourceRef,
  isAgentResourceRef,
  type AgentIntegration,
  type AgentProducerBinding,
  type AgentRunFailureDetail,
} from '@garcon/server-agent-interface';
import type { TranscriptProducerLease } from '../ledger/service.js';

export class ProducerBindings {
  readonly #leases = new WeakMap<TranscriptProducerLease, Promise<AgentProducerBinding>>();
  readonly #routes = new Map<string, { readonly chatId: string; readonly lease: TranscriptProducerLease }>();
  readonly #subscriptions = new Map<AgentIntegration, () => void>();
  readonly #progress = new Map<string, () => Promise<void>>();

  constructor(
    private readonly onError: (error: unknown) => void,
    private readonly onPublicationFailed: (chatId: string, lease: TranscriptProducerLease, error: AgentRunFailureDetail) => void,
  ) {}

  async bind(integration: AgentIntegration, chatId: string, lease: TranscriptProducerLease): Promise<AgentProducerBinding> {
    if (lease.closed) throw new Error('Producer closed during binding');
    const existing = this.#leases.get(lease);
    if (existing) {
      const binding = await existing;
      if (lease.closed) throw new Error('Producer closed during binding');
      return binding;
    }
    if (!this.#subscriptions.has(integration)) {
      const unsubscribe = integration.producers.subscribe(({ binding, event }) => {
        if (!isAgentResourceRef(binding, 'producer', integration.producers.scope)) return;
        const route = this.#routes.get(binding.id);
        if (!route || route.lease.closed) return;
        if (event.type === 'publication-failed') {
          try { this.onPublicationFailed(route.chatId, route.lease, event.error); }
          catch (error) { this.onError(error); }
          finally { route.lease.close(); }
          return;
        }
        if (event.type === 'started') {
          const started = this.#progress.get(event.runId);
          this.#progress.delete(event.runId);
          if (started) void started().catch(this.onError);
        } else {
          if (event.type === 'run-ended') this.#progress.delete(event.runId);
          try {
            route.lease.sink.publish(event);
          } catch (error) {
            this.onError(error);
          }
        }
      });
      this.#subscriptions.set(integration, unsubscribe);
    }
    const binding = createAgentResourceRef(integration.producers.scope, 'producer');
    this.#routes.set(binding.id, { chatId, lease });
    const registered = integration.producers.bind({ binding, chatId }).then(() => binding);
    this.#leases.set(lease, registered);
    lease.onClosed(() => {
      this.#routes.delete(binding.id);
      this.#leases.delete(lease);
      void registered.then(() => integration.producers.close(binding)).catch(this.onError);
    });
    try {
      await registered;
      if (lease.closed) throw new Error('Producer closed during binding');
      return binding;
    } catch (error) {
      this.#routes.delete(binding.id);
      this.#leases.delete(lease);
      throw error;
    }
  }

  onStarted(runId: string, callback: () => Promise<void>): void {
    this.#progress.set(runId, callback);
  }

  forgetRun(runId: string): void { this.#progress.delete(runId); }
}
