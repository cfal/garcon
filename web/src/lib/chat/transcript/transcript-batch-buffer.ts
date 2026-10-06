import type { TranscriptBufferedBatch } from './transcript-reconnect-replay.js';

export const TRANSCRIPT_BUFFER_ROW_LIMIT = 1_000;
export const TRANSCRIPT_BUFFER_BYTE_LIMIT = 8 * 1024 * 1024;

export class TranscriptBatchBuffer {
	readonly batches: TranscriptBufferedBatch[] = [];
	#rows = 0;
	#bytes = 0;
	overflowed = false;
	observedThroughOrdinal = 0;
	transcriptViewId: string | null = null;
	hasMixedViews = false;

	append(batch: TranscriptBufferedBatch): boolean {
		this.hasMixedViews ||= this.transcriptViewId !== null && this.transcriptViewId !== batch.transcriptViewId;
		this.transcriptViewId = batch.transcriptViewId;
		this.observedThroughOrdinal = Math.max(this.observedThroughOrdinal, batch.lastOrdinal);
		if (this.overflowed) return false;
		const rows = Math.max(1, batch.lastOrdinal - batch.firstOrdinal + 1);
		if (this.#rows + rows > TRANSCRIPT_BUFFER_ROW_LIMIT) {
			this.overflowed = true;
			return false;
		}
		let bytes: number;
		try {
			bytes = JSON.stringify(batch).length * 2;
		} catch {
			this.overflowed = true;
			return false;
		}
		if (this.#bytes + bytes > TRANSCRIPT_BUFFER_BYTE_LIMIT) {
			this.overflowed = true;
			return false;
		}
		this.#rows += rows;
		this.#bytes += bytes;
		this.batches.push(batch);
		return true;
	}
}
