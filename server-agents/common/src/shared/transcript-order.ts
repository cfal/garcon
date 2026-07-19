export interface TranscriptTimestampSortFields {
  valid: 0 | 1;
  milliseconds: number;
}

export function transcriptTimestampSortFields(value: unknown): TranscriptTimestampSortFields {
  const milliseconds = new Date((value as string | number | Date | undefined) ?? 0).getTime();
  return Number.isFinite(milliseconds) && milliseconds > 0
    ? { valid: 1, milliseconds }
    : { valid: 0, milliseconds: 0 };
}

export function compareTranscriptTimestamps(left: number, right: number): number {
  const leftValid = left > 0;
  const rightValid = right > 0;
  if (leftValid !== rightValid) return leftValid ? -1 : 1;
  return leftValid && left !== right ? left - right : 0;
}
