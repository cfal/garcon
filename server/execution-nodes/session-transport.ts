import { MessageContinuityError, MessageSession, type MessageSessionOptions, type SessionSocket } from './message-session.js';

export class SessionTransport {
  readonly channel: MessageSession;
  readonly ready: Promise<void>;
  readonly #ready = Promise.withResolvers<void>();
  readonly #messages = new Set<(payload: string) => void>();
  readonly #failures = new Set<(error: Error) => void>();
  readonly #availability = new Set<(connected: boolean) => void>();
  readonly #replay: string[] = [];
  #replayBytes = 0;
  #failure: Error | null = null;

  constructor(
    readonly id: string,
    readonly peerRuntimeId: string,
    retired: (error: Error) => void,
    limits: Pick<MessageSessionOptions, 'reconnectGraceMs' | 'maxRetainedBytes' | 'maxRetainedFrames'> = {},
  ) {
    this.ready = this.#ready.promise;
    void this.ready.catch(() => undefined);
    this.channel = new MessageSession({
      ...limits,
      maxFrameBytes: 16 * 1024 * 1024,
      deliver: (payload) => {
        if (this.connected) { this.#deliver(payload); return; }
        const bytes = Buffer.byteLength(payload);
        if (this.#replay.length >= (limits.maxRetainedFrames ?? 4096)
          || this.#replayBytes + bytes > (limits.maxRetainedBytes ?? 32 * 1024 * 1024)) {
          throw new MessageContinuityError('Inbound replay budget exhausted');
        }
        this.#replay.push(payload);
        this.#replayBytes += bytes;
      },
      failed: (error) => {
        this.#failure = error;
        this.#replay.length = 0;
        this.#replayBytes = 0;
        this.#ready.reject(error);
        for (const listener of this.#failures) listener(error);
        this.#messages.clear();
        this.#failures.clear();
        this.#availability.clear();
        retired(error);
      },
      availabilityChanged: (connected) => {
        if (connected) {
          while (this.connected && this.#replay.length > 0) {
            const payload = this.#replay.shift()!;
            this.#replayBytes -= Buffer.byteLength(payload);
            this.#deliver(payload);
          }
          if (!this.connected) return;
          this.#ready.resolve();
        }
        for (const listener of this.#availability) listener(connected);
      },
    });
  }

  get connected(): boolean { return this.channel.connected; }

  attach(socket: SessionSocket, received: number) {
    return this.channel.attach(socket, received);
  }

  send(payload: string): void { this.channel.send(payload); }
  close(error?: Error): void { this.channel.close(error); }

  onMessage(listener: (payload: string) => void): () => void {
    this.#messages.add(listener);
    return () => { this.#messages.delete(listener); };
  }

  onFailure(listener: (error: Error) => void): () => void {
    this.#failures.add(listener);
    if (this.#failure) listener(this.#failure);
    return () => { this.#failures.delete(listener); };
  }

  onAvailability(listener: (connected: boolean) => void): () => void {
    this.#availability.add(listener);
    return () => { this.#availability.delete(listener); };
  }

  #deliver(payload: string): void {
    for (const listener of this.#messages) listener(payload);
  }
}
