import { isTerminalStreamClientMessageType } from '../../../common/ws-protocol.js';
import { isRecord } from '../../../common/json.js';
import type { ChatHandler } from './chat.js';
import type { TerminalStreamHandler } from './terminal-stream.js';
import type { PrimaryWebSocket } from './primary-delivery.js';
import { withActivity } from '../../common/event-loop-stalls.js';

type PrimarySocket = PrimaryWebSocket;
type ChatWsHandler = ReturnType<ChatHandler['createHandler']>;
type TerminalWsHandler = ReturnType<TerminalStreamHandler['createHandler']>;

export class PrimaryWsHandler {
  readonly #chat: ChatWsHandler;
  readonly #terminal: TerminalWsHandler;

  constructor(chat: ChatHandler, terminal: TerminalStreamHandler) {
    this.#chat = chat.createHandler();
    this.#terminal = terminal.createHandler();
  }

  open(socket: PrimarySocket): void {
    this.#chat.open(socket);
    this.#terminal.open(socket);
  }

  async message(socket: PrimarySocket, data: unknown): Promise<void> {
    const type = isRecord(data) ? data.type : undefined;
    await withActivity(`ws ${activityMessageType(type)}`, async () => {
      if (isTerminalStreamClientMessageType(type)) await this.#terminal.message(socket, data);
      else await this.#chat.message(socket, data);
    });
  }

  drain(socket: PrimarySocket): void {
    this.#terminal.drain(socket);
  }

  close(socket: PrimarySocket, code: number, reason: string): void {
    try {
      this.#terminal.close(socket);
    } finally {
      this.#chat.close(socket, code, reason);
    }
  }
}

// Client-supplied types reach the logs only when they look like protocol names.
function activityMessageType(type: unknown): string {
  return typeof type === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(type) ? type : 'unknown';
}
