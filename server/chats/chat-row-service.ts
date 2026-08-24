import type { AgentLogger } from '@garcon/server-agent-interface';
import type {
  AddChatRowRequest,
  AddChatRowResponse,
  ChatRowTargetResponse,
} from '../../common/chat-row-contracts.js';
import type { AgentOwnershipJournal } from './agent-ownership-journal.js';
import type { IChatRegistry } from './store.js';
import { ownershipTransferPendingError } from '../agents/ownership-transfer-fence.js';
import { DomainError, TRANSCRIPT_UNAVAILABLE_MESSAGE } from '../lib/domain-error.js';
import type { KeyedPromiseLock } from '../lib/keyed-lock.js';
import type { TranscriptAdoptionService } from '../ledger/adoption.js';
import { transcriptViewId } from '../ledger/contracts.js';
import {
  LedgerFencedError,
  safeFenceDiagnostic,
  StaleTranscriptViewError,
  SubmissionConflictError,
} from '../ledger/errors.js';
import type { TranscriptLedgerService } from '../ledger/service.js';

export interface ChatRowServiceOptions {
  readonly registry: Pick<IChatRegistry, 'getChat'>;
  readonly adoption: Pick<TranscriptAdoptionService, 'ensure'>;
  readonly ledger: Pick<TranscriptLedgerService, 'appendChatRow'>;
  readonly ownershipJournal: Pick<AgentOwnershipJournal, 'hasPending'>;
  readonly chatMutationLock: KeyedPromiseLock;
  readonly logger: Pick<AgentLogger, 'warn'>;
}

export class ChatRowService {
  constructor(private readonly options: ChatRowServiceOptions) {}

  async target(chatId: string, signal: AbortSignal): Promise<ChatRowTargetResponse> {
    this.#requireChat(chatId);
    const view = await this.#withTranscriptErrors(
      () => this.options.adoption.ensure(chatId, signal),
    );
    return { success: true, chatId, transcriptViewId: view.viewId };
  }

  async add(input: AddChatRowRequest, signal: AbortSignal): Promise<AddChatRowResponse> {
    this.#requireChat(input.chatId);
    await this.#withTranscriptErrors(
      () => this.options.adoption.ensure(input.chatId, signal),
    );
    return this.options.chatMutationLock.runExclusive(`chat:${input.chatId}`, async () => {
      this.#requireChat(input.chatId);
      if (this.options.ownershipJournal.hasPending(input.chatId)) {
        throw ownershipTransferPendingError();
      }
      signal.throwIfAborted();
      const result = await this.#withTranscriptErrors(() => this.options.ledger.appendChatRow({
        chatId: input.chatId,
        viewId: transcriptViewId(input.transcriptViewId),
        clientMessageId: input.clientMessageId,
        presentation: input.presentation,
        format: input.format,
        title: input.title,
        content: input.content,
      }));
      return {
        success: true,
        commandType: 'chat-row-add',
        clientRequestId: input.clientRequestId,
        clientMessageId: input.clientMessageId,
        chatId: input.chatId,
        transcriptViewId: result.row.viewId,
        ordinal: result.row.ordinal,
        presentation: result.row.detail.presentation,
        format: result.row.detail.format,
        status: result.inserted ? 'appended' : 'duplicate',
        timestamp: result.row.at,
      };
    });
  }

  #requireChat(chatId: string): void {
    if (!this.options.registry.getChat(chatId)) {
      throw new DomainError('SESSION_NOT_FOUND', 'Session not found', 404, false);
    }
  }

  async #withTranscriptErrors<T>(work: () => T | Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof StaleTranscriptViewError) {
        throw new DomainError(
          'STALE_TRANSCRIPT_VIEW',
          'The transcript changed before the row was added.',
          409,
          false,
          { cause: error },
        );
      }
      if (error instanceof SubmissionConflictError) {
        throw new DomainError(
          'IDEMPOTENCY_CONFLICT',
          'The row identity was already used for different content.',
          409,
          false,
          { cause: error },
        );
      }
      if (error instanceof LedgerFencedError) {
        const diagnostic = safeFenceDiagnostic(error);
        this.options.logger.warn(
          'Chat row mutation encountered a fenced transcript ledger.',
          {
            causeName: diagnostic.causeName,
            causeCode: diagnostic.causeCode,
          },
        );
        throw new DomainError(
          'TRANSCRIPT_UNAVAILABLE',
          TRANSCRIPT_UNAVAILABLE_MESSAGE,
          422,
          false,
          { cause: error },
        );
      }
      throw error;
    }
  }
}
