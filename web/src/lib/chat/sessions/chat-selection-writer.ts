import { setLastSelectedChat } from '$lib/api/chats.js';
import type { ChatSessionsStoreDeps } from './chat-sessions-contract.js';

interface ChatSelectionWriterOptions {
	deps: Pick<ChatSessionsStoreDeps, 'setLastSelectedChat'>;
	onConfirmed: (chatId: string | null) => void;
}

/** Coalesces selection persistence while retaining the latest requested chat. */
export class ChatSelectionWriter {
	#inFlight = false;
	#pending: string | null | undefined = undefined;
	#acknowledged: string | null = null;
	readonly #options: ChatSelectionWriterOptions;

	constructor(options: ChatSelectionWriterOptions) {
		this.#options = options;
	}

	remember(chatId: string | null): void {
		const normalized = typeof chatId === 'string' ? chatId.trim() : '';
		this.#pending = normalized || null;
		void this.#flush();
	}

	async #flush(): Promise<void> {
		if (this.#inFlight) return;
		const writeSelection = this.#options.deps.setLastSelectedChat ?? setLastSelectedChat;

		while (this.#pending !== undefined) {
			const nextChatId = this.#pending;
			this.#pending = undefined;
			if (nextChatId === this.#acknowledged) continue;

			this.#inFlight = true;
			try {
				const response = await writeSelection(nextChatId);
				this.#acknowledged = response.lastSelectedChatId;
				this.#options.onConfirmed(response.lastSelectedChatId);
			} catch (err) {
				console.warn(
					'[ChatSessionsStore] Failed to remember selected chat:',
					err instanceof Error ? err.message : String(err),
				);
			} finally {
				this.#inFlight = false;
			}
		}
	}
}
