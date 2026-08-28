import { parseChatId, type ChatId } from '../../common/chat-id.js';
import type { TranscriptViewId } from '../ledger/contracts.js';

interface PendingChatIdDisclosure {
  readonly chatId: ChatId;
  readonly viewId: TranscriptViewId;
  readonly requestToken: number;
  readonly reservationToken: number | null;
}

export interface ReservedChatIdDisclosure {
  readonly chatId: ChatId;
  readonly viewId: TranscriptViewId;
  readonly requestToken: number;
  readonly reservationToken: number;
}

export class ChatIdDiscoveryState {
  readonly #pending = new Map<string, PendingChatIdDisclosure>();
  #nextToken = 0;

  constructor(
    private readonly isEnabled: () => boolean,
    private readonly onInvalidChatId: (error: unknown, chatId: string) => void = () => undefined,
  ) {}

  enabled(): boolean {
    return this.isEnabled();
  }

  request(chatId: string, viewId: TranscriptViewId): void {
    if (!this.isEnabled()) return;
    let parsed: ChatId;
    try {
      parsed = parseChatId(chatId);
    } catch (error) {
      this.onInvalidChatId(error, chatId);
      return;
    }
    this.#pending.set(parsed, {
      chatId: parsed,
      viewId,
      requestToken: ++this.#nextToken,
      reservationToken: null,
    });
  }

  reserve(chatId: string, viewId: TranscriptViewId): ReservedChatIdDisclosure | null {
    if (!this.isEnabled()) {
      this.discard(chatId);
      return null;
    }
    const pending = this.#pending.get(chatId);
    if (!pending || pending.viewId !== viewId) return null;
    if (pending.reservationToken !== null) return null;

    const reservationToken = ++this.#nextToken;
    this.#pending.set(chatId, { ...pending, reservationToken });
    return { ...pending, reservationToken };
  }

  complete(reservation: ReservedChatIdDisclosure): boolean {
    const current = this.#pending.get(reservation.chatId);
    if (!this.#matches(current, reservation)) return false;
    this.#pending.delete(reservation.chatId);
    return true;
  }

  release(reservation: ReservedChatIdDisclosure): boolean {
    const current = this.#pending.get(reservation.chatId);
    if (!this.#matches(current, reservation)) return false;
    this.#pending.set(reservation.chatId, {
      ...current,
      reservationToken: null,
    });
    return true;
  }

  discard(chatId: string): void {
    this.#pending.delete(chatId);
  }

  clear(): void {
    this.#pending.clear();
  }

  #matches(
    current: PendingChatIdDisclosure | undefined,
    reservation: ReservedChatIdDisclosure,
  ): current is PendingChatIdDisclosure {
    return Boolean(
      current
      && current.viewId === reservation.viewId
      && current.requestToken === reservation.requestToken
      && current.reservationToken === reservation.reservationToken,
    );
  }
}
