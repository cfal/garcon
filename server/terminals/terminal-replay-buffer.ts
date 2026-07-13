import type { TerminalOutputChunk } from '../../common/terminal.js';

export const DEFAULT_TERMINAL_REPLAY_BYTES = 1024 * 1024;

export class TerminalReplayBuffer {
  readonly #limitBytes: number;
  #chunks: TerminalOutputChunk[] = [];
  #bytes = 0;
  #firstRetainedSequence = 1;

  constructor(limitBytes = DEFAULT_TERMINAL_REPLAY_BYTES) {
    if (!Number.isInteger(limitBytes) || limitBytes < 1) {
      throw new RangeError(
        'Terminal replay byte limit must be a positive integer',
      );
    }
    this.#limitBytes = limitBytes;
  }

  get firstRetainedSequence(): number {
    return this.#firstRetainedSequence;
  }

  get byteLength(): number {
    return this.#bytes;
  }

  append(chunk: TerminalOutputChunk): void {
    const bytes = Buffer.byteLength(chunk.data, 'utf8');
    if (bytes > this.#limitBytes) {
      this.#chunks = [];
      this.#bytes = 0;
      this.#firstRetainedSequence = chunk.sequence + 1;
      return;
    }
    this.#chunks.push({ ...chunk });
    this.#bytes += bytes;
    while (this.#bytes > this.#limitBytes) {
      const removed = this.#chunks.shift();
      if (!removed) break;
      this.#bytes -= Buffer.byteLength(removed.data, 'utf8');
      this.#firstRetainedSequence = removed.sequence + 1;
    }
    if (this.#chunks.length > 0)
      this.#firstRetainedSequence = this.#chunks[0].sequence;
  }

  after(sequence: number): TerminalOutputChunk[] {
    return this.#chunks
      .filter((chunk) => chunk.sequence > sequence)
      .map((chunk) => ({ ...chunk }));
  }
}
