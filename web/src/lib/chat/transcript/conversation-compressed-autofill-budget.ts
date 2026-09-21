const MAX_AUTOMATIC_COMPRESSED_PAGE_REQUESTS = 10;

export class ConversationCompressedAutoFillBudget {
	#chatId: string | null = null;
	#transcriptViewId: string | null = null;
	#requestedPages = 0;

	constructor(private readonly maxPages = MAX_AUTOMATIC_COMPRESSED_PAGE_REQUESTS) {}

	startView(chatId: string, transcriptViewId: string): void {
		if (this.#chatId !== chatId || this.#transcriptViewId !== transcriptViewId) {
			this.#chatId = chatId;
			this.#transcriptViewId = transcriptViewId;
			this.#requestedPages = 0;
		}
	}

	admitRequest(compressed: boolean): boolean {
		if (!compressed) return true;
		if (this.#requestedPages >= this.maxPages) return false;
		this.#requestedPages += 1;
		return true;
	}
}
