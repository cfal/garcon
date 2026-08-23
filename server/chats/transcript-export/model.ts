import type {
  TranscriptExportCategory,
  TranscriptExportOmittedCount,
} from '../../../common/chat-export-contracts.js';
import type { TranscriptExportEntry } from '../../ledger/export-fold.js';

export interface TranscriptExportChatMetadata {
  readonly id: string;
  readonly title: string;
  readonly agentId: string;
  readonly model: string | null;
  readonly projectPath: string;
}

export interface TranscriptExportDocumentModel {
  readonly chat: TranscriptExportChatMetadata;
  readonly transcriptViewId: string;
  readonly lastOrdinal: number;
  readonly generatedAt: string;
  readonly totalEntryCount: number;
  readonly exclusions: readonly TranscriptExportCategory[];
  readonly omitted: readonly TranscriptExportOmittedCount[];
  readonly entries: readonly TranscriptExportEntry[];
}
