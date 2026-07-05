import type { ChatViewMessage, ChatViewPage } from '$shared/chat-view';
import { getChatMessages } from '$lib/api/chats.js';
import { INITIAL_VISIBLE_MESSAGES } from './state.svelte';
import type { ChatTranscriptCache } from './chat-transcript-cache.svelte';

interface PendingBatch {
	generationId: string;
	messages: ChatViewMessage[];
	lastSeq?: number;
}

export interface BackgroundTranscriptLoaderOptions {
	cache: ChatTranscriptCache;
	loadPage?: (chatId: string) => Promise<ChatViewPage>;
}

export class BackgroundTranscriptLoader {
	#inFlight = new Map<string, Promise<void>>();
	#pending = new Map<string, PendingBatch[]>();
	#cache: ChatTranscriptCache;
	#loadPage: (chatId: string) => Promise<ChatViewPage>;

	constructor(options: BackgroundTranscriptLoaderOptions) {
		this.#cache = options.cache;
		this.#loadPage =
			options.loadPage ??
			((chatId) => getChatMessages({ chatId, limit: INITIAL_VISIBLE_MESSAGES }));
	}

	queueLoad(chatId: string, failedBatch?: PendingBatch): void {
		if (!chatId) return;
		if (failedBatch && failedBatch.messages.length > 0) {
			const pending = this.#pending.get(chatId) ?? [];
			pending.push(failedBatch);
			this.#pending.set(chatId, pending);
		}
		if (this.#inFlight.has(chatId)) return;
		const load = this.#load(chatId).then((loaded) => {
			this.#inFlight.delete(chatId);
			if (loaded && this.#pending.get(chatId)?.length) {
				this.queueLoad(chatId);
			}
		});
		this.#inFlight.set(chatId, load);
	}

	async waitForIdle(chatId: string): Promise<void> {
		await this.#inFlight.get(chatId);
	}

	async #load(chatId: string): Promise<boolean> {
		this.#cache.markStale(chatId);
		try {
			const page = await this.#loadPage(chatId);
			this.#cache.replaceFromPage(chatId, page);
			let pending = this.#pending.get(chatId);
			while (pending && pending.length > 0) {
				this.#pending.delete(chatId);
				for (const batch of pending) {
					if (batch.generationId !== page.generationId) continue;
					this.#cache.applyMessages(chatId, batch.generationId, batch.messages, batch.lastSeq);
				}
				pending = this.#pending.get(chatId);
			}
			this.#pending.delete(chatId);
			return true;
		} catch {
			this.#cache.markStale(chatId);
			return false;
		}
	}
}
