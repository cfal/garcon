import { parseChatId } from '../../common/chat-id.js';
import {
  chatIdDisclosureContent,
  chatIdDisclosureNoticeContent,
  CHAT_ID_DISCLOSURE_NOTICE_TITLE,
  chatIdDiscoveryFailureContent,
} from '../../common/chat-id-discovery.js';
import type {
  ChatIdDiscoveryFailureReason,
} from '../../common/transcript-notice-details.js';
import type {
  CapturedSteerTarget,
} from '../chat-execution/types.js';
import type { TranscriptLedgerService } from '../ledger/service.js';
import type { TranscriptViewId } from '../ledger/contracts.js';
import { DomainError } from '../lib/domain-error.js';

interface ChatIdDiscoveryRequest {
  readonly chatId: string;
  readonly viewId: TranscriptViewId;
  readonly runId: string | null;
  readonly at: string;
}

interface ChatIdDiscoveryAttempt {
  readonly runId: string | null;
}

interface ChatIdDiscoveryExecution {
  captureSteerTarget(chatId: string): CapturedSteerTarget | null;
  deliverControlSteer(
    chatId: string,
    content: string,
    transcriptViewId: string,
    target: CapturedSteerTarget,
  ): Promise<void>;
}

interface ChatIdDiscoveryControllerOptions {
  readonly execution: ChatIdDiscoveryExecution;
  readonly notices: Pick<TranscriptLedgerService, 'appendNotice'>;
  readonly onError?: (error: unknown, chatId: string) => void;
}

export class ChatIdDiscoveryController {
  readonly #attempts = new Map<string, ChatIdDiscoveryAttempt>();

  constructor(private readonly options: ChatIdDiscoveryControllerOptions) {}

  request(input: ChatIdDiscoveryRequest): void {
    if (this.#attempts.get(input.chatId)?.runId === input.runId) return;
    const attempt = { runId: input.runId };
    this.#attempts.set(input.chatId, attempt);
    if (!input.runId) {
      this.#recordFailure(input, 'turn-unavailable');
      return;
    }

    let target: CapturedSteerTarget | null;
    try {
      target = this.options.execution.captureSteerTarget(input.chatId);
    } catch (error) {
      this.options.onError?.(error, input.chatId);
      this.#recordFailure(input, 'delivery-failed');
      return;
    }
    if (!target || target.identity.turnId !== input.runId) {
      this.#recordFailure(input, 'turn-unavailable');
      return;
    }

    let chatId: ReturnType<typeof parseChatId>;
    try {
      chatId = parseChatId(input.chatId);
    } catch (error) {
      this.options.onError?.(error, input.chatId);
      this.#recordFailure(input, 'delivery-failed');
      return;
    }
    void this.options.execution.deliverControlSteer(
      input.chatId,
      chatIdDisclosureContent(chatId),
      input.viewId,
      target,
    ).then(
      () => {
        if (this.#attempts.get(input.chatId) === attempt) {
          this.#recordSuccess(input, chatId);
        }
      },
      (error) => {
        if (this.#attempts.get(input.chatId) !== attempt) return;
        this.options.onError?.(error, input.chatId);
        this.#recordFailure(input, failureReason(error));
      },
    );
  }

  discard(chatId: string): void {
    this.#attempts.delete(chatId);
  }

  #recordSuccess(input: ChatIdDiscoveryRequest, chatId: ReturnType<typeof parseChatId>): void {
    this.#appendNotice(input, {
      title: CHAT_ID_DISCLOSURE_NOTICE_TITLE,
      content: chatIdDisclosureNoticeContent(chatId),
      detail: { type: 'chat-id-disclosure' },
      at: input.at,
    });
  }

  #recordFailure(
    input: ChatIdDiscoveryRequest,
    reason: ChatIdDiscoveryFailureReason,
  ): void {
    this.#appendNotice(input, {
      title: CHAT_ID_DISCLOSURE_NOTICE_TITLE,
      content: chatIdDiscoveryFailureContent(reason),
      detail: { type: 'chat-id-discovery-failure', reason },
    });
  }

  #appendNotice(
    input: ChatIdDiscoveryRequest,
    notice: Parameters<TranscriptLedgerService['appendNotice']>[2],
  ): void {
    try {
      this.options.notices.appendNotice(input.chatId, input.viewId, notice);
    } catch (error) {
      this.options.onError?.(error, input.chatId);
    }
  }
}

function failureReason(error: unknown): ChatIdDiscoveryFailureReason {
  if (!(error instanceof DomainError)) return 'delivery-failed';
  if (error.code === 'OPERATION_UNSUPPORTED') return 'unsupported';
  if (
    error.code === 'STEER_TURN_UNAVAILABLE'
    || error.code === 'STEER_TURN_CHANGED'
    || error.code === 'STEER_TURN_NOT_STEERABLE'
  ) {
    return 'turn-unavailable';
  }
  return 'delivery-failed';
}
