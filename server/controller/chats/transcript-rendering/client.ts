import type { StoredLedgerRow } from '../../ledger/codec.js';
import { TaskWorker } from '../../lib/task-worker.js';
import type { ShareSnapshotHeader } from '../shares/snapshot-format.js';
import type { TranscriptExportDocumentRequest } from '../transcript-export/document.js';
import type {
  RenderedShareSnapshot,
  ShareSnapshotFormat,
  TranscriptRenderingResults,
  TranscriptRenderingTask,
} from './tasks.js';

const WORKER_SOURCE_URL = new URL('./worker-main.ts', import.meta.url);

export interface TranscriptRendering {
  renderTranscriptExport(
    input: TranscriptExportDocumentRequest & { readonly rows: readonly StoredLedgerRow[] },
    signal?: AbortSignal,
  ): Promise<Uint8Array<ArrayBuffer>>;
  renderShareSnapshot(
    input: {
      readonly header: Omit<ShareSnapshotHeader, 'messageCount'>;
      readonly rows: readonly StoredLedgerRow[];
    },
    signal?: AbortSignal,
  ): Promise<RenderedShareSnapshot>;
  // Renders the snapshot stored at a path again with the current renderer; null when it
  // is unreadable. The caller keeps the file in place until the rendering settles.
  upgradeShareSnapshot(
    shareToken: string,
    format: ShareSnapshotFormat,
    snapshotPath: string,
    signal?: AbortSignal,
  ): Promise<RenderedShareSnapshot | null>;
}

// Renders whole transcripts into export and share documents on a Worker, from rows as the
// ledger stores them, so neither decoding nor rendering runs on the controller's event loop.
export class TranscriptRenderingWorker implements TranscriptRendering {
  readonly #worker = new TaskWorker<TranscriptRenderingTask, TranscriptRenderingResults>({
    worker: 'transcript-rendering',
    sourceUrl: WORKER_SOURCE_URL,
    label: 'Transcript rendering',
  });

  renderTranscriptExport(
    { rows, ...request }: TranscriptExportDocumentRequest & { readonly rows: readonly StoredLedgerRow[] },
    signal?: AbortSignal,
  ): Promise<Uint8Array<ArrayBuffer>> {
    return this.#worker.run({ kind: 'render-transcript-export', ...request }, rows, signal);
  }

  renderShareSnapshot(
    { header, rows }: {
      readonly header: Omit<ShareSnapshotHeader, 'messageCount'>;
      readonly rows: readonly StoredLedgerRow[];
    },
    signal?: AbortSignal,
  ): Promise<RenderedShareSnapshot> {
    return this.#worker.run({ kind: 'render-share-snapshot', header }, rows, signal);
  }

  upgradeShareSnapshot(
    shareToken: string,
    format: ShareSnapshotFormat,
    snapshotPath: string,
    signal?: AbortSignal,
  ): Promise<RenderedShareSnapshot | null> {
    return this.#worker.run({ kind: 'upgrade-share-snapshot', shareToken, format, snapshotPath }, [], signal);
  }

  close(): void {
    this.#worker.close();
  }
}
