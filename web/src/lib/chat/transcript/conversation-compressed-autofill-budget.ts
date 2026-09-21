const MAX_AUTOMATIC_COMPRESSED_PAGE_DEMANDS = 10;

export class ConversationCompressedAutoFillBudget {
	#chatId: string | null = null;
	#transcriptViewId: string | null = null;
	#admittedDemands = 0;

	constructor(private readonly maxDemands = MAX_AUTOMATIC_COMPRESSED_PAGE_DEMANDS) {}

	startView(chatId: string, transcriptViewId: string): void {
		if (this.#chatId !== chatId || this.#transcriptViewId !== transcriptViewId) {
			this.#chatId = chatId;
			this.#transcriptViewId = transcriptViewId;
			this.#admittedDemands = 0;
		}
	}

	admitDemand(compressed: boolean): boolean {
		if (!compressed) return true;
		if (this.#admittedDemands >= this.maxDemands) return false;
		this.#admittedDemands += 1;
		return true;
	}
}
