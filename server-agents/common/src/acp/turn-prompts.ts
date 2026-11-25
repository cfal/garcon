import type { AgentSteerResult } from '@garcon/server-agent-interface';
import { AcpRpcError } from './errors.js';
import type { AcpSteeringProtocol } from './policy.js';
import type { AcpSessionPromptResult } from './protocol.js';
import { humanizeError } from './runtime-helpers.js';
import type { AcpReply } from './transport.js';

type PromptReply = AcpReply<AcpSessionPromptResult>;
type OnReply = (reply: PromptReply) => void;
type Send = (onReply: OnReply) => Promise<AcpSessionPromptResult>;
type Decide = (result: AgentSteerResult) => void;

interface TurnPromptEvents {
  steering?: AcpSteeringProtocol;
  takeFailure(): string | null;
  onBoundary(failure: string | null): void;
  onSteerable(): void;
}

interface Overlap {
  readonly predecessor: symbol;
  acknowledge(): void;
  acknowledged: boolean;
  awaitingLateReply: boolean;
}

// One Garcon turn can span several native prompts, but only one overlap can await attribution.
export class AcpTurnPrompts {
  readonly #open = new Set<symbol>();
  readonly #drained = Promise.withResolvers<void>();
  #closed = false;
  #failure: Error | null = null;
  #slot: Promise<void> | null = null;
  #overlap: Overlap | null = null;

  constructor(private readonly events: TurnPromptEvents) {}

  get closed(): boolean { return this.#closed || this.#failure !== null; }
  get awaitingLateReply(): boolean { return this.#overlap?.awaitingLateReply === true; }

  run(initial: Send): Promise<void> {
    this.#track(initial);
    return this.#drained.promise;
  }

  // The tail holds the run open through preparation, write confirmation, and the delivery decision.
  async withSteerSlot(deliver: () => Promise<AgentSteerResult>): Promise<AgentSteerResult> {
    const previous = this.#slot;
    const slot = Promise.withResolvers<void>();
    this.#slot = slot.promise;
    try {
      if (previous) await previous;
      return await deliver();
    } finally {
      if (this.#slot === slot.promise) this.#slot = null;
      slot.resolve();
      this.#closeIfDrained();
    }
  }

  steer(send: (onSent: () => void, onReply: OnReply) => Promise<AcpSessionPromptResult>, timeoutMs: number): Promise<AgentSteerResult> {
    const predecessor = this.#open.values().next().value;
    const decision = Promise.withResolvers<AgentSteerResult>();
    let written = false;
    const overlap: Overlap | null = predecessor ? {
      predecessor, acknowledged: false, awaitingLateReply: false,
      acknowledge() {
        this.acknowledged = true;
        if (written) decision.resolve({ kind: 'accepted' });
      },
    } : null;
    this.#overlap = overlap;
    // A reserved steer written after a clean drain starts a new native prompt of the same run.
    const onSent = () => {
      written = true;
      if (!overlap || overlap.acknowledged) decision.resolve({ kind: 'accepted' });
    };
    this.#track(onReply => send(onSent, onReply), decision.resolve, overlap);
    const timer = setTimeout(() => {
      if (overlap) overlap.awaitingLateReply = true;
      decision.resolve(unconfirmed(`The agent did not confirm the steering input within ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    return decision.promise.finally(() => clearTimeout(timer));
  }

  #track(send: Send, decide?: Decide, overlapAtSend: Overlap | null = null): void {
    const id = Symbol();
    this.#open.add(id);
    const onReply: OnReply = reply => {
      if (!this.#open.delete(id)) return;
      const overlap = this.#overlap;
      let outcome: AgentSteerResult;
      try {
        const successor = overlap?.predecessor === id ? overlap : null;
        outcome = this.#settleReply(reply, overlapAtSend, successor);
      } catch (error) {
        const message = humanizeError(error);
        this.#failure ??= new Error(message);
        outcome = unconfirmed(message);
      }
      decide?.(outcome);
      if (outcome.kind !== 'rejected' && overlap && this.#open.has(overlap.predecessor)) {
        overlap.awaitingLateReply = true;
      } else {
        this.#overlap = null;
      }
      this.#closeIfDrained();
      if (this.#open.size && overlap?.awaitingLateReply && !this.#overlap) this.events.onSteerable();
    };
    void send(onReply).catch((error: Error) => onReply({ error }));
  }

  #settleReply(reply: PromptReply, overlapAtSend: Overlap | null, successor: Overlap | null): AgentSteerResult {
    if ('error' in reply && overlapAtSend && !overlapAtSend.acknowledged
      && reply.error instanceof AcpRpcError && this.events.steering?.refused(reply.error)) {
      return { kind: 'rejected', reason: 'provider-rejected', message: reply.error.message };
    }

    const candidate = this.events.takeFailure();
    const error = 'error' in reply ? humanizeError(reply.error) : candidate;
    if (successor && !error && 'result' in reply && this.events.steering?.likelySuperseded(reply.result)) {
      successor.acknowledge();
    } else if (!successor || this.#open.size > 0 || error) {
      // A displaced predecessor's late reply must not replace its successor's final response.
      this.events.onBoundary(this.#failure ? null : error);
    }
    if (error) this.#failure ??= new Error(error);
    if (!this.#failure && 'result' in reply && reply.result?.stopReason && reply.result.stopReason !== 'cancelled') {
      return { kind: 'accepted' };
    }
    return unconfirmed(error ?? 'The prompt ended without confirming the steering input');
  }

  #closeIfDrained(): void {
    if (this.#closed || this.#open.size || this.#slot) return;
    this.#closed = true;
    if (this.#failure) this.#drained.reject(this.#failure);
    else this.#drained.resolve();
  }
}

function unconfirmed(message: string): AgentSteerResult {
  return { kind: 'failed', outcome: 'unknown', message };
}
