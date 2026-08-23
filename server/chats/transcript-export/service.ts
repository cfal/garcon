import {
  type TranscriptExportCategory,
  type TranscriptExportFormat,
  type TranscriptExportResponse,
} from '../../../common/chat-export-contracts.js';
import type { ChatSnapshotChat } from '../../../common/chat-snapshot.js';
import type { LedgerRow, TranscriptViewId } from '../../ledger/contracts.js';
import {
  filterTranscriptExportEntries,
  foldRowsForExport,
} from '../../ledger/export-fold.js';
import { DomainError } from '../../lib/domain-error.js';
import { renderTranscriptExportMarkdown } from './markdown.js';
import type { TranscriptExportDocumentModel } from './model.js';
import { renderTranscriptExportXml } from './xml.js';

export interface TranscriptExportRequest {
  readonly chatId: string;
  readonly format: TranscriptExportFormat;
  readonly exclusions: readonly TranscriptExportCategory[];
}

interface TranscriptExportServiceDeps {
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

export class TranscriptExportService {
  readonly #deps: TranscriptExportServiceDeps;

  constructor(deps: TranscriptExportServiceDeps) {
    this.#deps = deps;
  }

  async export(
    request: TranscriptExportRequest,
    signal: AbortSignal,
  ): Promise<TranscriptExportResponse> {
    const summary = this.#deps.summaries.buildSummary(request.chatId);
    if (!summary) throw new DomainError('SESSION_NOT_FOUND', 'Session not found', 404, false);

    const snapshot = await this.#deps.transcripts.exportSnapshot(request.chatId, signal);
    const allEntries = foldRowsForExport(snapshot.rows);
    const filtered = filterTranscriptExportEntries(allEntries, request.exclusions);
    const generatedAt = this.#deps.now?.() ?? new Date().toISOString();
    const model: TranscriptExportDocumentModel = {
      chat: {
        id: summary.chat.id,
        title: summary.chat.title,
        agentId: summary.chat.agentId,
        model: summary.chat.model,
      },
      omitted: filtered.omitted,
      entries: filtered.entries,
    };
    const document = request.format === 'xml'
      ? renderTranscriptExportXml(model)
      : renderTranscriptExportMarkdown(model);

    return {
      success: true,
      chatId: request.chatId,
      format: request.format,
      transcriptViewId: snapshot.transcriptViewId,
      lastOrdinal: snapshot.lastOrdinal,
      generatedAt,
      entryCount: filtered.entries.length,
      totalEntryCount: allEntries.length,
      exclusions: request.exclusions,
      omitted: filtered.omitted,
      document,
    };
  }
}
