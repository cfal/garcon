export class TranscriptSearchSourceChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranscriptSearchSourceChangedError';
  }
}
