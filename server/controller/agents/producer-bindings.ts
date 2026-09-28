import {
  createAgentResourceRef,
  isAgentResourceRef,
  type AgentIntegration,
  type AgentProducerBinding,
  type AgentProducerNotification,
  type AgentRunFailureDetail,
} from '@garcon/server-agent-interface';
import type { TranscriptProducerLease } from '../ledger/service.js';

export type LaunchSettledEvent = Extract<AgentProducerNotification['event'], { readonly type: 'launch-settled' }>;

export class ProducerBindings {
  readonly #leases = new WeakMap<TranscriptProducerLease, Promise<AgentProducerBinding>>();
  readonly #routes = new Map<string, {
    readonly chatId: string;
    readonly lease: TranscriptProducerLease;
    readonly binding: AgentProducerBinding;
  }>();
  readonly #subscriptions = new Map<AgentIntegration, () => void>();
  readonly #progress = new Map<string, () => Promise<void>>();

  constructor(
    private readonly onError: (error: unknown) => void,
    private readonly onPublicationFailed: (chatId: string, lease: TranscriptProducerLease, error: AgentRunFailureDetail) => void,
    private readonly onPublicationGap: (chatId: string, lease: TranscriptProducerLease) => void,
    private readonly onLaunchSettled: (
      chatId: string, lease: TranscriptProducerLease, agentId: string, event: LaunchSettledEvent,
    ) => void,
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
        // Matches the route's own reference rather than the integration's live
        // scope, which a remote executor cannot report while a replacement
        // session installs and replays retained events.
        const route = this.#routes.get(binding.id);
        if (!route || route.lease.closed || !isAgentResourceRef(binding, 'producer', route.binding)) return;
        if (event.type === 'publication-failed') {
          try { this.onPublicationFailed(route.chatId, route.lease, event.error); }
          catch (error) { this.onError(error); }
          finally { route.lease.close(); }
          return;
        }
        if (event.type === 'publication-gap') {
          try { this.onPublicationGap(route.chatId, route.lease); }
          catch (error) { this.onError(error); }
          return;
        }
        if (event.type === 'launch-settled') {
          try { this.onLaunchSettled(route.chatId, route.lease, integration.descriptor.id, event); }
          catch (error) { this.onError(error); }
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
    this.#routes.set(binding.id, { chatId, lease, binding });
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
