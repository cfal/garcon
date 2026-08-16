import {
	type ChatHistoryResponse,
	type TranscriptMessage,
} from '$shared/chat-view';
import type { ChatMessagesRequest } from '$lib/api/chats.js';
import { INITIAL_VISIBLE_MESSAGES } from './active-transcript-state.svelte.js';
import type { ChatTranscriptCache } from './chat-transcript-cache.svelte';
import {
	collapseBackwardTranscriptDemand,
	loadTranscriptPageDemand,
} from './transcript-page-demand.js';

interface PendingBatch {
	transcriptViewId: string;
	messages: TranscriptMessage[];
	firstOrdinal: number;
	lastOrdinal: number;
}

export interface BackgroundTranscriptLoaderOptions {
	cache: ChatTranscriptCache;
	loadPage?: (request: ChatMessagesRequest) => Promise<ChatHistoryResponse>;
}

export class BackgroundTranscriptLoader {
	#inFlight = new Map<string, Promise<void>>();
	#pending = new Map<string, PendingBatch[]>();
	#cache: ChatTranscriptCache;
	#loadPage: ((request: ChatMessagesRequest) => Promise<ChatHistoryResponse>) | undefined;

	constructor(options: BackgroundTranscriptLoaderOptions) {
		this.#cache = options.cache;
		this.#loadPage = options.loadPage;
	}

	queueLoad(chatId: string, failedBatch?: PendingBatch): void {
		if (!chatId) return;
		if (failedBatch) {
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
			const demand = await loadTranscriptPageDemand({
				direction: 'backward',
				chatId,
				visibleLimit: INITIAL_VISIBLE_MESSAGES,
				loadPage: this.#loadPage,
			});
			if (demand.kind === 'unavailable') {
				this.#cache.remove(chatId);
				this.#pending.delete(chatId);
				return false;
			}
			if (demand.kind !== 'complete') return false;
			const page = collapseBackwardTranscriptDemand(demand);
			this.#cache.replaceFromPage(chatId, page);
			let pending = this.#pending.get(chatId);
			while (pending && pending.length > 0) {
				this.#pending.delete(chatId);
				for (const batch of pending) {
					if (batch.transcriptViewId !== page.transcriptViewId) continue;
					this.#cache.applyMessages(chatId, batch.transcriptViewId, batch);
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
