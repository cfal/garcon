import type {
  ChatHandoffArtifactRequest,
  ChatHandoffArtifactResponse,
} from '../../../../common/chat-handoff-artifact-contracts.js';
import {
  CHAT_HANDOFF_ARTIFACT_FOLD,
  CHAT_HANDOFF_ARTIFACT_GAP_UNIT,
} from '../../../../common/chat-handoff-artifact-contracts.js';
import type { ChatSnapshotChat } from '../../../../common/chat-snapshot.js';
import { isHandoffContextWindowTokens } from '../../../../common/handoff-sizing.js';
import type { TranscriptViewReader } from '../../ledger/view-reader.js';
import { DomainError, ValidationDomainError } from '../../../common/domain-error.js';
import type { TokenFitting } from '../token-fitting/client.js';

export interface HandoffArtifactServiceDeps {
  readonly summaries: {
    buildSummary(chatId: string): { readonly chat: ChatSnapshotChat } | null;
  };
  readonly transcripts: Pick<TranscriptViewReader, 'withStoredSnapshot'>;
  readonly fitting: Pick<TokenFitting, 'renderHandoffArtifact'>;
  readonly now?: () => string;
}

export class HandoffArtifactService {
  constructor(private readonly deps: HandoffArtifactServiceDeps) {}

  async create(
    request: ChatHandoffArtifactRequest,
    signal: AbortSignal,
  ): Promise<ChatHandoffArtifactResponse> {
    if (!isHandoffContextWindowTokens(request.contextWindowTokens)) {
      throw new ValidationDomainError('Invalid handoff artifact context window');
    }
    const summary = this.deps.summaries.buildSummary(request.chatId);
    if (!summary) throw new DomainError('SESSION_NOT_FOUND', 'Session not found', 404, false);

    const rendered = await this.deps.transcripts.withStoredSnapshot(request.chatId, (snapshot) => (
      this.deps.fitting.renderHandoffArtifact({
        chat: {
          id: summary.chat.id,
          title: summary.chat.title,
          agentId: summary.chat.agentId,
          model: summary.chat.model,
        },
        transcriptViewId: snapshot.transcriptViewId,
        lastOrdinal: snapshot.lastOrdinal,
        contextWindowTokens: request.contextWindowTokens,
        rows: snapshot.rows,
      }, signal)
    ), signal);
    if (!rendered) {
      throw new ValidationDomainError(
        'The requested context window is too small for a handoff artifact',
      );
    }
    signal.throwIfAborted();
    return {
      success: true,
      chatId: request.chatId,
      transcriptViewId: rendered.transcriptViewId,
      lastOrdinal: rendered.lastOrdinal,
      generatedAt: this.deps.now?.() ?? new Date().toISOString(),
      contextWindowTokens: rendered.contextWindowTokens,
      usableTokenBudget: rendered.usableTokenBudget,
      estimatedTokens: rendered.estimatedTokens,
      fold: CHAT_HANDOFF_ARTIFACT_FOLD,
      gapUnit: CHAT_HANDOFF_ARTIFACT_GAP_UNIT,
      sourceEntryCount: rendered.sourceEntryCount,
      eligibleEntryCount: rendered.eligibleEntryCount,
      excludedEntryCounts: rendered.excludedEntryCounts,
      includedEntryCount: rendered.includedEntryCount,
      budgetOmittedEntryCount: rendered.budgetOmittedEntryCount,
      abridgedEntryCount: rendered.abridgedEntryCount,
      gapCount: rendered.gapCount,
      projectionTruncated: rendered.projectionTruncated,
      documentCodeUnits: rendered.document.length,
      document: rendered.document,
    };
  }
}
