import { parseChatId } from '../../common/chat-id.js';
import {
  chatIdDisclosureContent,
  chatIdDisclosureNoticeContent,
  CHAT_ID_DISCOVERY_NOTICE_TITLE,
  chatIdDiscoveryFailureContent,
} from '../../common/chat-id-discovery.js';
import type {
  ChatIdDiscoveryFailureReason,
} from '../../common/transcript-notice-details.js';
import type { TranscriptLedgerService } from '../ledger/service.js';
import type { TranscriptViewId } from '../ledger/contracts.js';

interface ChatIdDiscoveryRequest {
  readonly chatId: string;
  readonly viewId: TranscriptViewId;
  readonly runId: string | null;
  readonly at: string;
}

interface ChatIdDiscoveryAttempt {
  readonly abortController: AbortController;
  pending: boolean;
}

interface ChatIdDiscoveryExecution {
  deliverControlInput(
    chatId: string,
    content: string,
    transcriptViewId: string,
    emittingRunId: string | null,
    signal: AbortSignal,
    onControlRun: (turnId: string) => void,
  ): Promise<void>;
}

interface ChatIdDiscoveryControllerOptions {
  readonly execution: ChatIdDiscoveryExecution;
  readonly notices: Pick<TranscriptLedgerService, 'appendNotice'>;
  readonly isEnabled: () => boolean;
  readonly onError?: (error: unknown, chatId: string) => void;
}

export class ChatIdDiscoveryController {
  readonly #attempts = new Map<string, ChatIdDiscoveryAttempt>();
  readonly #controlRunIds = new Map<string, string>();

  constructor(private readonly options: ChatIdDiscoveryControllerOptions) {}

  request(input: ChatIdDiscoveryRequest): void {
    const hasRun = input.runId !== null;
    const controlRunId = this.#controlRunIds.get(input.chatId);
    if (controlRunId && (!hasRun || controlRunId === input.runId)) return;
    const current = this.#attempts.get(input.chatId);
    if (current?.pending) return;
    const attempt = {
      abortController: new AbortController(),
      pending: true,
    };
    this.#attempts.set(input.chatId, attempt);
    if (!this.options.isEnabled()) {
      this.#recordFailure(input, attempt, 'disabled');
      return;
    }

    let chatId: ReturnType<typeof parseChatId>;
    try {
      chatId = parseChatId(input.chatId);
    } catch (error) {
      this.options.onError?.(error, input.chatId);
      this.#recordFailure(input, attempt, 'delivery-failed');
      return;
    }

    let delivery: Promise<void>;
    try {
      delivery = this.options.execution.deliverControlInput(
        input.chatId,
        chatIdDisclosureContent(chatId),
        input.viewId,
        input.runId,
        attempt.abortController.signal,
        (turnId) => this.#controlRunIds.set(input.chatId, turnId),
      );
    } catch (error) {
      this.options.onError?.(error, input.chatId);
      this.#recordFailure(input, attempt, 'delivery-failed');
      return;
    }
    void delivery.then(
      () => this.#recordSuccess(input, attempt, chatId),
      (error) => {
        if (attempt.abortController.signal.aborted) return;
        this.options.onError?.(error, input.chatId);
        this.#recordFailure(input, attempt, 'delivery-failed');
      },
    );
  }

  discard(chatId: string): void {
    this.#attempts.get(chatId)?.abortController.abort();
    this.#attempts.delete(chatId);
    this.#controlRunIds.delete(chatId);
  }

  #recordSuccess(
    input: ChatIdDiscoveryRequest,
    attempt: ChatIdDiscoveryAttempt,
    chatId: ReturnType<typeof parseChatId>,
  ): void {
    this.#record(input, attempt, {
      title: CHAT_ID_DISCOVERY_NOTICE_TITLE,
      content: chatIdDisclosureNoticeContent(chatId),
      detail: { type: 'chat-id-disclosure' },
      at: input.at,
    });
  }

  #recordFailure(
    input: ChatIdDiscoveryRequest,
    attempt: ChatIdDiscoveryAttempt,
    reason: ChatIdDiscoveryFailureReason,
  ): void {
    this.#record(input, attempt, {
      title: CHAT_ID_DISCOVERY_NOTICE_TITLE,
      content: chatIdDiscoveryFailureContent(reason),
      detail: { type: 'chat-id-discovery-failure', reason },
      at: input.at,
    });
  }

  #record(
    input: ChatIdDiscoveryRequest,
    attempt: ChatIdDiscoveryAttempt,
    notice: Parameters<TranscriptLedgerService['appendNotice']>[2],
  ): void {
    if (this.#attempts.get(input.chatId) !== attempt) return;
    attempt.pending = false;
    try {
      this.options.notices.appendNotice(input.chatId, input.viewId, notice);
    } catch (error) {
      this.options.onError?.(error, input.chatId);
    }
  }
}
