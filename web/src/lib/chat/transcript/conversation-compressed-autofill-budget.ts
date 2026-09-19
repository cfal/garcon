const MAX_AUTOMATIC_PAGES_PER_CHAT = 2;

export class ConversationCompressedAutoFillBudget {
	#chatId: string | null = null;
	#loadedPages = 0;

	constructor(private readonly maxPages = MAX_AUTOMATIC_PAGES_PER_CHAT) {}

	startChat(chatId: string): void {
		if (this.#chatId !== chatId) {
			this.#chatId = chatId;
			this.#loadedPages = 0;
		}
	}

	canLoad(compressed: boolean): boolean {
		return !compressed || this.#loadedPages < this.maxPages;
	}

	recordLoaded(compressed: boolean): void {
		if (compressed) this.#loadedPages += 1;
	}
}
