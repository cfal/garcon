import type {
  ChatHandoffArtifactRequest,
  ChatHandoffArtifactResponse,
} from '../../../common/chat-handoff-artifact-contracts.js';
import {
  CHAT_HANDOFF_ARTIFACT_FOLD,
  CHAT_HANDOFF_ARTIFACT_GAP_UNIT,
} from '../../../common/chat-handoff-artifact-contracts.js';
import type { ChatSnapshotChat } from '../../../common/chat-snapshot.js';
import { isHandoffContextWindowTokens } from '../../../common/handoff-sizing.js';
import type { LedgerRow, TranscriptViewId } from '../../ledger/contracts.js';
import { foldRowsForExport } from '../../ledger/export-fold.js';
import { DomainError, ValidationDomainError } from '../../lib/domain-error.js';
import { foldHandoffArtifactEntries } from './projection.js';
import { renderFittedHandoffArtifact } from './xml.js';

export interface HandoffArtifactServiceDeps {
  readonly summaries: {
    buildSummary(chatId: string): { readonly chat: ChatSnapshotChat } | null;
  };
  readonly transcripts: {
    exportSnapshot(chatId: string, signal?: AbortSignal): Promise<{
      readonly transcriptViewId: TranscriptViewId;
      readonly lastOrdinal: number;
      readonly rows: readonly LedgerRow[];
    }>;
  };
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

    const snapshot = await this.deps.transcripts.exportSnapshot(request.chatId, signal);
    const sourceFold = foldHandoffArtifactEntries(foldRowsForExport(snapshot.rows), signal);
    const rendered = renderFittedHandoffArtifact({
      chat: {
        id: summary.chat.id,
        title: summary.chat.title,
        agentId: summary.chat.agentId,
        model: summary.chat.model,
      },
      transcriptViewId: snapshot.transcriptViewId,
      lastOrdinal: snapshot.lastOrdinal,
      contextWindowTokens: request.contextWindowTokens,
      sourceFold,
      signal,
    });
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
