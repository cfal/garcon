import {
  BULK_CONTROL_RESERVE_BYTES, BULK_CONTROL_RESERVE_MESSAGES, BULK_QUEUE_BYTES,
  BULK_QUEUE_MESSAGES, RPC_QUEUE_BYTES, RPC_QUEUE_MESSAGES,
} from './limits.js';
import type { RpcLane } from './rpc-lane.js';

export interface MessageQueueLimits {
  readonly bytes: number;
  readonly messages: number;
  readonly bulkBytes: number;
  readonly bulkMessages: number;
  readonly controlBytes: number;
  readonly controlMessages: number;
}

interface LaneQueueSnapshot {
  readonly bytes: number;
  readonly messages: number;
  readonly oldestAgeMs: number;
}

export interface MessageQueueSnapshot {
  readonly total: LaneQueueSnapshot;
  readonly primary: LaneQueueSnapshot;
  readonly bulk: LaneQueueSnapshot;
}

const DEFAULT_LIMITS: MessageQueueLimits = {
  bytes: RPC_QUEUE_BYTES, messages: RPC_QUEUE_MESSAGES,
  bulkBytes: BULK_QUEUE_BYTES, bulkMessages: BULK_QUEUE_MESSAGES,
  controlBytes: BULK_CONTROL_RESERVE_BYTES, controlMessages: BULK_CONTROL_RESERVE_MESSAGES,
};

export class MessageQueueBudget {
  #bytes = 0;
  #messages = 0;
  #bulkBytes = 0;
  #bulkMessages = 0;
  #controlBytes = 0;
  #controlMessages = 0;
  #notifying = false;
  readonly #listeners = new Set<() => void>();
  readonly #queued = { primary: new Set<{ at: number }>(), bulk: new Set<{ at: number }>() };

  constructor(private readonly limits: MessageQueueLimits = DEFAULT_LIMITS) {}

  get queuedBytes(): number { return this.#bytes; }
  get queuedMessages(): number { return this.#messages; }

  snapshot(): MessageQueueSnapshot {
    const now = performance.now();
    const age = (lane: RpcLane) => Math.max(0, Math.round(now - (this.#queued[lane].values().next().value?.at ?? now)));
    const primary = { bytes: this.#bytes - this.#bulkBytes, messages: this.#messages - this.#bulkMessages, oldestAgeMs: age('primary') };
    const bulk = { bytes: this.#bulkBytes, messages: this.#bulkMessages, oldestAgeMs: age('bulk') };
    return { total: { bytes: this.#bytes, messages: this.#messages, oldestAgeMs: Math.max(primary.oldestAgeMs, bulk.oldestAgeMs) }, primary, bulk };
  }

  canAdmit(lane: RpcLane, bytes: number): boolean {
    return this.#bytes + bytes <= this.limits.bytes - this.limits.controlBytes
      && this.#messages < this.limits.messages - this.limits.controlMessages
      && (lane === 'primary' || this.#bulkBytes + bytes <= this.limits.bulkBytes
        && this.#bulkMessages < this.limits.bulkMessages);
  }

  canAdmitControl(bytes: number): boolean {
    return this.#bytes + bytes <= this.limits.bytes && this.#messages < this.limits.messages
      && this.#controlBytes + bytes <= this.limits.controlBytes
      && this.#controlMessages < this.limits.controlMessages;
  }

  reserve(lane: RpcLane, bytes: number): () => void {
    if (!this.canAdmit(lane, bytes)) throw new Error('Message queue budget exhausted');
    return this.#reserve(lane, bytes, false);
  }

  reserveControl(bytes: number): () => void {
    if (!this.canAdmitControl(bytes)) throw new Error('Control queue budget exhausted');
    return this.#reserve('primary', bytes, true);
  }

  onCapacity(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  #reserve(lane: RpcLane, bytes: number, control: boolean): () => void {
    const queued = { at: performance.now() };
    this.#queued[lane].add(queued);
    this.#bytes += bytes;
    this.#messages++;
    if (lane === 'bulk') { this.#bulkBytes += bytes; this.#bulkMessages++; }
    if (control) { this.#controlBytes += bytes; this.#controlMessages++; }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#queued[lane].delete(queued);
      this.#bytes -= bytes;
      this.#messages--;
      if (lane === 'bulk') { this.#bulkBytes -= bytes; this.#bulkMessages--; }
      if (control) { this.#controlBytes -= bytes; this.#controlMessages--; }
      if (this.#notifying) return;
      this.#notifying = true;
      queueMicrotask(() => {
        this.#notifying = false;
        for (const listener of this.#listeners) listener();
      });
    };
  }
}
