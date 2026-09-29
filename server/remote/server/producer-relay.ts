import type {
  AgentIntegration,
  AgentProducerBinding,
  AgentProducerNotification,
} from '@garcon/server-agent-interface';
import type { AgentProducerFrame, ProducerAcknowledgement } from '../transport/rpc-protocol.js';
import { SESSION_MESSAGE_BYTES } from '../transport/session-socket.js';

// Matches the controller's reconnect grace and VS Code Remote's reconnection
// grace; after it, the controller fails the run and this worker detaches the
// binding. https://github.com/microsoft/vscode/blob/f39c7109bf651845855cbef5af2e91b2c9bd0a74/src/vs/base/parts/ipc/common/ipc.net.ts#L301-L308
const PRODUCER_RESUME_GRACE_MS = 3 * 60 * 60 * 1000;
// A controller resumes every binding it still holds while installing a new
// session, so bindings still suspended this long after one starts belong to a
// controller that restarted or gave up. VS Code shortens its grace the same way
// once another client connects: https://github.com/microsoft/vscode/blob/f39c7109bf651845855cbef5af2e91b2c9bd0a74/src/vs/server/node/remoteExtensionHostAgentServer.ts#L381-L391
const PRODUCER_SUPERSEDED_GRACE_MS = 5 * 60 * 1000;
// Bounds worker memory across all bindings. Replay is paced by the session
// queue, so the backlog need not fit that queue.
const RETAINED_BYTES = 32 * 1024 * 1024;
const PUMP_RETRY_MS = 10;

export interface ProducerRelaySession {
  // Returns false when the session cannot take the frame now; the relay keeps
  // it and offers it again as the session drains.
  offer(payload: string): boolean;
}

interface RetainedFrame {
  readonly seq: number;
  // Relay-wide publication order, which the pump preserves across bindings.
  readonly order: number;
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
  // Leading retained frames already handed to `session`.
  sent: number;
  retainedBytes: number;
  session: ProducerRelaySession | null;
  grace: { readonly timer: ReturnType<typeof setTimeout>; readonly deadline: number } | null;
}

interface UnsentFrame {
  readonly binding: RelayedBinding;
  readonly session: ProducerRelaySession;
  readonly frame: RetainedFrame;
}

export interface ProducerRelayOptions {
  readonly graceMs?: number;
  readonly supersededGraceMs?: number;
  readonly retainedBytes?: number;
}

