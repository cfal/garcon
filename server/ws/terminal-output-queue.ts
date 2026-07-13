import type { TerminalStreamServerMessage } from '../../common/terminal.js';

export const TERMINAL_STREAM_MAX_PENDING_MESSAGES = 256;
export const TERMINAL_STREAM_MAX_PENDING_BYTES = 512 * 1024;
export const TERMINAL_STREAM_MAX_PENDING_MESSAGES_PER_SESSION = 64;
export const TERMINAL_STREAM_MAX_PENDING_BYTES_PER_SESSION = 128 * 1024;

const CONTROL_QUEUE_KEY = '\u0000control';

export interface SerializedTerminalMessage {
  payload: string;
  byteLength: number;
}

interface TerminalMessageQueue {
  messages: SerializedTerminalMessage[];
  byteLength: number;
}

export function serializeTerminalMessage(
  message: TerminalStreamServerMessage,
): SerializedTerminalMessage {
  const payload = JSON.stringify(message);
  return { payload, byteLength: Buffer.byteLength(payload, 'utf8') };
}

// Rotates one pending message per terminal so a noisy PTY cannot monopolize a drain cycle.
export class TerminalOutputQueue {
  readonly #queues = new Map<string, TerminalMessageQueue>();
  readonly #queueOrder: string[] = [];
  #nextQueueIndex = 0;
  #pendingMessages = 0;
  #pendingBytes = 0;
  #backpressured = false;

  get shouldEnqueue(): boolean {
    return this.#backpressured || this.#pendingMessages > 0;
  }

  get isBackpressured(): boolean {
    return this.#backpressured;
  }

  enqueue(
    message: TerminalStreamServerMessage,
    pending: SerializedTerminalMessage,
  ): 'queued' | 'overflow' {
    const key = this.#queueKey(message);
    const existing = this.#queues.get(key);
    const queue = existing ?? { messages: [], byteLength: 0 };
    if (
      this.#pendingMessages >= TERMINAL_STREAM_MAX_PENDING_MESSAGES ||
      this.#pendingBytes + pending.byteLength >
        TERMINAL_STREAM_MAX_PENDING_BYTES ||
      queue.messages.length >=
        TERMINAL_STREAM_MAX_PENDING_MESSAGES_PER_SESSION ||
      queue.byteLength + pending.byteLength >
        TERMINAL_STREAM_MAX_PENDING_BYTES_PER_SESSION
    ) {
      return 'overflow';
    }
    if (!existing) {
      this.#queues.set(key, queue);
      this.#queueOrder.push(key);
    }
    queue.messages.push(pending);
    queue.byteLength += pending.byteLength;
    this.#pendingMessages += 1;
    this.#pendingBytes += pending.byteLength;
    return 'queued';
  }

  next(): SerializedTerminalMessage | null {
    if (this.#queueOrder.length === 0) return null;
    if (this.#nextQueueIndex >= this.#queueOrder.length)
      this.#nextQueueIndex = 0;
    const key = this.#queueOrder[this.#nextQueueIndex];
    const queue = this.#queues.get(key);
    const pending = queue?.messages.shift();
    if (!queue || !pending) {
      this.#queues.delete(key);
      this.#queueOrder.splice(this.#nextQueueIndex, 1);
      return this.next();
    }
    queue.byteLength -= pending.byteLength;
    this.#pendingMessages -= 1;
    this.#pendingBytes -= pending.byteLength;
    if (queue.messages.length === 0) {
      this.#queues.delete(key);
      this.#queueOrder.splice(this.#nextQueueIndex, 1);
      if (this.#nextQueueIndex >= this.#queueOrder.length)
        this.#nextQueueIndex = 0;
    } else {
      this.#nextQueueIndex =
        (this.#nextQueueIndex + 1) % this.#queueOrder.length;
    }
    return pending;
  }

  markBackpressured(): void {
    this.#backpressured = true;
  }

  markDrained(): void {
    this.#backpressured = false;
  }

  clear(): void {
    this.#queues.clear();
    this.#queueOrder.length = 0;
    this.#nextQueueIndex = 0;
    this.#pendingMessages = 0;
    this.#pendingBytes = 0;
    this.#backpressured = false;
  }

  #queueKey(message: TerminalStreamServerMessage): string {
    if ('terminalId' in message && message.terminalId)
      return message.terminalId;
    if (
      message.type === 'terminal-attached' ||
      message.type === 'terminal-status'
    ) {
      return message.terminal.terminalId;
    }
    return CONTROL_QUEUE_KEY;
  }
}
