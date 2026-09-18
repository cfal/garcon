// Protocol background: https://xmpp.org/extensions/xep-0198.html#resumption
// This is a Garcon message protocol, not an XMPP implementation or source adaptation.

export interface SessionSocket {
  send(encoded: string): void;
  close(): void;
}

type Packet =
  | { readonly kind: 'message'; readonly ordinal: number; readonly body: string }
  | { readonly kind: 'receipt'; readonly through: number };

interface RetainedMessage {
  readonly ordinal: number;
  readonly encoded: string;
  readonly bytes: number;
}

interface Attachment {
  readonly socket: SessionSocket;
  next: number;
  flushing: boolean;
  ready: boolean;
}

export interface MessageSessionOptions {
  readonly deliver: (body: string) => void;
  readonly failed: (error: Error) => void;
  readonly availabilityChanged?: (connected: boolean) => void;
  readonly maxRetainedBytes?: number;
  readonly maxRetainedFrames?: number;
  readonly maxFrameBytes?: number;
  readonly reconnectGraceMs?: number;
  readonly now?: () => number;
}

export class MessageContinuityError extends Error {
  override readonly name = 'MessageContinuityError';
}

export class MessageSession {
  readonly #pending: RetainedMessage[] = [];
  readonly #limits;
  #bytes = 0;
  #issued = 0;
  #offered = 0;
  #confirmed = 0;
  #accepted = 0;
  #attachment: Attachment | null = null;
  #failure: Error | null = null;
  #resumeUntil: number | null = null;
  #expiry: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: MessageSessionOptions) {
    this.#limits = {
      bytes: options.maxRetainedBytes ?? 32 * 1024 * 1024,
      count: options.maxRetainedFrames ?? 4096,
      frame: options.maxFrameBytes ?? 1024 * 1024,
      grace: options.reconnectGraceMs ?? 30_000,
    };
    for (const limit of Object.values(this.#limits)) {
      if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError('Session limits must be positive safe integers');
    }
  }

  get attached(): boolean { return this.#attachment !== null; }
  get connected(): boolean { return this.#attachment?.ready === true; }
  get received(): number { return this.#accepted; }
  get retainedBytes(): number { return this.#bytes; }
  get retainedFrames(): number { return this.#pending.length; }

  send(body: string): void {
    this.#checkLifetime();
    if (this.#issued === Number.MAX_SAFE_INTEGER) throw this.#stop('Message ordinal exhausted');
    const ordinal = this.#issued + 1;
    const encoded = JSON.stringify({ kind: 'message', ordinal, body } satisfies Packet);
    const bytes = Buffer.byteLength(encoded);
    if (bytes > this.#limits.frame || bytes + this.#bytes > this.#limits.bytes || this.#pending.length >= this.#limits.count) {
      throw this.#stop('Message retention budget exhausted');
    }
    this.#pending.push({ ordinal, encoded, bytes });
    this.#issued = ordinal;
    this.#bytes += bytes;
    this.#flush();
  }

  // The caller authenticates both runtime identities before offering a replacement socket.
  attach(socket: SessionSocket, peerReceived: number): { receive(encoded: string): void; disconnected(): void } {
    this.#checkLifetime();
    if (!isCounter(peerReceived) || peerReceived < this.#confirmed || peerReceived > this.#offered) {
      throw this.#stop('Peer cannot resume the retained message interval');
    }
    this.#confirm(peerReceived);
    const previous = this.#attachment;
    const attachment: Attachment = { socket, next: peerReceived + 1, flushing: false, ready: false };
    this.#attachment = attachment;
    this.#resumeUntil = null;
    if (this.#expiry) clearTimeout(this.#expiry);
    this.#expiry = null;
    previous?.socket.close();
    this.#flush();
    // The trailing receipt fences replay before either side admits new application work.
    this.#receipt(attachment);
    return {
      receive: (encoded) => {
        if (this.#attachment !== attachment) return;
        try {
          const packet = decodePacket(encoded, this.#limits.frame);
          if (packet.kind === 'receipt') {
            this.#confirm(packet.through);
            if (!attachment.ready) {
              attachment.ready = true;
              this.options.availabilityChanged?.(true);
            }
            return;
          }
          if (packet.ordinal > this.#accepted + 1) {
            throw new MessageContinuityError('Message gap on an ordered WebSocket');
          }
          if (packet.ordinal === this.#accepted + 1) {
            this.#accepted = packet.ordinal;
            this.options.deliver(packet.body);
          }
          this.#receipt(attachment);
        } catch (error) {
          this.close(error instanceof Error ? error : new Error(String(error)));
        }
      },
      disconnected: () => this.#detach(attachment),
    };
  }

  close(error: Error = new MessageContinuityError('Message session closed')): void {
    if (this.#failure) return;
    this.#failure = error;
    const attachment = this.#attachment;
    this.#attachment = null;
    if (this.#expiry) clearTimeout(this.#expiry);
    this.#expiry = null;
    this.#pending.length = 0;
    this.#bytes = 0;
    attachment?.socket.close();
    this.options.availabilityChanged?.(false);
    this.options.failed(error);
  }

  #confirm(through: number): void {
    if (!isCounter(through) || through > this.#offered) throw this.#stop('Receipt exceeds offered messages');
    if (through <= this.#confirmed) return;
    let count = 0;
    for (const message of this.#pending) {
      if (message.ordinal > through) break;
      this.#bytes -= message.bytes;
      count++;
    }
    this.#pending.splice(0, count);
    this.#confirmed = through;
  }

  #flush(): void {
    const attachment = this.#attachment;
    if (!attachment || attachment.flushing) return;
    attachment.flushing = true;
    try {
      while (this.#attachment === attachment) {
        // Receipts may synchronously retire entries during a transport write.
        attachment.next = Math.max(attachment.next, this.#confirmed + 1);
        const message = this.#pending[attachment.next - this.#confirmed - 1];
        if (!message) return;
        attachment.next++;
        this.#offered = Math.max(this.#offered, message.ordinal);
        this.#write(attachment, message.encoded);
      }
    } finally { attachment.flushing = false; }
  }

  #receipt(attachment: Attachment): void {
    this.#write(attachment, JSON.stringify({ kind: 'receipt', through: this.#accepted } satisfies Packet));
  }

  #write(attachment: Attachment, encoded: string): void {
    if (this.#attachment !== attachment) return;
    try {
      attachment.socket.send(encoded);
    } catch (error) {
      if (error instanceof MessageContinuityError) {
        this.close(error);
        throw error;
      }
      this.#detach(attachment);
      attachment.socket.close();
    }
  }

  #detach(attachment: Attachment): void {
    if (this.#attachment !== attachment) return;
    this.#attachment = null;
    this.#resumeUntil = this.#now() + this.#limits.grace;
    this.#expiry = setTimeout(() => this.#stop('Message resumption deadline expired'), this.#limits.grace);
    this.#expiry.unref();
    this.options.availabilityChanged?.(false);
  }

  #now(): number { return this.options.now?.() ?? Date.now(); }

  #checkLifetime(): void {
    if (this.#failure) throw this.#failure;
    if (this.#resumeUntil !== null && this.#now() >= this.#resumeUntil) {
      throw this.#stop('Message resumption deadline expired');
    }
  }

  #stop(message: string): Error {
    const error = new MessageContinuityError(message);
    this.close(error);
    return error;
  }
}

function isCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function decodePacket(encoded: string, maxBytes: number): Packet {
  if (Buffer.byteLength(encoded) > maxBytes) throw new MessageContinuityError('Message exceeds frame budget');
  const packet: unknown = JSON.parse(encoded);
  if (packet && typeof packet === 'object' && 'kind' in packet) {
    if (packet.kind === 'receipt' && 'through' in packet && isCounter(packet.through)) {
      return { kind: 'receipt', through: packet.through };
    }
    if (packet.kind === 'message' && 'ordinal' in packet && isCounter(packet.ordinal) && packet.ordinal > 0
      && 'body' in packet && typeof packet.body === 'string') {
      return { kind: 'message', ordinal: packet.ordinal, body: packet.body };
    }
  }
  throw new MessageContinuityError('Invalid message session packet');
}
