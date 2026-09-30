import type {
  TranscriptExportCategory,
  TranscriptExportFormat,
  TranscriptExportResponse,
} from '../../../../common/chat-export-contracts.js';
import type { LedgerRow } from '../../ledger/contracts.js';
import {
  filterTranscriptExportEntries,
  foldRowsForExport,
} from '../../ledger/export-fold.js';
import { renderTranscriptExportMarkdown } from './markdown.js';
import type { TranscriptExportChatMetadata } from './model.js';
import { renderTranscriptExportXml } from './xml.js';

export interface TranscriptExportDocumentRequest {
  readonly chat: TranscriptExportChatMetadata;
  readonly transcriptViewId: string;
  readonly lastOrdinal: number;
  readonly generatedAt: string;
  readonly format: TranscriptExportFormat;
  readonly exclusions: readonly TranscriptExportCategory[];
}

// Builds the complete export response. Its cost grows with the transcript, so the controller
// runs it on the transcript rendering Worker.
export function buildTranscriptExportResponse(
  request: TranscriptExportDocumentRequest,
  rows: readonly LedgerRow[],
): TranscriptExportResponse {
  const allEntries = foldRowsForExport(rows);
  const filtered = filterTranscriptExportEntries(allEntries, request.exclusions);
  const model = { chat: request.chat, omitted: filtered.omitted, entries: filtered.entries };
  return {
    success: true,
    chatId: request.chat.id,
    format: request.format,
    transcriptViewId: request.transcriptViewId,
    lastOrdinal: request.lastOrdinal,
    generatedAt: request.generatedAt,
    entryCount: filtered.entries.length,
    totalEntryCount: allEntries.length,
    exclusions: request.exclusions,
    omitted: filtered.omitted,
    document: request.format === 'xml'
      ? renderTranscriptExportXml(model)
      : renderTranscriptExportMarkdown(model),
  };
}
