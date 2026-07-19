const SOURCE_TIMESTAMP_EPOCH_MS = Date.UTC(2000, 0, 1);

export function deterministicTranscriptTimestamp(
  lineNumber?: number,
  byteOffset?: number,
): string {
  const sourcePosition = lineNumber ?? byteOffset ?? 0;
  return new Date(SOURCE_TIMESTAMP_EPOCH_MS + sourcePosition).toISOString();
}
