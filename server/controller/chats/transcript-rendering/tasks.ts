import { decodeClonedStoredRows } from '../../ledger/codec.js';
import { ledgerRowsToMessages } from '../../ledger/presentation.js';
import { renderSharedChatText } from '../share-transcript.ts';
import {
  decodeLegacyShareSnapshot,
  encodeShareSnapshot,
  type ShareSnapshotHeader,
} from '../share-snapshot-format.js';
import {
  buildTranscriptExportResponse,
  type TranscriptExportDocumentRequest,
} from '../transcript-export/document.js';

export interface RenderedShareSnapshot {
  readonly header: ShareSnapshotHeader;
  readonly snapshot: Uint8Array;
  readonly text: Uint8Array;
}

// Task parameters exclude the transcript items, which cross to the Worker separately in
// bounded batches: stored ledger rows, or a legacy snapshot's JSON text.
export type TranscriptRenderingTask =
  | ({ readonly kind: 'render-transcript-export' } & TranscriptExportDocumentRequest)
  | { readonly kind: 'render-share-snapshot'; readonly header: Omit<ShareSnapshotHeader, 'messageCount'> }
  | { readonly kind: 'convert-share-snapshot'; readonly shareToken: string };

export type TranscriptRenderingTaskKind = TranscriptRenderingTask['kind'];

export interface TranscriptRenderingResults {
  // The complete JSON response body.
  readonly 'render-transcript-export': Uint8Array<ArrayBuffer>;
  readonly 'render-share-snapshot': RenderedShareSnapshot;
  readonly 'convert-share-snapshot': RenderedShareSnapshot | null;
}

type TaskHandlers = {
  readonly [K in TranscriptRenderingTaskKind]: (
    task: Extract<TranscriptRenderingTask, { readonly kind: K }>,
    items: readonly unknown[],
  ) => TranscriptRenderingResults[K];
};

const encoder = new TextEncoder();

const TASK_HANDLERS: TaskHandlers = {
  'render-transcript-export': ({ kind: _kind, ...request }, items) => encoder.encode(
    JSON.stringify(buildTranscriptExportResponse(request, decodeClonedStoredRows(items))),
  ),
  'render-share-snapshot': ({ header }, items) => {
    const messages = ledgerRowsToMessages(decodeClonedStoredRows(items));
    return renderShareSnapshot({ ...header, messageCount: messages.length }, messages);
  },
  'convert-share-snapshot': ({ shareToken }, items) => {
    if (items.length !== 1 || typeof items[0] !== 'string') {
      throw new Error('Transcript rendering received an invalid share snapshot');
    }
    const legacy = decodeLegacyShareSnapshot(shareToken, JSON.parse(items[0]));
    if (!legacy) return null;
    const { messages, ...header } = legacy;
    return renderShareSnapshot({ ...header, messageCount: messages.length }, messages);
  },
};

export const TRANSCRIPT_RENDERING_TASK_KINDS = Object.keys(TASK_HANDLERS) as readonly TranscriptRenderingTaskKind[];

export function runTranscriptRenderingTask<K extends TranscriptRenderingTaskKind>(
  task: Extract<TranscriptRenderingTask, { readonly kind: K }>,
  items: readonly unknown[],
): TranscriptRenderingResults[K] {
  const handler = TASK_HANDLERS[task.kind] as TaskHandlers[K];
  return handler(task, items);
}

function renderShareSnapshot(header: ShareSnapshotHeader, messages: readonly unknown[]): RenderedShareSnapshot {
  return {
    header,
    snapshot: encoder.encode(encodeShareSnapshot(header, messages)),
    text: encoder.encode(renderSharedChatText({ ...header, messages: [...messages] })),
  };
}
