import {
  parseTerminalStreamClientMessage,
  type TerminalStreamServerMessage,
} from "../../common/terminal.js";
import type { ServerPrincipal } from "../lib/http-route-types.js";
import {
  WorkspaceTerminalError,
  type WorkspaceTerminalService,
  type TerminalStreamPeer,
} from "../execution-nodes/workspace-terminals.js";
import {
  expandTerminalMessageForDelivery,
  serializeTerminalMessage,
  TerminalOutputQueue,
} from "./terminal-output-queue.js";
import { sendWebSocketPayload } from "./transport.js";

export {
  TERMINAL_STREAM_MAX_PENDING_BYTES,
  TERMINAL_STREAM_MAX_PENDING_BYTES_PER_SESSION,
  TERMINAL_STREAM_MAX_PENDING_MESSAGES,
  TERMINAL_STREAM_MAX_PENDING_MESSAGES_PER_SESSION,
  TERMINAL_STREAM_TARGET_MESSAGE_BYTES,
} from "./terminal-output-queue.js";

export const TERMINAL_STREAM_BACKPRESSURE_CLOSE_CODE = 1013;
export const TERMINAL_STREAM_BACKPRESSURE_CLOSE_REASON =
  "TERMINAL_STREAM_BACKPRESSURE";
const MAX_TIMER_DELAY_MS = 2_147_000_000;
const OPEN_WS_STATE = 1;

export interface TerminalWebSocketData {
  connectionId: string;
  principal: ServerPrincipal;
}

type TerminalSocket = import("bun").ServerWebSocket<TerminalWebSocketData>;

interface SocketRuntime {
  peer: TerminalStreamPeer;
  lifetime: AbortController;
  expiryTimer: ReturnType<typeof setTimeout> | null;
  terminalAuthorized: boolean;
  closed: boolean;
  outputQueue: TerminalOutputQueue;
}

function sendError(
  peer: TerminalStreamPeer,
  error: unknown,
  terminalId?: string,
): void {
  if (error instanceof WorkspaceTerminalError) {
    peer.sendTerminalMessage({
      type: "terminal-error",
      ...(terminalId ? { terminalId } : {}),
      code: error.code,
      message: error.message,
    });
    return;
  }
  peer.sendTerminalMessage({
    type: "terminal-error",
    ...(terminalId ? { terminalId } : {}),
    code: "terminal-internal",
    message: "Terminal stream operation failed.",
  });
}

export class TerminalStreamHandler {
  readonly #runtimeBySocket = new WeakMap<TerminalSocket, SocketRuntime>();

  constructor(
    readonly manager: Pick<
      WorkspaceTerminalService,
      'attach' | 'input' | 'resize' | 'detachPeer' | 'detachTerminal'
    >,
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
    const lifetime = new AbortController();
    const peer: TerminalStreamPeer = Object.freeze({
      connectionId: socket.data.connectionId,
      signal: lifetime.signal,
      sendTerminalMessage: (message: TerminalStreamServerMessage) => {
        const current = this.#runtimeBySocket.get(socket);
        if (current === runtime)
          this.#sendTerminalMessage(socket, current, message);
      },
    });
    const runtime: SocketRuntime = {
      peer,
      lifetime,
      expiryTimer: null,
      terminalAuthorized: true,
      closed: false,
      outputQueue: new TerminalOutputQueue(),
    };
    this.#runtimeBySocket.set(socket, runtime);
  }

