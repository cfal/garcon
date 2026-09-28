import type {
  AgentIntegration,
  AgentProducerBinding,
  AgentProducerNotification,
} from '@garcon/server-agent-interface';
import type { AgentProducerFrame, ProducerAcknowledgement } from '../transport/rpc-protocol.js';
import { SESSION_MESSAGE_BYTES } from '../transport/session-socket.js';

// Matches the controller's reconnect grace; after it, the controller fails the
// run and this worker detaches the binding as before.
export const PRODUCER_RESUME_GRACE_MS = 120_000;
// A full replay must fit a fresh session's 32 MiB send queue with room to spare.
const RETAINED_BYTES = 16 * 1024 * 1024;

export interface ProducerRelaySession {
  send(payload: string): void;
}

interface RetainedFrame {
  readonly seq: number;
  readonly payload: string;
  readonly bytes: number;
  // Only row batches are dropped under pressure; session, permission, and run
  // facts are small and keep the controller's run state coherent.
  readonly droppable: boolean;
}

interface RelayedBinding {
  readonly integration: AgentIntegration;
  readonly ref: AgentProducerBinding;
  seq: number;
  readonly retained: RetainedFrame[];
  retainedBytes: number;
  session: ProducerRelaySession | null;
  grace: ReturnType<typeof setTimeout> | null;
}

export interface ProducerRelayOptions {
  readonly graceMs?: number;
  readonly retainedBytes?: number;
}

// Delivers producer notifications for one worker process across controller
// sessions. Frames stay retained until acknowledged. A lost session suspends
// its bindings for a grace period instead of detaching them, and the next
// session resumes them from the controller's last received frame. When the
// retention budget overflows, the oldest row batches are dropped and the
// controller sees the skipped sequence numbers as a delivery gap.
export class ProducerRelay {
  readonly #bindings = new Map<string, RelayedBinding>();
  readonly #subscriptions = new Map<AgentIntegration, () => void>();
  readonly #graceMs: number;
  readonly #retainedLimit: number;
  #retainedBytes = 0;

  constructor(options: ProducerRelayOptions = {}) {
    this.#graceMs = options.graceMs ?? PRODUCER_RESUME_GRACE_MS;
    this.#retainedLimit = options.retainedBytes ?? RETAINED_BYTES;
  }

  track(integration: AgentIntegration): void {
    if (this.#subscriptions.has(integration)) return;
    this.#subscriptions.set(integration, integration.producers.subscribe((notification) => {
      this.#publish(integration, notification);
    }));
  }

  bind(session: ProducerRelaySession, integration: AgentIntegration, ref: AgentProducerBinding): void {
    this.#bindings.set(ref.id, {
      integration, ref, seq: 0, retained: [], retainedBytes: 0, session, grace: null,
    });
  }

  owns(session: ProducerRelaySession, integration: AgentIntegration, ref: AgentProducerBinding): boolean {
    const binding = this.#bindings.get(ref.id);
    return binding?.integration === integration && binding.session === session;
  }

  close(ref: AgentProducerBinding): void {
    const binding = this.#bindings.get(ref.id);
    if (binding) this.#forget(binding);
  }

  suspend(session: ProducerRelaySession): void {
    for (const binding of this.#bindings.values()) {
      if (binding.session !== session) continue;
      binding.session = null;
      binding.grace = setTimeout(() => this.#expire(binding), this.#graceMs);
      binding.grace.unref?.();
    }
  }

  // Replays retained frames in order before returning, so they precede the reply.
  resume(
    session: ProducerRelaySession,
    integration: AgentIntegration,
    requests: readonly { readonly binding: AgentProducerBinding; readonly acknowledgedSeq: number }[],
  ): string[] {
    const resumed: string[] = [];
    for (const { binding: ref, acknowledgedSeq } of requests) {
      const binding = this.#bindings.get(ref.id);
      if (binding?.integration !== integration) continue;
      if (binding.grace) clearTimeout(binding.grace);
      binding.grace = null;
      binding.session = session;
      this.#release(binding, acknowledgedSeq);
      for (const frame of binding.retained) session.send(frame.payload);
      resumed.push(ref.id);
    }
    return resumed;
  }

  acknowledge(session: ProducerRelaySession, acknowledgements: readonly ProducerAcknowledgement[]): void {
    for (const { bindingId, seq } of acknowledgements) {
      const binding = this.#bindings.get(bindingId);
      if (binding?.session === session) this.#release(binding, seq);
    }
  }

  dispose(): void {
    for (const unsubscribe of this.#subscriptions.values()) unsubscribe();
    this.#subscriptions.clear();
    for (const binding of this.#bindings.values()) {
      if (binding.grace) clearTimeout(binding.grace);
    }
    this.#bindings.clear();
    this.#retainedBytes = 0;
  }

  #publish(integration: AgentIntegration, notification: AgentProducerNotification): void {
    const binding = this.#bindings.get(notification.binding.id);
    if (binding?.integration !== integration) return;
    binding.seq += 1;
    const payload = encodeProducerFrame(binding.seq, notification);
    const frame: RetainedFrame = {
      seq: binding.seq,
      payload,
      bytes: Buffer.byteLength(payload),
      droppable: notification.event.type === 'rows',
    };
    binding.retained.push(frame);
    binding.retainedBytes += frame.bytes;
    this.#retainedBytes += frame.bytes;
    while (this.#retainedBytes > this.#retainedLimit) {
      if (!this.#dropOldestRows(frame)) break;
    }
    if (!binding.session) return;
    try {
      binding.session.send(payload);
    } catch {
      // The failed session suspends this binding; the frame stays retained for resume.
    }
  }

  // Drops from the largest backlog first; the newest frame is kept even when it
  // alone overshoots the budget, which bounds the overshoot by one frame.
  #dropOldestRows(newest: RetainedFrame): boolean {
    const backlogs = [...this.#bindings.values()].sort((left, right) => right.retainedBytes - left.retainedBytes);
    for (const binding of backlogs) {
      const index = binding.retained.findIndex((frame) => frame.droppable && frame !== newest);
      if (index < 0) continue;
      const [dropped] = binding.retained.splice(index, 1);
      binding.retainedBytes -= dropped!.bytes;
      this.#retainedBytes -= dropped!.bytes;
      return true;
    }
    return false;
  }

  #release(binding: RelayedBinding, seq: number): void {
    while (binding.retained.length > 0 && binding.retained[0]!.seq <= seq) {
      const frame = binding.retained.shift()!;
      binding.retainedBytes -= frame.bytes;
      this.#retainedBytes -= frame.bytes;
    }
  }

  #expire(binding: RelayedBinding): void {
    if (this.#bindings.get(binding.ref.id) !== binding || binding.session) return;
    this.#forget(binding);
    binding.integration.producers.detach(binding.ref);
  }

  #forget(binding: RelayedBinding): void {
    if (binding.grace) clearTimeout(binding.grace);
    this.#bindings.delete(binding.ref.id);
    this.#retainedBytes -= binding.retainedBytes;
  }
}

function encodeProducerFrame(seq: number, notification: AgentProducerNotification): string {
  const payload = JSON.stringify({ type: 'producer', seq, notification } satisfies AgentProducerFrame);
  if (Buffer.byteLength(payload) <= SESSION_MESSAGE_BYTES) return payload;
  return JSON.stringify({
    type: 'producer', seq, notification: {
      binding: notification.binding,
      event: { type: 'publication-failed', error: {
        code: 'OUTCOME_UNKNOWN',
        message: 'Provider output exceeds the executor message size limit. Native history may contain additional output.',
      } },
    },
  } satisfies AgentProducerFrame);
}
