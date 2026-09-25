import type { NoiseWebSocket } from '@cfal/noise-ws';
import { MessageContinuityError, type SessionSocket } from './message-session.js';

export const SESSION_MESSAGE_BYTES = 16 * 1024 * 1024;
const FRAGMENT_BYTES = 256 * 1024;
export const SESSION_SOCKET_BUFFER_BYTES = 512 * 1024;

// Noise messages are small enough to expose authenticated progress on slow links.
// One session packet may span multiple fragments; the first byte marks its end.
export class SessionSocketFrames implements SessionSocket {
  readonly #received: Uint8Array[] = [];
  #receivedBytes = 0;
  #sending: Buffer | null = null;
  #offset = 0;
  #retry: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly socket: Pick<NoiseWebSocket, 'send' | 'bufferedAmount'>,
    private readonly disconnect: () => void,
  ) {}

  canSend(): boolean { return this.#sending === null && this.socket.bufferedAmount < SESSION_SOCKET_BUFFER_BYTES; }

  send(encoded: string): void {
    if (!this.canSend()) throw new Error('Session socket is not writable');
    const bytes = Buffer.from(encoded);
    if (bytes.length > SESSION_MESSAGE_BYTES) throw new MessageContinuityError('Message exceeds frame budget');
    this.#sending = bytes;
    this.#offset = 0;
    this.#flush();
  }

  receive(fragment: Uint8Array): string | null {
    if (fragment.length < 2 || fragment.length > FRAGMENT_BYTES + 1 || fragment[0]! > 1
      || (fragment[0] === 0 && fragment.length !== FRAGMENT_BYTES + 1)
      || this.#receivedBytes + fragment.length - 1 > SESSION_MESSAGE_BYTES) {
      throw new MessageContinuityError('Invalid session message fragment');
    }
    this.#received.push(fragment.subarray(1));
    this.#receivedBytes += fragment.length - 1;
    if (fragment[0] === 0) return null;
    const bytes = Buffer.concat(this.#received, this.#receivedBytes);
    this.#received.length = 0;
    this.#receivedBytes = 0;
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new MessageContinuityError('Invalid session message encoding'); }
  }

  close(): void { this.dispose(); this.disconnect(); }

  dispose(): void {
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = null;
    this.#sending = null;
    this.#received.length = 0;
    this.#receivedBytes = 0;
  }

  #flush(): void {
    try {
      while (this.#sending && this.socket.bufferedAmount < SESSION_SOCKET_BUFFER_BYTES) {
        const end = Math.min(this.#offset + FRAGMENT_BYTES, this.#sending.length);
        const complete = end === this.#sending.length;
        const fragment = Buffer.allocUnsafe(end - this.#offset + 1);
        fragment[0] = complete ? 1 : 0;
        this.#sending.copy(fragment, 1, this.#offset, end);
        this.#offset = end;
        if (complete) this.#sending = null;
        this.socket.send(fragment);
      }
      if (this.#sending) {
        this.#retry = setTimeout(() => { this.#retry = null; this.#flush(); }, 10);
        this.#retry.unref();
      }
    } catch { this.close(); }
  }
}
