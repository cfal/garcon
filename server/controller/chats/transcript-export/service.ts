import type {
  TranscriptExportCategory,
  TranscriptExportFormat,
} from '../../../../common/chat-export-contracts.js';
import type { ChatSnapshotChat } from '../../../../common/chat-snapshot.js';
import type { TranscriptViewReader } from '../../ledger/view-reader.js';
import { DomainError } from '../../../common/domain-error.js';
import type { TranscriptRendering } from '../transcript-rendering/client.js';

export interface TranscriptExportRequest {
  readonly chatId: string;
  readonly format: TranscriptExportFormat;
  readonly exclusions: readonly TranscriptExportCategory[];
}

interface TranscriptExportServiceDeps {
  readonly summaries: {
    buildSummary(chatId: string): { readonly chat: ChatSnapshotChat } | null;
  };
  readonly transcripts: Pick<TranscriptViewReader, 'withStoredSnapshot'>;
  readonly rendering: Pick<TranscriptRendering, 'renderTranscriptExport'>;
  readonly now?: () => string;
}

export class TranscriptExportService {
  readonly #deps: TranscriptExportServiceDeps;

  constructor(deps: TranscriptExportServiceDeps) {
    this.#deps = deps;
  }

  // Returns the encoded TranscriptExportResponse, which the rendering Worker builds whole so
  // the controller never holds the document as a string.
  async export(
    request: TranscriptExportRequest,
    signal: AbortSignal,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const summary = this.#deps.summaries.buildSummary(request.chatId);
    if (!summary) throw new DomainError('SESSION_NOT_FOUND', 'Session not found', 404, false);

    return this.#deps.transcripts.withStoredSnapshot(request.chatId, (snapshot) => (
      this.#deps.rendering.renderTranscriptExport({
        chat: {
          id: summary.chat.id,
          title: summary.chat.title,
          agentId: summary.chat.agentId,
          model: summary.chat.model,
        },
        transcriptViewId: snapshot.transcriptViewId,
        lastOrdinal: snapshot.lastOrdinal,
        generatedAt: this.#deps.now?.() ?? new Date().toISOString(),
        format: request.format,
        exclusions: request.exclusions,
        rows: snapshot.rows,
      }, signal)
    ), signal);
  }
}
