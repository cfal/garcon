import type { RpcLane } from './rpc-lane.js';

export const EXECUTOR_SOCKET_LIMIT = 192;
export const EXECUTOR_PENDING_SOCKET_LIMIT = 64;

export interface SocketAdmissionLease {
  promote(lane: RpcLane): boolean;
  release(): void;
}

// Includes sockets between Noise completion and application proof verification.
export class ExecutorSocketAdmission {
  #pending = 0;
  readonly #active = { primary: 0, bulk: 0 };

  constructor(private readonly roleLimit = 64, private readonly pendingLimit = EXECUTOR_PENDING_SOCKET_LIMIT) {}

  acquire(): SocketAdmissionLease | null {
    if (this.#pending >= this.pendingLimit) return null;
    this.#pending++;
    let role: RpcLane | null = null;
    let released = false;
    return {
      promote: (lane) => {
        if (released || role !== null || this.#active[lane] >= this.roleLimit) return false;
        this.#pending--;
        this.#active[lane]++;
        role = lane;
        return true;
      },
      release: () => {
        if (released) return;
        released = true;
        if (role === null) this.#pending--;
        else this.#active[role]--;
      },
    };
  }
}
