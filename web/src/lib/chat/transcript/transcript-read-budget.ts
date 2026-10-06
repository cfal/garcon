export const TRANSCRIPT_READ_REQUEST_LIMIT = 10;
export const TRANSCRIPT_READ_RAW_ROW_LIMIT = 2_000;

export class TranscriptReadBudget {
	#requests = 0;
	#reservedRawRows = 0;

	get exhausted(): boolean {
		return this.#requests >= TRANSCRIPT_READ_REQUEST_LIMIT
			|| this.#reservedRawRows >= TRANSCRIPT_READ_RAW_ROW_LIMIT;
	}

	admit(requestedRows: number): number {
		if (this.exhausted) return 0;
		const limit = Math.min(requestedRows, TRANSCRIPT_READ_RAW_ROW_LIMIT - this.#reservedRawRows);
		this.#requests += 1;
		// Failed and cancelled reads still consume their reserved work allowance.
		this.#reservedRawRows += limit;
		return limit;
	}
}
