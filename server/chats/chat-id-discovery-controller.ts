import {
  appendChatIdDisclosure,
  chatIdDisclosureNoticeContent,
  CHAT_ID_DISCLOSURE_NOTICE_TITLE,
  type ChatIdDisclosureDelivery,
} from '../../common/chat-id-discovery.js';
import type { TranscriptViewId } from '../ledger/contracts.js';
import type { ChatIdDiscoveryState, ReservedChatIdDisclosure } from './chat-id-discovery-state.js';

export interface PreparedChatIdDisclosure {
  readonly prompt: string;
  readonly reservation: ReservedChatIdDisclosure | null;
}

export interface ChatIdDiscoveryControllerPort {
  reserve(chatId: string, viewId: string, prompt: string): PreparedChatIdDisclosure;
  recordDelivered(
    reservation: ReservedChatIdDisclosure | null,
    delivery: ChatIdDisclosureDelivery,
  ): void;
  release(reservation: ReservedChatIdDisclosure | null): void;
}

export const DISABLED_CHAT_ID_DISCOVERY_CONTROLLER = Object.freeze({
  reserve: (_chatId: string, _viewId: string, prompt: string) => ({
    prompt,
    reservation: null,
  }),
  recordDelivered: () => undefined,
  release: () => undefined,
}) satisfies ChatIdDiscoveryControllerPort;

interface ChatIdDiscoveryControllerDeps {
  readonly state: ChatIdDiscoveryState;
  readonly notices: {
    appendNotice(
      chatId: string,
      viewId: TranscriptViewId,
      input: {
        readonly title: string;
        readonly content: string;
        readonly detail: {
          readonly type: 'chat-id-disclosure';
          readonly delivery: ChatIdDisclosureDelivery;
        };
      },
    ): unknown;
  };
  readonly onRecordError?: (error: unknown, chatId: string) => void;
}

export class ChatIdDiscoveryController implements ChatIdDiscoveryControllerPort {
  constructor(private readonly deps: ChatIdDiscoveryControllerDeps) {}

  reserve(chatId: string, viewId: string, prompt: string): PreparedChatIdDisclosure {
    const reservation = this.deps.state.reserve(chatId, viewId);
    return {
      reservation,
      prompt: reservation
        ? appendChatIdDisclosure(prompt, reservation.chatId)
        : prompt,
    };
  }

  recordDelivered(
    reservation: ReservedChatIdDisclosure | null,
    delivery: ChatIdDisclosureDelivery,
  ): void {
    if (!reservation) return;
    try {
      this.deps.notices.appendNotice(reservation.chatId, reservation.viewId, {
        title: CHAT_ID_DISCLOSURE_NOTICE_TITLE,
        content: chatIdDisclosureNoticeContent(reservation.chatId, delivery),
        detail: { type: 'chat-id-disclosure', delivery },
      });
      this.deps.state.complete(reservation);
    } catch (error) {
      this.deps.state.release(reservation);
      this.deps.onRecordError?.(error, reservation.chatId);
    }
  }

  release(reservation: ReservedChatIdDisclosure | null): void {
    if (reservation) this.deps.state.release(reservation);
  }
}
