import { SvelteMap } from 'svelte/reactivity';
import { applyChatViewMessages, type ChatViewMessage } from '$shared/chat-view';
import { getChatMessages } from '$lib/api/chats.js';
import { LocalChatSnapshotCache } from './chat-snapshot-cache';

const PREVIEW_LIMIT = 50;

export interface SplitPanePreviewEntry {
	chatId: string;
	generationId: string | null;
	lastSeq: number;
	messages: ChatViewMessage[];
	isLoading: boolean;
	isStale: boolean;
	error: string | null;
}

export interface SplitPanePreviewCursor {
	chatId: string;
	generationId: string;
	lastSeq: number;
}

function emptyEntry(chatId: string): SplitPanePreviewEntry {
	return {
		chatId,
		generationId: null,
		lastSeq: 0,
		messages: [],
		isLoading: false,
		isStale: false,
		error: null,
	};
}

export class SplitPanePreviewStore {
	#entries = new SvelteMap<string, SplitPanePreviewEntry>();
	#snapshotCache = new LocalChatSnapshotCache();
	#loadEpochs = new Map<string, number>();

	entry(chatId: string): SplitPanePreviewEntry {
		return this.#entries.get(chatId) ?? emptyEntry(chatId);
	}

	cursor(chatId: string): SplitPanePreviewCursor | null {
		const entry = this.#entries.get(chatId);
		if (!entry?.generationId || entry.lastSeq <= 0) return null;
		return { chatId, generationId: entry.generationId, lastSeq: entry.lastSeq };
	}

	restore(chatId: string): void {
		if (!chatId) return;
		const restored = this.#snapshotCache.restore(chatId, { limit: PREVIEW_LIMIT });
		if (!restored) return;
		this.#entries.set(chatId, {
			chatId,
			generationId: restored.generationId,
			lastSeq: restored.lastSeq,
			messages: restored.entries,
			isLoading: false,
			isStale: restored.stale,
			error: null,
		});
	}

	async ensureLoaded(chatId: string): Promise<void> {
		if (!chatId) return;
		const current = this.entry(chatId);
		if (current.messages.length > 0 && !current.isStale) return;
		await this.loadSnapshot(chatId);
	}

	async loadSnapshot(chatId: string): Promise<void> {
		if (!chatId) return;
		const epoch = (this.#loadEpochs.get(chatId) ?? 0) + 1;
		this.#loadEpochs.set(chatId, epoch);
		this.#entries.set(chatId, { ...this.entry(chatId), isLoading: true, error: null });
		try {
			const page = await getChatMessages({ chatId, limit: PREVIEW_LIMIT });
			if (this.#loadEpochs.get(chatId) !== epoch) return;
			this.replaceSnapshot(chatId, page.generationId, page.messages, page.lastSeq);
		} catch (error) {
			if (this.#loadEpochs.get(chatId) !== epoch) return;
			this.#entries.set(chatId, {
				...this.entry(chatId),
				isLoading: false,
				error: error instanceof Error ? error.message : 'Failed to load chat preview',
			});
		}
	}

	replaceSnapshot(
		chatId: string,
		generationId: string,
		messages: ChatViewMessage[],
		lastSeq: number,
	): void {
		const windowed = messages.slice(-PREVIEW_LIMIT);
		this.#entries.set(chatId, {
			chatId,
			generationId,
			lastSeq,
			messages: windowed,
			isLoading: false,
			isStale: false,
			error: null,
		});
		this.#snapshotCache.persist(chatId, windowed, { generationId, lastSeq }, { limit: PREVIEW_LIMIT });
		this.#snapshotCache.markValidated(chatId);
	}

	applyMessages(
		chatId: string,
		generationId: string,
		messages: ChatViewMessage[],
		serverLastSeq?: number,
	): boolean {
		let current = this.#entries.get(chatId);
		if (!current) {
			this.restore(chatId);
			current = this.#entries.get(chatId);
		}
		if (!current?.generationId) return false;
		if (current.generationId !== generationId) {
			this.markStale(chatId);
			return false;
		}
		const applied = applyChatViewMessages(current.messages, messages, current.lastSeq);
		if (applied.status !== 'applied') {
			this.markStale(chatId);
			return false;
		}
		if (serverLastSeq !== undefined && serverLastSeq > applied.lastSeq) {
			this.markStale(chatId);
			return false;
		}
		if (!applied.changed) return true;

		const windowed = applied.messages.slice(-PREVIEW_LIMIT);
		this.#entries.set(chatId, {
			...current,
			messages: windowed,
			lastSeq: applied.lastSeq,
			isStale: false,
			error: null,
		});
		this.#snapshotCache.persist(chatId, windowed, {
			generationId,
			lastSeq: applied.lastSeq,
		}, { limit: PREVIEW_LIMIT });
		this.#snapshotCache.markValidated(chatId);
		return true;
	}

	markStale(chatId: string): void {
		if (!chatId) return;
		this.#snapshotCache.markStale(chatId);
		this.#entries.set(chatId, { ...this.entry(chatId), isStale: true });
	}

	remove(chatId: string): void {
		if (!chatId) return;
		this.#entries.delete(chatId);
		this.#snapshotCache.remove(chatId);
		this.#loadEpochs.delete(chatId);
	}
}
