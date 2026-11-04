import type { AutomationTurnKey } from '../../../common/automation.js';
import { AgentCallError } from '@garcon/server-agent-interface';
import { createLogger } from '../../common/log.js';

export type AutomationMutation = 'input' | 'steer' | 'queue' | 'control-input'
  | 'stop' | 'delete' | 'execution-settings' | 'project' | 'view-replaced';

export interface AutomationControlLease {
  readonly key: AutomationTurnKey;
  readonly revoked: AbortSignal;
  readonly actorRevoked: AbortSignal;
  release(): void;
}

export interface AutomationRevocation {
  readonly key: AutomationTurnKey;
  readonly action: AutomationMutation;
}

const logger = createLogger('automation:lifecycle');

export class AutomationLifecycle {
  readonly #leases = new Map<string, { lease: AutomationControlLease; cancellation: AbortController }>();
  readonly #listeners = new Set<(event: AutomationRevocation) => void>();
  readonly #failure = new AbortController();

  acquire(key: AutomationTurnKey): AutomationControlLease {
    this.#failure.signal.throwIfAborted();
    if (this.#leases.has(key.chatId)) throw new Error('Chat already has an automation control lease');
    if (this.#leases.size >= 256) throw new Error('Automation control lease capacity exhausted');
    const cancellation = new AbortController();
    const lease: AutomationControlLease = Object.freeze({
      key: Object.freeze({ ...key }),
      revoked: AbortSignal.any([cancellation.signal, this.#failure.signal]),
      actorRevoked: cancellation.signal,
      release: () => {
        if (this.#leases.get(key.chatId)?.lease === lease) this.#leases.delete(key.chatId);
      },
    });
    this.#leases.set(key.chatId, { lease, cancellation });
    return lease;
  }

  owns(lease: AutomationControlLease): boolean {
    return !lease.revoked.aborted && this.ownsControl(lease);
  }

  ownsControl(lease: AutomationControlLease): boolean {
    return !lease.actorRevoked.aborted && this.#leases.get(lease.key.chatId)?.lease === lease;
  }

  observe(chatId: string, action: AutomationMutation, source?: AutomationControlLease): void {
    const current = this.#leases.get(chatId);
    if (!current || current.lease === source || current.cancellation.signal.aborted) return;
    current.cancellation.abort(new AgentCallError('not-dispatched', `Automation control was revoked by ${action}`));
    for (const listener of this.#listeners) {
      try {
        listener({ key: current.lease.key, action });
      } catch (error) {
        // A broken observer fences automation, never the actor taking control.
        this.#failure.abort(new AgentCallError('not-dispatched', 'Automation lifecycle observer failed'));
        logger.error('Revocation observer failed', error);
      }
    }
  }

  subscribe(listener: (event: AutomationRevocation) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
}
