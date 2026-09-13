import { DomainError } from '../lib/domain-error.js';

export interface NodeNativeReservation {
  /** Releases unused preparation or work whose native settlement was observed. */
  release(): void;
}

export interface NodeNativeExecutionReservation extends NodeNativeReservation {
  /** Fences concurrent prepared tickets before this chat can enter native work. */
  enter(): void;
}

/** Shares native capacity across execution and auxiliary work in one provider instance. */
export class NodeNativeOccupancy {
  readonly #chats = new Set<string>();
  #active = 0;
  #closed = false;

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('Native capacity must be a positive integer');
  }

  get active(): number { return this.#active; }

  reserveExecution(chatId: string): NodeNativeExecutionReservation {
    if (this.#chats.has(chatId)) throw capacity();
    return this.#reserve(chatId);
  }

  reserveAuxiliary(): NodeNativeReservation { return this.#reserve(null); }

  /** Fences new work without treating authority loss as native settlement. */
  close(): void { this.#closed = true; }

  #reserve(chatId: string | null): NodeNativeExecutionReservation {
    if (this.#closed) throw new DomainError('NODE_UNAVAILABLE', 'Native execution capacity is retired', 409);
    if (this.#active >= this.limit) throw capacity();
    this.#active += 1;
    let entered = false;
    let released = false;
    return Object.freeze({
      enter: () => {
        if (entered) return;
        if (released || this.#closed) throw new DomainError('NODE_UNAVAILABLE', 'Native execution reservation is retired', 409);
        if (chatId !== null) {
          if (this.#chats.has(chatId)) throw capacity();
          this.#chats.add(chatId);
        }
        entered = true;
      },
      release: () => {
        if (released) return;
        released = true;
        this.#active -= 1;
        if (entered && chatId !== null) this.#chats.delete(chatId);
      },
    });
  }
}

function capacity(): DomainError {
  return new DomainError('NODE_CAPACITY', 'Native execution capacity is reserved by other work', 429);
}
