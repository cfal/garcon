import { decodeClonedStoredRows } from '../../ledger/codec.js';
import {
  buildTranscriptExportResponse,
  type TranscriptExportDocumentRequest,
} from '../transcript-export/document.js';

// Task parameters exclude the transcript items, which cross to the Worker separately in
// bounded batches as stored ledger rows.
export type TranscriptRenderingTask =
  | ({ readonly kind: 'render-transcript-export' } & TranscriptExportDocumentRequest);

export type TranscriptRenderingTaskKind = TranscriptRenderingTask['kind'];

export interface TranscriptRenderingResults {
  // The complete JSON response body.
  readonly 'render-transcript-export': Uint8Array<ArrayBuffer>;
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
};

export const TRANSCRIPT_RENDERING_TASK_KINDS = Object.keys(TASK_HANDLERS) as readonly TranscriptRenderingTaskKind[];

export function runTranscriptRenderingTask<K extends TranscriptRenderingTaskKind>(
  task: Extract<TranscriptRenderingTask, { readonly kind: K }>,
  items: readonly unknown[],
): TranscriptRenderingResults[K] {
  const handler = TASK_HANDLERS[task.kind] as TaskHandlers[K];
  return handler(task, items);
}
