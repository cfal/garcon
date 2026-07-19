export interface SearchTranscriptLoadOptions {
  readonly signal: AbortSignal;
  readonly batchSize: number;
  readonly scratchDirectory: string;
}
