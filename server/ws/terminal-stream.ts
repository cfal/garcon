import {
  parseTerminalStreamClientMessage,
  type TerminalStreamServerMessage,
} from '../../common/terminal.js';
import type { ServerPrincipal } from '../lib/http-route-types.js';
import {
  TerminalManager,
  TerminalManagerError,
  type TerminalStreamPeer,
} from '../terminals/terminal-manager.js';
import {
  expandTerminalMessageForDelivery,
  serializeTerminalMessage,
  TerminalOutputQueue,
} from './terminal-output-queue.js';

export {
  TERMINAL_STREAM_MAX_PENDING_BYTES,
  TERMINAL_STREAM_MAX_PENDING_BYTES_PER_SESSION,
  TERMINAL_STREAM_MAX_PENDING_MESSAGES,
  TERMINAL_STREAM_MAX_PENDING_MESSAGES_PER_SESSION,
  TERMINAL_STREAM_TARGET_MESSAGE_BYTES,
} from './terminal-output-queue.js';

export const TERMINAL_AUTH_EXPIRED_CLOSE_CODE = 4001;
export const TERMINAL_AUTH_EXPIRED_REASON = 'TERMINAL_AUTH_EXPIRED';
export const TERMINAL_STREAM_BACKPRESSURE_CLOSE_CODE = 1013;
export const TERMINAL_STREAM_BACKPRESSURE_CLOSE_REASON =
  'TERMINAL_STREAM_BACKPRESSURE';
const MAX_TIMER_DELAY_MS = 2_147_000_000;
const OPEN_WS_STATE = 1;

export interface TerminalWebSocketData {
  pathname?: string;
  connectionId: string;
  principal: ServerPrincipal;
  expiresAtMs: number | null;
}

type TerminalSocket = import('bun').ServerWebSocket<TerminalWebSocketData>;

interface SocketRuntime {
  peer: TerminalStreamPeer;
  expiryTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
  outputQueue: TerminalOutputQueue;
}

function sendError(
  peer: TerminalStreamPeer,
  error: unknown,
  terminalId?: string,
): void {
  if (error instanceof TerminalManagerError) {
    peer.sendTerminalMessage({
      type: 'terminal-error',
      ...(terminalId ? { terminalId } : {}),
      code: error.code,
      message: error.message,
    });
    return;
  }
  peer.sendTerminalMessage({
    type: 'terminal-error',
    ...(terminalId ? { terminalId } : {}),
    code: 'terminal-internal',
    message: 'Terminal stream operation failed.',
  });
}

export class TerminalStreamHandler {
  readonly #runtimeBySocket = new WeakMap<TerminalSocket, SocketRuntime>();

  constructor(
    readonly manager: TerminalManager,
    readonly now: () => number = Date.now,
  ) {}

  createHandler() {
    return {
      open: (socket: TerminalSocket) => this.open(socket),
      message: (socket: TerminalSocket, data: unknown) =>
        this.message(socket, data),
      drain: (socket: TerminalSocket) => this.drain(socket),
      close: (socket: TerminalSocket) => this.close(socket),
    };
  }

  open(socket: TerminalSocket): void {
    const peer: TerminalStreamPeer = {
      connectionId: socket.data.connectionId,
      ownedTerminalIds: new Set(),
      sendTerminalMessage: (message: TerminalStreamServerMessage) => {
        const current = this.#runtimeBySocket.get(socket);
        if (current) this.#sendTerminalMessage(socket, current, message);
      },
    };
    const runtime: SocketRuntime = {
      peer,
      expiryTimer: null,
      closed: false,
      outputQueue: new TerminalOutputQueue(),
    };
    this.#runtimeBySocket.set(socket, runtime);
    this.#armExpiry(socket, runtime);
  }

  async message(socket: TerminalSocket, data: unknown): Promise<void> {
    const runtime = this.#runtimeBySocket.get(socket);
    if (!runtime || runtime.closed) return;
    if (this.#isExpired(socket)) {
      this.#expire(socket, runtime);
      return;
    }
    const message = parseTerminalStreamClientMessage(data);
    if (!message) {
      runtime.peer.sendTerminalMessage({
        type: 'terminal-error',
        code: 'terminal-validation',
        message: 'Invalid terminal stream message.',
      });
      return;
    }
    try {
      if (message.type === 'terminal-attach') {
        this.manager.attach(socket.data.principal, runtime.peer, message);
      } else if (message.type === 'terminal-input') {
        this.manager.input(
          socket.data.principal,
          runtime.peer,
          message.terminalId,
          message.data,
        );
      } else {
        this.manager.resize(
          socket.data.principal,
          runtime.peer,
          message.terminalId,
          message.cols,
          message.rows,
        );
      }
    } catch (error) {
      sendError(runtime.peer, error, message.terminalId);
    }
  }

