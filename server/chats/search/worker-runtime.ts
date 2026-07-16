export const TRANSCRIPT_SEARCH_WORKER_PATH_ENV =
  'GARCON_INTERNAL_TRANSCRIPT_SEARCH_WORKER_PATH';

export function resolveTranscriptSearchWorkerPath(): string {
  const embeddedPath = process.env[TRANSCRIPT_SEARCH_WORKER_PATH_ENV]?.trim();
  return embeddedPath || new URL('./worker.ts', import.meta.url).href;
}
