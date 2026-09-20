import { isTerminalStreamClientMessageType } from '../../common/ws-protocol.js';
import { isRecord } from '../../common/json.js';
import type { TerminalStreamServerMessage } from '../../common/terminal.js';
import { sendWebSocketPayload } from './transport.js';
import type { ChatHandler } from './chat.js';
import type { TerminalStreamHandler } from './terminal-stream.js';
import type { PrimaryWebSocket } from './primary-delivery.js';

type PrimarySocket = PrimaryWebSocket;
type ChatWsHandler = ReturnType<ChatHandler['createHandler']>;
type TerminalWsHandler = ReturnType<TerminalStreamHandler['createHandler']>;

export class PrimaryWsHandler {
  readonly #chat: ChatWsHandler;
  readonly #terminal: TerminalWsHandler | null;

  constructor(chat: ChatHandler, terminal: TerminalStreamHandler | null) {
    this.#chat = chat.createHandler();
    this.#terminal = terminal?.createHandler() ?? null;
  }

  open(socket: PrimarySocket): void {
    this.#chat.open(socket);
    this.#terminal?.open(socket);
  }

  async message(socket: PrimarySocket, data: unknown): Promise<void> {
    const type = isRecord(data) ? data.type : undefined;
    if (isTerminalStreamClientMessageType(type)) {
      if (!this.#terminal) {
        sendWebSocketPayload(socket, JSON.stringify({
          type: 'terminal-error', code: 'terminal-unsupported',
          message: 'This execution node does not provide terminal services',
        } satisfies TerminalStreamServerMessage));
        return;
      }
      await this.#terminal.message(socket, data);
      return;
    }
    await this.#chat.message(socket, data);
  }

  drain(socket: PrimarySocket): void {
    this.#terminal?.drain(socket);
  }

  close(socket: PrimarySocket, code: number, reason: string): void {
    try {
      this.#terminal?.close(socket);
    } finally {
      this.#chat.close(socket, code, reason);
    }
  }
}
