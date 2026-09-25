import { MessageSession, type MessageSessionOptions, type SessionSocket } from './message-session.js';
import { SESSION_MESSAGE_BYTES } from './session-socket.js';

export class SessionTransport {
  readonly channel: MessageSession;
  readonly ready: Promise<void>;
  readonly #ready = Promise.withResolvers<void>();
  readonly #messages = new Set<(payload: string) => void>();
  readonly #failures = new Set<(error: Error) => void>();
  readonly #availability = new Set<(connected: boolean) => void>();
  #failure: Error | null = null;

  constructor(
    readonly id: string,
    readonly peerRuntimeId: string,
    retired: (error: Error) => void,
    limits: Pick<MessageSessionOptions, 'maxQueuedBytes' | 'maxQueuedFrames'> = {},
    readonly executorId: string = 'local',
  ) {
    this.ready = this.#ready.promise;
    void this.ready.catch(() => undefined);
    this.channel = new MessageSession({
      ...limits,
      maxFrameBytes: SESSION_MESSAGE_BYTES,
      deliver: (payload) => this.#deliver(payload),
      failed: (error) => {
        this.#failure = error;
        this.#ready.reject(error);
        for (const listener of this.#failures) listener(error);
        this.#messages.clear();
        this.#failures.clear();
        this.#availability.clear();
        retired(error);
      },
      availabilityChanged: (connected) => {
        if (connected) this.#ready.resolve();
        for (const listener of this.#availability) listener(connected);
      },
    });
  }

  get connected(): boolean { return this.channel.connected; }

  attach(socket: SessionSocket) {
    return this.channel.attach(socket);
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