  drain(socket: TerminalSocket): void {
    const runtime = this.#runtimeBySocket.get(socket);
    if (!runtime || runtime.closed) return;
    runtime.outputQueue.markDrained();
    this.#flushPendingMessages(socket, runtime);
  }

  close(socket: TerminalSocket): void {
    const runtime = this.#runtimeBySocket.get(socket);
    if (!runtime || runtime.closed) return;
    runtime.closed = true;
    if (runtime.expiryTimer) clearTimeout(runtime.expiryTimer);
    runtime.expiryTimer = null;
    runtime.outputQueue.clear();
    this.manager.detachPeer(socket.data.principal, runtime.peer);
    this.#runtimeBySocket.delete(socket);
  }

  #isExpired(socket: TerminalSocket): boolean {
    return (
      socket.data.expiresAtMs !== null && socket.data.expiresAtMs <= this.now()
    );
  }

  #sendTerminalMessage(
    socket: TerminalSocket,
    runtime: SocketRuntime,
    message: TerminalStreamServerMessage,
  ): void {
    if (runtime.closed) return;
    for (const deliveryMessage of expandTerminalMessageForDelivery(message)) {
      if (runtime.closed) return;
      this.#sendDeliveryMessage(socket, runtime, deliveryMessage);
    }
  }

  #sendDeliveryMessage(
    socket: TerminalSocket,
    runtime: SocketRuntime,
    message: TerminalStreamServerMessage,
  ): void {
    const pending = serializeTerminalMessage(message);
    if (runtime.outputQueue.shouldEnqueue) {
      if (runtime.outputQueue.enqueue(message, pending) === 'overflow') {
        this.#closeForDeliveryFailure(
          socket,
          runtime,
          TERMINAL_STREAM_BACKPRESSURE_CLOSE_CODE,
          TERMINAL_STREAM_BACKPRESSURE_CLOSE_REASON,
        );
      }
      return;
    }
    this.#sendPayload(socket, runtime, pending.payload);
  }

  #flushPendingMessages(socket: TerminalSocket, runtime: SocketRuntime): void {
    while (!runtime.closed && !runtime.outputQueue.isBackpressured) {
      const pending = runtime.outputQueue.next();
      if (!pending) return;
      this.#sendPayload(socket, runtime, pending.payload);
    }
  }

  #sendPayload(
    socket: TerminalSocket,
    runtime: SocketRuntime,
    payload: string,
  ): void {
    if (socket.readyState !== OPEN_WS_STATE) {
      this.#closeForDeliveryFailure(
        socket,
        runtime,
        1011,
        'TERMINAL_STREAM_SEND_FAILED',
      );
      return;
    }
    let status: number;
    try {
      status = socket.send(payload);
    } catch {
      this.#closeForDeliveryFailure(
        socket,
        runtime,
        1011,
        'TERMINAL_STREAM_SEND_FAILED',
      );
      return;
    }
    if (status === -1) {
      runtime.outputQueue.markBackpressured();
    } else if (status === 0) {
      this.#closeForDeliveryFailure(
        socket,
        runtime,
        1011,
        'TERMINAL_STREAM_SEND_FAILED',
      );
    }
  }

  #closeForDeliveryFailure(
    socket: TerminalSocket,
    runtime: SocketRuntime,
    code: number,
    reason: string,
  ): void {
    if (runtime.closed) return;
    this.close(socket);
    socket.close(code, reason);
  }

  #armExpiry(socket: TerminalSocket, runtime: SocketRuntime): void {
    if (socket.data.expiresAtMs === null || runtime.closed) return;
    const remaining = socket.data.expiresAtMs - this.now();
    if (remaining <= 0) {
      this.#expire(socket, runtime);
      return;
    }
    runtime.expiryTimer = setTimeout(
      () => {
        runtime.expiryTimer = null;
        if (this.#isExpired(socket)) this.#expire(socket, runtime);
        else this.#armExpiry(socket, runtime);
      },
      Math.min(remaining, MAX_TIMER_DELAY_MS),
    );
  }

  #expire(socket: TerminalSocket, runtime: SocketRuntime): void {
    if (runtime.closed) return;
    this.close(socket);
    socket.close(
      TERMINAL_AUTH_EXPIRED_CLOSE_CODE,
      TERMINAL_AUTH_EXPIRED_REASON,
    );
  }
}
