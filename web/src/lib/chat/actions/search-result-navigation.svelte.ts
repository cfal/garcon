// One-shot navigation intent from an epoch-validated search result to a
// transcript seq. The sidebar records it before selecting the chat; the
// conversation consumes it exactly once when that chat's transcript loads.
export class SearchResultNavigationIntent {
	#pending = $state<{ chatId: string; seq: number } | null>(null);

	set(chatId: string, seq: number): void {
		this.#pending = { chatId, seq };
	}

	peek(chatId: string): boolean {
		return this.#pending?.chatId === chatId;
	}

	take(chatId: string): number | null {
		if (this.#pending?.chatId !== chatId) return null;
		const seq = this.#pending.seq;
		this.#pending = null;
		return seq;
	}
}

export const searchResultNavigation = new SearchResultNavigationIntent();
