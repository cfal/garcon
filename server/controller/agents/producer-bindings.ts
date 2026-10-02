import {
  createAgentResourceRef,
  isAgentResourceRef,
  type AgentIntegration,
  type AgentProducerBinding,
  type AgentProducerNotification,
  type AgentRunFailureDetail,
  type ExecutorCallOptions,
} from '@garcon/server-agent-interface';
import type { TranscriptProducerLease } from '../ledger/service.js';
import { waitAbortably } from '../../common/abortable-wait.js';
import { reconnectTimedOut } from '../../common/executor-disconnect.js';
import { retryAfterSessionLoss } from './session-loss-retry.js';

export type LaunchSettledEvent = Extract<AgentProducerNotification['event'], { readonly type: 'launch-settled' }>;

// A caller joining a registration already under way waits for it only within its
// own dispatch deadline and signal; the registration itself continues.
async function joinWithin<T>(registration: Promise<T>, options: ExecutorCallOptions): Promise<T> {
  if (options.dispatchDeadline === undefined) return options.signal ? waitAbortably(registration, options.signal) : registration;
  const expiry = new AbortController();
  const timer = setTimeout(() => expiry.abort(reconnectTimedOut()), Math.max(0, options.dispatchDeadline - performance.now()));
  try {
    return await waitAbortably(registration, options.signal ? AbortSignal.any([options.signal, expiry.signal]) : expiry.signal);
  } finally {
    clearTimeout(timer);
  }
}

export class ProducerBindings {
  readonly #leases = new WeakMap<TranscriptProducerLease, Promise<AgentProducerBinding>>();
  readonly #routes = new Map<string, {
    readonly chatId: string;
    readonly lease: TranscriptProducerLease;
    readonly binding: AgentProducerBinding;
  }>();
  readonly #subscriptions = new WeakSet<AgentIntegration>();
  readonly #progress = new Map<string, () => Promise<void>>();

  constructor(
    private readonly onError: (error: unknown) => void,
    private readonly onPublicationFailed: (chatId: string, lease: TranscriptProducerLease, error: AgentRunFailureDetail) => void,
    private readonly onPublicationGap: (chatId: string, lease: TranscriptProducerLease) => void,
    private readonly onLaunchSettled: (
      chatId: string, lease: TranscriptProducerLease, agentId: string, event: LaunchSettledEvent,
    ) => void,
    private readonly onSteerable: (chatId: string, lease: TranscriptProducerLease, runId: string) => void,
  ) {}

  async bind(
    integration: AgentIntegration, chatId: string, lease: TranscriptProducerLease, options: ExecutorCallOptions = {},
  ): Promise<AgentProducerBinding> {
    if (lease.closed) throw new Error('Producer closed during binding');
    const existing = this.#leases.get(lease);
    if (existing) {
      const binding = await joinWithin(existing, options);
      if (lease.closed) throw new Error('Producer closed during binding');
      return binding;
    }
    this.#subscribe(integration);
    const registered = retryAfterSessionLoss(() => this.#register(integration, chatId, lease, options), options.signal);
    this.#leases.set(lease, registered);
    lease.onClosed(() => {
      this.#leases.delete(lease);
      void registered.then((binding) => {
        this.#routes.delete(binding.id);
        return integration.producers.close(binding);
      }).catch(this.onError);
    });
    try {
      const binding = await registered;
      if (lease.closed) throw new Error('Producer closed during binding');
      return binding;
    } catch (error) {
      this.#leases.delete(lease);
      throw error;
    }
  }

  onStarted(runId: string, callback: () => Promise<void>): void {
    this.#progress.set(runId, callback);
  }

  forgetRun(runId: string): void { this.#progress.delete(runId); }

  // Each attempt takes a fresh binding ID: a worker that received a binding whose
  // session was then lost keeps it until that session's grace ends.
  async #register(
    integration: AgentIntegration, chatId: string, lease: TranscriptProducerLease, options: ExecutorCallOptions,
  ): Promise<AgentProducerBinding> {
    const binding = createAgentResourceRef(integration.producers.scope, 'producer');
    this.#routes.set(binding.id, { chatId, lease, binding });
    try {
      await integration.producers.bind({ binding, chatId }, options);
      return binding;
    } catch (error) {
      this.#routes.delete(binding.id);
      throw error;
    }
  }

  #subscribe(integration: AgentIntegration): void {
    if (!this.#subscriptions.has(integration)) {
      integration.producers.subscribe(({ binding, event }) => {
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
        if (event.type === 'steerable') {
          try { this.onSteerable(route.chatId, route.lease, event.runId); }
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
      this.#subscriptions.add(integration);
    }
  }
}
