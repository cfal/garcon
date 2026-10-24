import { parseStoredJson } from '../../../common/stored-json.js';
import { decodeClonedStoredRows } from '../../ledger/codec.js';
import { ledgerRowsToMessages } from '../../ledger/presentation.js';
import { renderSharedChatText } from '../shares/transcript.ts';
import { withholdExecutionContext } from '../shares/public-messages.ts';
import {
  decodeLegacyShareSnapshot,
  decodeShareSnapshot,
  encodeShareSnapshot,
  type ShareSnapshotHeader,
} from '../shares/snapshot-format.js';
import {
  buildTranscriptExportResponse,
  type TranscriptExportDocumentRequest,
} from '../transcript-export/document.js';

export interface RenderedShareSnapshot {
  readonly header: ShareSnapshotHeader;
  readonly snapshot: Uint8Array;
  readonly text: Uint8Array;
}

// A share's stored snapshot: one JSON document from before messages moved one per line,
// or the line-delimited form.
export type ShareSnapshotFormat = 'document' | 'lines';

// Task parameters exclude the transcript items, which cross to the Worker separately in
// bounded batches: stored ledger rows, or a stored share snapshot's text.
export type TranscriptRenderingTask =
  | ({ readonly kind: 'render-transcript-export' } & TranscriptExportDocumentRequest)
  | { readonly kind: 'render-share-snapshot'; readonly header: Omit<ShareSnapshotHeader, 'messageCount'> }
  | { readonly kind: 'upgrade-share-snapshot'; readonly shareToken: string; readonly format: ShareSnapshotFormat };

export type TranscriptRenderingTaskKind = TranscriptRenderingTask['kind'];

export interface TranscriptRenderingResults {
  // The complete JSON response body.
  readonly 'render-transcript-export': Uint8Array<ArrayBuffer>;
  readonly 'render-share-snapshot': RenderedShareSnapshot;
  readonly 'upgrade-share-snapshot': RenderedShareSnapshot | null;
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
  'upgrade-share-snapshot': ({ shareToken, format }, items) => {
    if (items.length !== 1 || typeof items[0] !== 'string') {
      throw new Error('Transcript rendering received an invalid share snapshot');
    }
    const stored = decodeStoredShareSnapshot(shareToken, format, items[0]);
    if (!stored) return null;
    const { messages, ...header } = stored;
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

function decodeStoredShareSnapshot(
  shareToken: string,
  format: ShareSnapshotFormat,
  text: string,
): (Omit<ShareSnapshotHeader, 'messageCount'> & { readonly messages: readonly unknown[] }) | null {
  if (format === 'document') {
    return decodeLegacyShareSnapshot(shareToken, parseStoredJson(text, 'Share snapshot'));
  }
  const stored = decodeShareSnapshot(shareToken, text);
  if (!stored) return null;
  const { messageCount: _messageCount, ...header } = stored.header;
  return { ...header, messages: stored.messages.map(line => parseStoredJson(line, 'Share message')) };
}

// Every artifact a share writes, the public snapshot and its plain text, holds the
// projected messages.
function renderShareSnapshot(header: ShareSnapshotHeader, storedMessages: readonly unknown[]): RenderedShareSnapshot {
  const messages = storedMessages.map(withholdExecutionContext);
  return {
    header,
    snapshot: encoder.encode(encodeShareSnapshot(header, messages)),
    text: encoder.encode(renderSharedChatText({ ...header, messages: [...messages] })),
  };
}
