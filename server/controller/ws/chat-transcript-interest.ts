import type { PrimaryWebSocket } from './primary-delivery.js';
import { publishSelectedWebSocketPayload, type SelectiveWebSocketMessagePublisher } from './transport.js';

type InterestedSocket = Pick<PrimaryWebSocket, 'readyState'>;

const OPEN_WS_STATE = 1;

// Owns each browser socket's declared transcript interest: the chats whose
// committed transcript bodies the socket currently displays. A socket that has
// declared nothing displays nothing and receives only transcript summaries.
// Entries end with their socket; the chat handler releases them on close.
export class ChatTranscriptInterestRegistry {
  readonly #chatsBySocket = new Map<InterestedSocket, ReadonlySet<string>>();

  // Replaces the socket's whole set. A closed socket stays released even if a
  // declaration is still being dispatched for it.
  declare(socket: InterestedSocket, chatIds: readonly string[]): void {
    if (socket.readyState !== OPEN_WS_STATE) return;
    if (chatIds.length === 0) {
      this.#chatsBySocket.delete(socket);
      return;
    }
    this.#chatsBySocket.set(socket, new Set(chatIds));
  }

  isInterested(socket: InterestedSocket, chatId: string): boolean {
    return this.#chatsBySocket.get(socket)?.has(chatId) ?? false;
  }

  release(socket: InterestedSocket): void {
    this.#chatsBySocket.delete(socket);
  }

  get socketCount(): number {
    return this.#chatsBySocket.size;
  }

  createPublisher(delivery: SelectiveWebSocketMessagePublisher<InterestedSocket>) {
    return (chatId: string, payloads: ChatTranscriptPayloads): number =>
      publishSelectedWebSocketPayload(delivery, 'chat', this.payloadSelector(chatId, payloads));
  }

  // Chooses each socket's payload for one committed span and serializes each
  // payload at most once, only if some socket receives it.
  payloadSelector(
    chatId: string,
    payloads: ChatTranscriptPayloads,
  ): (socket: InterestedSocket) => string {
    let body: string | undefined;
    let summary: string | undefined;
    return (socket) => this.isInterested(socket, chatId)
      ? (body ??= payloads.body())
      : (summary ??= payloads.summary());
  }
}

export interface ChatTranscriptPayloads {
  readonly body: () => string;
  readonly summary: () => string;
}
