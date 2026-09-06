import { isDeepStrictEqual } from 'node:util';
import type {
  ChatPreambleSelectionTargetResponse,
  UpdateChatPreambleSelectionRequest,
} from '../../common/chat-preamble-selection-contracts.js';
import {
  type ChatPreambleSelection,
  type PendingPreambleBoundary,
  type PreambleSelectionProjection,
  type PreamblesSnapshot,
} from '../../common/preambles.js';
import { stableJsonStringify } from '../../common/json.js';
import type { AgentOwnershipJournal } from '../chats/agent-ownership-journal.js';
import type { ChatRegistryEntry, IChatRegistry } from '../chats/store.js';
import {
  ChatRegistryDurabilityUnknownError,
} from '../chats/store.js';
import { ownershipTransferPendingError } from '../agents/ownership-transfer-fence.js';
import { DomainError } from '../lib/domain-error.js';
import type { KeyedPromiseLock } from '../lib/keyed-lock.js';
import type { TranscriptAdoptionService } from '../ledger/adoption.js';
import {
  LedgerFencedError,
  StaleTranscriptViewError,
} from '../ledger/errors.js';
import type { TranscriptLedgerService } from '../ledger/service.js';
import { isLedgerPreambleSelectionChangedNoticeRow } from '../ledger/contracts.js';
import type { PreambleService } from './service.js';
import {
  assertPreambleSelectionComposition,
  projectPreambleSelection,
  resolvePreambleSelection,
} from './selection.js';

export interface ChatPreambleSelectionUpdateOutcome {
  readonly status: 'updated' | 'unchanged' | 'duplicate';
  readonly mutationRevision: number;
  readonly noticeOrdinal: number | null;
  readonly selection: ChatPreambleSelection;
  readonly projection: PreambleSelectionProjection;
}

// Raised when the registry decision committed but its presentation notice did
// not. Reports the committed state honestly; the caller never sees a rollback.
export class ChatPreambleSelectionPartialError extends DomainError {
  constructor(
    readonly selectionCommitted: true | 'unknown',
    message: string,
    readonly selection: ChatPreambleSelection | null,
  ) {
    super(
      selectionCommitted === true
        ? 'PREAMBLE_SELECTION_NOTICE_FAILED'
        : 'PREAMBLE_SELECTION_SAVE_UNKNOWN',
      message,
      503,
      false,
    );
    this.name = 'ChatPreambleSelectionPartialError';
  }
}
export interface ChatPreambleSelectionServiceDeps {
  readonly registry: Pick<
    IChatRegistry,
    'getChat' | 'updateChatPhased' | 'reconcileUnknownDurability'
  >;
  readonly adoption: Pick<TranscriptAdoptionService, 'ensure'>;
  readonly ledger: Pick<
    TranscriptLedgerService,
    | 'appendSelectionChangeNotice'
    | 'findSubmissionRow'
    | 'hasPreambleBoundaryProof'
  >;
  readonly preambles: Pick<PreambleService, 'snapshot'>;
  readonly ownershipJournal: Pick<AgentOwnershipJournal, 'hasPending'>;
  readonly chatMutationLock: KeyedPromiseLock;
  readonly selectionAdmissionLock: KeyedPromiseLock;
  readonly now?: () => string;
  // Invoked after a committed decision so the wiring can schedule the per-chat
  // invalidation behind the notice's own row fanout.
  readonly onSelectionCommitted?: (chatId: string, revision: number) => void;
}

export class ChatPreambleSelectionService {
  constructor(private readonly deps: ChatPreambleSelectionServiceDeps) {}

