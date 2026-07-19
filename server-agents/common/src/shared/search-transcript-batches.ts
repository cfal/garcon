export const SEARCH_TRANSCRIPT_MAX_RECORD_BYTES = 8 * 1024 * 1024;
export const SEARCH_TRANSCRIPT_MAX_BATCH_BYTES = 8 * 1024 * 1024;

export function throwIfSearchLoadAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Transcript search load cancelled', 'AbortError');
}

export function searchBatchLimitReached(
  recordCount: number,
  batchBytes: number,
  batchSize: number,
): boolean {
  return recordCount >= Math.max(1, batchSize)
    || batchBytes >= SEARCH_TRANSCRIPT_MAX_BATCH_BYTES;
}

export function searchBatchWouldExceed(
  recordCount: number,
  batchBytes: number,
  nextRecordBytes: number,
  batchSize: number,
): boolean {
  return recordCount > 0 && (
    recordCount >= Math.max(1, batchSize)
    || batchBytes + nextRecordBytes > SEARCH_TRANSCRIPT_MAX_BATCH_BYTES
  );
}

export function boundedSearchPageSize(maxRecordBytes: number, batchSize: number): number {
  if (!Number.isFinite(maxRecordBytes) || maxRecordBytes <= 0) return Math.max(1, batchSize);
  return Math.max(1, Math.min(
    batchSize,
    Math.floor(SEARCH_TRANSCRIPT_MAX_BATCH_BYTES / maxRecordBytes),
  ));
}
