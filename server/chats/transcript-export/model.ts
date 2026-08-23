import type { TranscriptExportOmittedCount } from '../../../common/chat-export-contracts.js';
import type { TranscriptExportEntry } from '../../ledger/export-fold.js';

export interface TranscriptExportChatMetadata {
  readonly id: string;
  readonly title: string;
  readonly agentId: string;
  readonly model: string | null;
}

export interface TranscriptExportDocumentModel {
  readonly chat: TranscriptExportChatMetadata;
  readonly omitted: readonly TranscriptExportOmittedCount[];
  readonly entries: readonly TranscriptExportEntry[];
}