// Delivers producer notifications for one worker process across controller
// sessions, following VS Code's persistent protocol: frames stay retained until
// acknowledged, and a resumed binding resends every unacknowledged frame ahead
// of newer output (https://github.com/microsoft/vscode/blob/f39c7109bf651845855cbef5af2e91b2c9bd0a74/src/vs/base/parts/ipc/common/ipc.net.ts#L974-L989).
// VS Code's socket buffers without limit; the session queue here is bounded, so
// frames reach it in publication order only as fast as it drains. A lost
// session suspends its bindings for a grace period instead of detaching them.
// When the retention budget overflows, the oldest row batches are dropped and
// the controller sees the skipped sequence numbers as a delivery gap.
export class ProducerRelay {
  readonly #bindings = new Map<string, RelayedBinding>();
  readonly #subscriptions = new Map<AgentIntegration, () => void>();
  readonly #graceMs: number;
  readonly #supersededGraceMs: number;
  readonly #retainedLimit: number;
  #retainedBytes = 0;
  #published = 0;
  #pumping = false;
  #pumpRetry: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ProducerRelayOptions = {}) {
    this.#graceMs = options.graceMs ?? PRODUCER_RESUME_GRACE_MS;
    this.#supersededGraceMs = options.supersededGraceMs ?? PRODUCER_SUPERSEDED_GRACE_MS;
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
      integration, ref, seq: 0, retained: [], sent: 0, retainedBytes: 0, session, grace: null,
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
      binding.sent = 0;
      this.#expireWithin(binding, this.#graceMs);
    }
  }

  // Called when a new controller session starts; it never extends a deadline.
  shortenSuspendedGrace(): void {
    for (const binding of this.#bindings.values()) {
      if (!binding.session) this.#expireWithin(binding, this.#supersededGraceMs);
    }
  }

  // Frames that do not fit the session queue now follow the reply.
  resume(
    session: ProducerRelaySession,
    integration: AgentIntegration,
    requests: readonly { readonly binding: AgentProducerBinding; readonly acknowledgedSeq: number }[],
  ): string[] {
    const resumed: string[] = [];
    for (const { binding: ref, acknowledgedSeq } of requests) {
      const binding = this.#bindings.get(ref.id);
      if (binding?.integration !== integration) continue;
      if (binding.grace) clearTimeout(binding.grace.timer);
      binding.grace = null;
      binding.session = session;
      this.#release(binding, acknowledgedSeq);
      binding.sent = 0;
      resumed.push(ref.id);
    }
    this.#pump();
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
      if (binding.grace) clearTimeout(binding.grace.timer);
    }
    this.#bindings.clear();
    this.#retainedBytes = 0;
    if (this.#pumpRetry) clearTimeout(this.#pumpRetry);
    this.#pumpRetry = null;
  }

  #publish(integration: AgentIntegration, notification: AgentProducerNotification): void {
    const binding = this.#bindings.get(notification.binding.id);
    if (binding?.integration !== integration) return;
    binding.seq += 1;
    this.#published += 1;
    const payload = encodeProducerFrame(binding.seq, notification);
    const frame: RetainedFrame = {
      seq: binding.seq,
      order: this.#published,
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
    if (binding.session) this.#pump();
  }

  // Offers unsent frames in publication order until a session refuses one,
  // then retries as the session queue drains.
  #pump(): void {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      for (let next = this.#nextUnsent(); next; next = this.#nextUnsent()) {
        const accepted = next.session.offer(next.frame.payload);
        // A session that fails while taking the frame has already suspended the binding.
        if (next.binding.session !== next.session) continue;
        if (!accepted) {
          if (!this.#pumpRetry) {
            this.#pumpRetry = setTimeout(() => { this.#pumpRetry = null; this.#pump(); }, PUMP_RETRY_MS);
            this.#pumpRetry.unref?.();
          }
          return;
        }
        next.binding.sent += 1;
      }
    } finally { this.#pumping = false; }
  }

  // The earliest-published frame not yet handed to its binding's session.
  #nextUnsent(): UnsentFrame | null {
    let next: UnsentFrame | null = null;
    for (const binding of this.#bindings.values()) {
      const frame = binding.retained[binding.sent];
      if (!binding.session || !frame) continue;
      if (!next || frame.order < next.frame.order) next = { binding, session: binding.session, frame };
    }
    return next;
  }

  // Drops from the largest backlog first; the newest frame is kept even when it
  // alone overshoots the budget, which bounds the overshoot by one frame.
  #dropOldestRows(newest: RetainedFrame): boolean {
    const backlogs = [...this.#bindings.values()].sort((left, right) => right.retainedBytes - left.retainedBytes);
    for (const binding of backlogs) {
      const index = binding.retained.findIndex((frame) => frame.droppable && frame !== newest);
      if (index < 0) continue;
      const [dropped] = binding.retained.splice(index, 1);
      if (index < binding.sent) binding.sent -= 1;
      binding.retainedBytes -= dropped!.bytes;
      this.#retainedBytes -= dropped!.bytes;
      return true;
    }
    return false;
  }

  #release(binding: RelayedBinding, seq: number): void {
    const firstKept = binding.retained.findIndex((frame) => frame.seq > seq);
    const released = binding.retained.splice(0, firstKept < 0 ? binding.retained.length : firstKept);
    for (const frame of released) {
      binding.retainedBytes -= frame.bytes;
      this.#retainedBytes -= frame.bytes;
    }
    binding.sent = Math.max(0, binding.sent - released.length);
  }

  #expireWithin(binding: RelayedBinding, graceMs: number): void {
    const deadline = performance.now() + graceMs;
    if (binding.grace && binding.grace.deadline <= deadline) return;
    if (binding.grace) clearTimeout(binding.grace.timer);
    const timer = setTimeout(() => this.#expire(binding), graceMs);
    timer.unref?.();
    binding.grace = { timer, deadline };
  }

  #expire(binding: RelayedBinding): void {
    if (this.#bindings.get(binding.ref.id) !== binding || binding.session) return;
    this.#forget(binding);
    binding.integration.producers.detach(binding.ref);
  }

  #forget(binding: RelayedBinding): void {
    if (binding.grace) clearTimeout(binding.grace.timer);
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
