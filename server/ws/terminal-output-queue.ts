import type { TerminalStreamServerMessage } from "../../common/terminal.js";

export const TERMINAL_STREAM_MAX_PENDING_MESSAGES = 256;
export const TERMINAL_STREAM_MAX_PENDING_BYTES = 16 * 1024 * 1024;
export const TERMINAL_STREAM_MAX_PENDING_MESSAGES_PER_SESSION = 256;
export const TERMINAL_STREAM_MAX_PENDING_BYTES_PER_SESSION = 2 * 1024 * 1024;
export const TERMINAL_STREAM_TARGET_MESSAGE_BYTES = 64 * 1024;

const OUTPUT_FRAGMENT_BASE64_CHARS = 48 * 1024;

const CONTROL_QUEUE_KEY = "\u0000control";

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
  return { payload, byteLength: Buffer.byteLength(payload, "utf8") };
}

export function expandTerminalMessageForDelivery(
  message: TerminalStreamServerMessage,
): TerminalStreamServerMessage[] {
  if (
    serializeTerminalMessage(message).byteLength <=
    TERMINAL_STREAM_TARGET_MESSAGE_BYTES
  )
    return [message];
  if (message.type === "terminal-output") {
    return fragmentOutput(message.terminalId, message.sequence, message.data);
  }
  if (message.type !== "terminal-attached") return [message];

  const expanded: TerminalStreamServerMessage[] = [{ ...message, replay: [] }];
  let batch: Extract<
    TerminalStreamServerMessage,
    { type: "terminal-replay-batch" }
  > = {
    type: "terminal-replay-batch",
    terminalId: message.terminal.terminalId,
    chunks: [],
  };
  const flushBatch = () => {
    if (batch.chunks.length === 0) return;
    expanded.push(batch);
    batch = { ...batch, chunks: [] };
  };

  for (const chunk of message.replay) {
    const encoded = {
      sequence: chunk.sequence,
      dataBase64: Buffer.from(chunk.data, "utf8").toString("base64"),
    };
    const nextBatch = { ...batch, chunks: [...batch.chunks, encoded] };
    if (
      serializeTerminalMessage(nextBatch).byteLength <=
      TERMINAL_STREAM_TARGET_MESSAGE_BYTES
    ) {
      batch = nextBatch;
      continue;
    }
    flushBatch();
    const singleBatch = { ...batch, chunks: [encoded] };
    if (
      serializeTerminalMessage(singleBatch).byteLength <=
      TERMINAL_STREAM_TARGET_MESSAGE_BYTES
    ) {
      batch = singleBatch;
    } else {
      expanded.push(
        ...fragmentBase64(
          message.terminal.terminalId,
          chunk.sequence,
          encoded.dataBase64,
        ),
      );
    }
  }
  flushBatch();
  return expanded;
}

function fragmentOutput(
  terminalId: string,
  sequence: number,
  data: string,
): TerminalStreamServerMessage[] {
  return fragmentBase64(
    terminalId,
    sequence,
    Buffer.from(data, "utf8").toString("base64"),
  );
}

function fragmentBase64(
  terminalId: string,
  sequence: number,
  dataBase64: string,
): TerminalStreamServerMessage[] {
  const fragmentCount = Math.max(
    1,
    Math.ceil(dataBase64.length / OUTPUT_FRAGMENT_BASE64_CHARS),
  );
  return Array.from({ length: fragmentCount }, (_, fragmentIndex) => ({
    type: "terminal-output-fragment" as const,
    terminalId,
    sequence,
    fragmentIndex,
    fragmentCount,
    dataBase64: dataBase64.slice(
      fragmentIndex * OUTPUT_FRAGMENT_BASE64_CHARS,
      (fragmentIndex + 1) * OUTPUT_FRAGMENT_BASE64_CHARS,
    ),
  }));
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
  ): "queued" | "overflow" {
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
      return "overflow";
    }
    if (!existing) {
      this.#queues.set(key, queue);
      this.#queueOrder.push(key);
    }
    queue.messages.push(pending);
    queue.byteLength += pending.byteLength;
    this.#pendingMessages += 1;
    this.#pendingBytes += pending.byteLength;
    return "queued";
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

  clearSession(terminalId: string): void {
    const queue = this.#queues.get(terminalId);
    if (!queue) return;
    this.#queues.delete(terminalId);
    const index = this.#queueOrder.indexOf(terminalId);
    if (index >= 0) {
      this.#queueOrder.splice(index, 1);
      if (index < this.#nextQueueIndex) this.#nextQueueIndex -= 1;
    }
    this.#pendingMessages -= queue.messages.length;
    this.#pendingBytes -= queue.byteLength;
    if (this.#nextQueueIndex >= this.#queueOrder.length)
      this.#nextQueueIndex = 0;
  }

  #queueKey(message: TerminalStreamServerMessage): string {
    if ("terminalId" in message && message.terminalId)
      return message.terminalId;
    if (
      message.type === "terminal-attached" ||
      message.type === "terminal-status"
    ) {
      return message.terminal.terminalId;
    }
    return CONTROL_QUEUE_KEY;
  }
}