  async target(chatId: string, signal: AbortSignal): Promise<ChatPreambleSelectionTargetResponse> {
    // Reconciliation, adoption, and the registry re-read run under the shared
    // chat mutation boundary so the reported view, selection, and project path
    // describe one coherent chat state.
    return this.deps.chatMutationLock.runExclusive(`chat:${chatId}`, async () => {
      // A GET reconciles a durability-unknown phased commit before reporting
      // state, so a client can recover into editing only after the server has
      // confirmed the committed candidate is durably persisted.
      const reconciliation = await this.deps.registry.reconcileUnknownDurability?.(chatId);
      signal.throwIfAborted();
      if (reconciliation === 'still-unknown') {
        throw new ChatPreambleSelectionPartialError(
          'unknown',
          'The saved selection could not be confirmed yet. Refresh again before editing.',
          null,
        );
      }
      if (reconciliation === 'unavailable') {
        throw new DomainError('SESSION_NOT_FOUND', 'Session not found', 404, false);
      }
      const view = await this.#withTranscriptErrors(
        () => this.deps.adoption.ensure(chatId, signal),
      );
      // Re-read after adoption: the ensure can adopt a view across an await,
      // and the view, selection, and project path must describe the same chat.
      const session = this.#requireChat(chatId);
      const selection: ChatPreambleSelection = {
        revision: session.preambleSelection.revision,
        orderedPreambleIds: [...session.preambleSelection.orderedPreambleIds],
      };
      return {
        success: true,
        chatId,
        transcriptViewId: view.viewId,
        canonicalProjectPath: session.projectPath,
        selection,
        projection: projectPreambleSelection(
          selection,
          this.deps.preambles.snapshot(),
          session.projectPath,
        ),
      };
    });
  }

  async update(
    input: UpdateChatPreambleSelectionRequest,
  ): Promise<ChatPreambleSelectionUpdateOutcome> {
    // Lock order is fixed: the chat mutation lock precedes the narrow
    // selection/admission lock, which queue admission never inverts.
    return this.deps.chatMutationLock.runExclusive(`chat:${input.chatId}`, () =>
      this.deps.selectionAdmissionLock.runExclusive(`chat:${input.chatId}`, () =>
        this.#updateLocked(input)));
  }

  async #updateLocked(
    input: UpdateChatPreambleSelectionRequest,
  ): Promise<ChatPreambleSelectionUpdateOutcome> {
    const chatId = input.chatId;
    const session = this.#requireChat(chatId);
    const view = await this.#withTranscriptErrors(() => this.deps.adoption.ensure(chatId));
    if (view.viewId !== input.transcriptViewId) {
      throw new DomainError(
        'STALE_TRANSCRIPT_VIEW',
        'The transcript changed before the selection was saved.',
        409,
        false,
      );
    }
    if (this.deps.ownershipJournal.hasPending(chatId)) {
      throw ownershipTransferPendingError();
    }

    // The durable notice identity is checked only after the request's view is
    // proven current, so a retry can never deduplicate into another view.
    const requestFingerprint = selectionRequestFingerprint(input);
    const existingSubmission = this.deps.ledger.findSubmissionRow(
      chatId,
      view.viewId,
      input.clientMessageId,
    );
    if (existingSubmission) {
      // A user-input or CLI-row collision for this identity is a conflict, not
      // a selection duplicate.
      if (
        !isLedgerPreambleSelectionChangedNoticeRow(existingSubmission)
        || existingSubmission.detail.requestFingerprint !== requestFingerprint
      ) {
        throw new DomainError(
          'IDEMPOTENCY_CONFLICT',
          'The selection notice identity was already used for a different request.',
          409,
          false,
        );
      }
      return this.#outcome(
        session,
        this.deps.preambles.snapshot(),
        'duplicate',
        existingSubmission.detail.selectionRevision,
        existingSubmission.ordinal,
        session.preambleSelection,
      );
    }

    if (session.preambleSelection.revision !== input.expectedRevision) {
      throw new DomainError(
        'PREAMBLE_SELECTION_REVISION_CONFLICT',
        'The chat preamble selection changed in another client; refresh and try again.',
        409,
        true,
      );
    }

    if (isDeepStrictEqual(
      session.preambleSelection.orderedPreambleIds,
      input.orderedPreambleIds,
    )) {
      // An unchanged Save is a no-op before composition validation: it creates
      // no revision, notice, invalidation, or reapplication.
      return this.#outcome(
        session,
        this.deps.preambles.snapshot(),
        'unchanged',
        session.preambleSelection.revision,
        null,
        session.preambleSelection,
      );
    }

    if (input.expectedRevision === Number.MAX_SAFE_INTEGER) {
      throw new DomainError(
        'PREAMBLE_REVISION_EXHAUSTED',
        'Preamble selection revision limit reached',
        409,
      );
    }

    const catalog = this.deps.preambles.snapshot();
    const nextSelection: ChatPreambleSelection = {
      revision: input.expectedRevision + 1,
      orderedPreambleIds: [...input.orderedPreambleIds],
    };
    const resolved = resolvePreambleSelection(nextSelection, catalog, session.projectPath);
    assertPreambleSelectionComposition(chatId, resolved.eligible);

    const nextBoundary = this.#nextBoundary(chatId, session, nextSelection.revision);
    let durability: 'durable' | 'unknown';
    try {
      const result = await this.deps.registry.updateChatPhased(chatId, {
        preambleSelection: nextSelection,
        pendingPreambleBoundary: nextBoundary,
      });
      if (!result) throw new DomainError('SESSION_NOT_FOUND', 'Session not found', 404, false);
      durability = result.durability;
    } catch (error) {
      if (error instanceof ChatRegistryDurabilityUnknownError) {
        throw new ChatPreambleSelectionPartialError(
          'unknown',
          'The selection could not be saved because an earlier save has unconfirmed durability. Refresh and try again.',
          null,
        );
      }
      throw error;
    }
    if (durability === 'unknown') {
      this.#notifySelectionCommitted(chatId, nextSelection.revision);
      throw new ChatPreambleSelectionPartialError(
        'unknown',
        'The selection was saved, but its durability could not be confirmed. Refresh before another edit.',
        nextSelection,
      );
    }

    const committedSelection: ChatPreambleSelection = {
      revision: nextSelection.revision,
      orderedPreambleIds: [...nextSelection.orderedPreambleIds],
    };
    try {
      const notice = this.deps.ledger.appendSelectionChangeNotice({
        chatId,
        viewId: view.viewId,
        at: (this.deps.now ?? (() => new Date().toISOString()))(),
        detail: {
          type: 'preamble-selection-change',
          clientMessageId: input.clientMessageId,
          requestFingerprint,
          selectionRevision: nextSelection.revision,
          preambles: resolved.eligible.map(({ id, title }) => ({ id, title })),
        },
      });
      // A committed notice's invalidation is derived by the server event
      // wiring from the committed row itself; no direct callback here.
      return this.#outcome(
        session,
        catalog,
        notice.inserted ? 'updated' : 'duplicate',
        notice.row.detail.selectionRevision,
        notice.row.ordinal,
        committedSelection,
      );
    } catch (error) {
      if (error instanceof ChatRegistryDurabilityUnknownError) throw error;
      this.#notifySelectionCommitted(chatId, nextSelection.revision);
      throw new ChatPreambleSelectionPartialError(
        true,
        'The selection was saved, but its transcript notice could not be recorded.',
        committedSelection,
      );
    }
  }

  // A stale, ledger-proven boundary is replaced; an unconsumed lifecycle
  // boundary is retained and its first input resolves the newest selection.
  #nextBoundary(
    chatId: string,
    session: ChatRegistryEntry,
    nextRevision: number,
  ): PendingPreambleBoundary {
    const current = session.pendingPreambleBoundary;
    if (current && current.kind !== 'selection-change') {
      if (!this.deps.ledger.hasPreambleBoundaryProof(chatId, current)) return current;
    }
    return {
      kind: 'selection-change',
      ownershipEpoch: session.agentOwnershipEpoch,
      selectionRevision: nextRevision,
    };
  }

  #notifySelectionCommitted(chatId: string, revision: number): void {
    // Only partial outcomes reach this hook: a committed notice's invalidation
    // is scheduled by the server event wiring directly behind the notice's own
    // chat-messages fanout. With no committed row, the invalidation goes out
    // immediately and synchronously.
    this.deps.onSelectionCommitted?.(chatId, revision);
  }

  #requireChat(chatId: string) {
    const session = this.deps.registry.getChat(chatId);
    if (!session) throw new DomainError('SESSION_NOT_FOUND', 'Session not found', 404, false);
    return session;
  }

  #outcome(
    session: ChatRegistryEntry,
    catalog: PreamblesSnapshot,
    status: ChatPreambleSelectionUpdateOutcome['status'],
    mutationRevision: number,
    noticeOrdinal: number | null,
    selection: ChatPreambleSelection,
  ): ChatPreambleSelectionUpdateOutcome {
    return {
      status,
      mutationRevision,
      noticeOrdinal,
      selection: {
        revision: selection.revision,
        orderedPreambleIds: [...selection.orderedPreambleIds],
      },
      projection: projectPreambleSelection(
        selection,
        catalog,
        session.projectPath,
      ),
    };
  }

  async #withTranscriptErrors<T>(work: () => T | Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof StaleTranscriptViewError) {
        throw new DomainError(
          'STALE_TRANSCRIPT_VIEW',
          'The transcript changed before the selection was saved.',
          409,
          false,
          { cause: error },
        );
      }
      if (error instanceof LedgerFencedError) {
        throw new DomainError(
          'TRANSCRIPT_UNAVAILABLE',
          'The transcript is unavailable.',
          422,
          false,
          { cause: error },
        );
      }
      throw error;
    }
  }
}

function selectionRequestFingerprint(input: UpdateChatPreambleSelectionRequest): string {
  return stableJsonStringify({
    chatId: input.chatId,
    transcriptViewId: input.transcriptViewId,
    expectedRevision: input.expectedRevision,
    orderedPreambleIds: input.orderedPreambleIds,
  });
}
