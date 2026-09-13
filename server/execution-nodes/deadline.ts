import { MAX_TEXT_GENERATION_TIMEOUT_MS } from '@garcon/server-agent-interface';
import { SuspendAwareLeaseClock, type LeaseClock } from '../execution-node/lease-clock.js';

export const MAX_NODE_REQUEST_TIMEOUT_MS = MAX_TEXT_GENERATION_TIMEOUT_MS;
const NODE_REPLY_ALLOWANCE_MS = 250;

export function isNodeRequestTimeout(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= MAX_NODE_REQUEST_TIMEOUT_MS;
}

/** Carries a decreasing local budget; wire hops carry durations, never another host's clock. */
export class NodeDeadline {
  readonly #clock: LeaseClock;
  readonly #expiresAt: number;
  #remainingMs: number;
  #lastRead: number;

  constructor(durationMs: number, clock: LeaseClock = new SuspendAwareLeaseClock()) {
    if (!Number.isSafeInteger(durationMs) || durationMs < 1) throw new TypeError('Invalid node deadline');
    this.#clock = clock;
    const reading = clock.read();
    this.#lastRead = reading.elapsedMs;
    this.#expiresAt = reading.elapsedMs + durationMs;
    this.#remainingMs = reading.discontinuity || !Number.isFinite(this.#expiresAt) || reading.elapsedMs < 0 ? 0 : durationMs;
  }

  /** Reserves a bounded part of each incoming budget for the reply; caller expiry remains authoritative. */
  static receive(timeoutMs: number, clock?: LeaseClock): NodeDeadline {
    if (!isNodeRequestTimeout(timeoutMs)) throw new TypeError('Invalid node request timeout');
    const replyAllowance = Math.min(NODE_REPLY_ALLOWANCE_MS, Math.floor(timeoutMs / 10));
    return new NodeDeadline(timeoutMs - replyAllowance, clock);
  }

  get remainingMs(): number {
    if (this.#remainingMs === 0) return 0;
    const reading = this.#clock.read();
    if (reading.discontinuity || !Number.isFinite(reading.elapsedMs) || reading.elapsedMs < this.#lastRead) {
      this.#remainingMs = 0;
    } else {
      this.#remainingMs = Math.min(this.#remainingMs, Math.max(0, Math.floor(this.#expiresAt - reading.elapsedMs)));
      this.#lastRead = reading.elapsedMs;
    }
    return this.#remainingMs;
  }
}