  message(socket: TerminalSocket, data: unknown): void {
    const runtime = this.#runtimeBySocket.get(socket);
    if (!runtime || runtime.closed) return;
    if (!runtime.terminalAuthorized) return;
    if (this.#isExpired(socket)) {
      this.#expireTerminal(socket, runtime);
      return;
    }
    const message = parseTerminalStreamClientMessage(data);
    if (!message) {
      runtime.peer.sendTerminalMessage({
        type: "terminal-error",
        code: "terminal-validation",
        message: "Invalid terminal stream message.",
      });
      return;
    }
    this.#armExpiry(socket, runtime);
    if (!runtime.terminalAuthorized) return;
    try {
      if (message.type === "terminal-attach") {
        this.manager.attach(socket.data.principal, runtime.peer, message);
      } else if (message.type === "terminal-input") {
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
    if (!runtime || runtime.closed || !runtime.terminalAuthorized) return;
    if (this.#isExpired(socket)) {
      this.#expireTerminal(socket, runtime);
      return;
    }
    runtime.outputQueue.markDrained();
    this.#flushPendingMessages(socket, runtime);
  }

  close(socket: TerminalSocket): void {
    const runtime = this.#runtimeBySocket.get(socket);
    if (!runtime || runtime.closed) return;
    runtime.closed = true;
    runtime.lifetime.abort();
    if (runtime.expiryTimer) clearTimeout(runtime.expiryTimer);
    runtime.expiryTimer = null;
    runtime.outputQueue.clear();
    this.manager.detachPeer(socket.data.principal, runtime.peer);
    this.#runtimeBySocket.delete(socket);
  }

  #isExpired(socket: TerminalSocket): boolean {
    return (
      socket.data.principal.expiresAtMs !== null
      && socket.data.principal.expiresAtMs <= this.now()
    );
  }

  #sendTerminalMessage(
    socket: TerminalSocket,
    runtime: SocketRuntime,
    message: TerminalStreamServerMessage,
  ): void {
    if (runtime.closed || !runtime.terminalAuthorized) return;
    if (this.#isExpired(socket)) {
      this.#expireTerminal(socket, runtime);
      return;
    }
    for (const deliveryMessage of expandTerminalMessageForDelivery(message)) {
      if (runtime.closed || !runtime.terminalAuthorized) return;
      if (!this.#sendDeliveryMessage(socket, runtime, deliveryMessage)) return;
    }
  }

  #sendDeliveryMessage(
    socket: TerminalSocket,
    runtime: SocketRuntime,
    message: TerminalStreamServerMessage,
  ): boolean {
    const pending = serializeTerminalMessage(message);
    if (runtime.outputQueue.shouldEnqueue) {
      if (runtime.outputQueue.enqueue(message, pending) === "overflow") {
        const terminalId = terminalIdForMessage(message);
        if (terminalId) {
          runtime.outputQueue.clearSession(terminalId);
          this.manager.detachTerminal(
            socket.data.principal,
            runtime.peer,
            terminalId,
          );
          const errorMessage: TerminalStreamServerMessage = {
            type: "terminal-error",
            terminalId,
            code: "terminal-backpressure",
            message:
              "Terminal output exceeded this client connection capacity.",
          };
          const errorPayload = serializeTerminalMessage(errorMessage);
          if (
            runtime.outputQueue.enqueue(errorMessage, errorPayload) ===
            "overflow"
          ) {
            this.#closeForDeliveryFailure(
              socket,
              runtime,
              TERMINAL_STREAM_BACKPRESSURE_CLOSE_CODE,
              TERMINAL_STREAM_BACKPRESSURE_CLOSE_REASON,
            );
          }
        } else {
          this.#closeForDeliveryFailure(
            socket,
            runtime,
            TERMINAL_STREAM_BACKPRESSURE_CLOSE_CODE,
            TERMINAL_STREAM_BACKPRESSURE_CLOSE_REASON,
          );
        }
        return false;
      }
      return true;
    }
    this.#sendPayload(socket, runtime, pending.payload);
    return !runtime.closed;
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
        "TERMINAL_STREAM_SEND_FAILED",
      );
      return;
    }
    let status: number;
    try {
      status = sendWebSocketPayload(socket, payload);
    } catch {
      this.#closeForDeliveryFailure(
        socket,
        runtime,
        1011,
        "TERMINAL_STREAM_SEND_FAILED",
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
        "TERMINAL_STREAM_SEND_FAILED",
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
    if (
      socket.data.principal.expiresAtMs === null
      || runtime.closed
      || !runtime.terminalAuthorized
      || runtime.expiryTimer
    ) return;
    const remaining = socket.data.principal.expiresAtMs - this.now();
    if (remaining <= 0) {
      this.#expireTerminal(socket, runtime);
      return;
    }
    runtime.expiryTimer = setTimeout(
      () => {
        runtime.expiryTimer = null;
        if (this.#isExpired(socket)) this.#expireTerminal(socket, runtime);
        else this.#armExpiry(socket, runtime);
      },
      Math.min(remaining, MAX_TIMER_DELAY_MS),
    );
  }

  #expireTerminal(socket: TerminalSocket, runtime: SocketRuntime): void {
    if (runtime.closed || !runtime.terminalAuthorized) return;
    if (runtime.expiryTimer) clearTimeout(runtime.expiryTimer);
    runtime.expiryTimer = null;
    runtime.outputQueue.clear();
    this.#sendDeliveryMessage(socket, runtime, {
      type: "terminal-error",
      code: "terminal-auth-expired",
      message: "Terminal authorization expired.",
    });
    runtime.terminalAuthorized = false;
    runtime.lifetime.abort();
    if (!runtime.closed)
      this.manager.detachPeer(socket.data.principal, runtime.peer);
  }
}

function terminalIdForMessage(
  message: TerminalStreamServerMessage,
): string | null {
  if ("terminalId" in message && message.terminalId) return message.terminalId;
  if (
    message.type === "terminal-attached" ||
    message.type === "terminal-status"
  )
    return message.terminal.terminalId;
  return null;
}
