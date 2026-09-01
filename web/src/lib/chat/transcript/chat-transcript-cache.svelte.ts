import { SvelteMap } from 'svelte/reactivity';
import {
	applyTranscriptAppend,
	type TranscriptAppend,
	type TranscriptMessage,
	type TranscriptPage,
} from '$shared/chat-view';
import {
	LocalChatTranscriptStorage,
	type CachedChatCursor,
} from '$lib/chat/transcript/chat-transcript-storage.js';
import {
	mergeTranscriptEntriesByOrdinal,
	retainedEarlierPageCursor,
} from './transcript-page-progress.js';

export const CHAT_TRANSCRIPT_CACHE_LIMIT = 25;

export type ChatTranscriptApplyResult =
	| { status: 'applied'; changed: boolean; lastOrdinal: number }
	| { status: 'missing-base' }
	| { status: 'view-changed' }
	| { status: 'gap-detected'; expectedOrdinal: number; receivedOrdinal: number };

export interface ChatTranscriptCursor {
	chatId: string;
	transcriptViewId: string;
	lastOrdinal: number;
}

export interface ChatTranscriptAppliedCursor {
	transcriptViewId: string;
	lastOrdinal: number;
	stale: boolean;
}

export interface ChatTranscriptSnapshot {
	chatId: string;
	transcriptViewId: string;
	messages: TranscriptMessage[];
	lastOrdinal: number;
	oldestOrdinal: number;
	nextBeforeOrdinal: number | null;
	stale: boolean;
}

interface ChatTranscriptEntry extends ChatTranscriptSnapshot {
	lastValidatedAt: string | null;
}

export interface ChatTranscriptCacheOptions {
	limit: number;
	maxEntries?: number;
	storage?: LocalChatTranscriptStorage;
	persistenceDelayMs?: number;
	setTimeoutFn?: SetTimeoutFn;
	clearTimeoutFn?: ClearTimeoutFn;
}

interface ChatTranscriptPersistDraft {
	chatId: string;
	transcriptViewId: string;
	lastOrdinal: number;
	nextBeforeOrdinal: number | null;
	messages: TranscriptMessage[];
}

type TimeoutHandle = ReturnType<typeof setTimeout>;
type SetTimeoutFn = (callback: () => void, delayMs: number) => TimeoutHandle;
type ClearTimeoutFn = (timer: TimeoutHandle) => void;

function nowIso(): string {
	return new Date().toISOString();
}

function snapshotFromEntry(entry: ChatTranscriptEntry): ChatTranscriptSnapshot {
	return {
		chatId: entry.chatId,
		transcriptViewId: entry.transcriptViewId,
		messages: entry.messages,
		lastOrdinal: entry.lastOrdinal,
		oldestOrdinal: entry.oldestOrdinal,
		nextBeforeOrdinal: entry.nextBeforeOrdinal,
		stale: entry.stale,
	};
}

class ChatTranscriptPersistenceQueue {
	#pending = new Map<string, ChatTranscriptPersistDraft>();
	#timer: TimeoutHandle | null = null;
	#delayMs: number;
	#persist: (draft: ChatTranscriptPersistDraft) => void;
	#setTimeout: SetTimeoutFn;
	#clearTimeout: ClearTimeoutFn;

	constructor(options: {
		delayMs: number;
		persist: (draft: ChatTranscriptPersistDraft) => void;
		setTimeoutFn?: SetTimeoutFn;
		clearTimeoutFn?: ClearTimeoutFn;
	}) {
		this.#delayMs = options.delayMs;
		this.#persist = options.persist;
		this.#setTimeout =
			options.setTimeoutFn ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
		this.#clearTimeout = options.clearTimeoutFn ?? ((timer) => globalThis.clearTimeout(timer));
	}

	schedule(draft: ChatTranscriptPersistDraft): void {
		this.#pending.set(draft.chatId, draft);
		if (this.#timer) return;
		this.#timer = this.#setTimeout(() => this.flush(), this.#delayMs);
	}

	remove(chatId: string): void {
		this.#pending.delete(chatId);
	}

	flush(): void {
		const drafts = [...this.#pending.values()];
		this.#pending.clear();
		if (this.#timer) {
			this.#clearTimeout(this.#timer);
			this.#timer = null;
		}
		for (const draft of drafts) this.#persist(draft);
	}
}

export class ChatTranscriptCache {
	#entries = new SvelteMap<string, ChatTranscriptEntry>();
	#lastAccessedAt = new Map<string, string>();
	#storage: LocalChatTranscriptStorage;
	#limit: number;
	#maxEntries: number;
	#persistence: ChatTranscriptPersistenceQueue;

	constructor(options: ChatTranscriptCacheOptions) {
		this.#limit = options.limit;
		this.#maxEntries = options.maxEntries ?? CHAT_TRANSCRIPT_CACHE_LIMIT;
		this.#storage = options.storage ?? new LocalChatTranscriptStorage();
		this.#persistence = new ChatTranscriptPersistenceQueue({
			delayMs: options.persistenceDelayMs ?? 800,
			setTimeoutFn: options.setTimeoutFn,
			clearTimeoutFn: options.clearTimeoutFn,
			persist: (draft) => {
				this.#storage.persist(
					draft.chatId,
					draft.messages,
					{
						transcriptViewId: draft.transcriptViewId,
						lastOrdinal: draft.lastOrdinal,
						nextBeforeOrdinal: draft.nextBeforeOrdinal,
					},
					{ limit: this.#limit },
				);
				this.#storage.markValidated(draft.chatId);
			},
		});
	}

	get(chatId: string): ChatTranscriptSnapshot | null {
		const entry = this.#entries.get(chatId);
		return entry ? snapshotFromEntry(entry) : null;
	}

	markAccessed(chatId: string): void {
		if (this.#entries.has(chatId)) this.#lastAccessedAt.set(chatId, nowIso());
	}

	readAppliedCursor(chatId: string): ChatTranscriptAppliedCursor | null {
		const entry = this.#entries.get(chatId);
		return entry
			? {
					transcriptViewId: entry.transcriptViewId,
					lastOrdinal: entry.lastOrdinal,
					stale: entry.stale,
				}
			: null;
	}

	hydrate(chatId: string): ChatTranscriptSnapshot | null {
		if (!chatId) return null;
		const restored = this.#storage.restore(chatId, { limit: this.#limit });
		if (!restored) return null;
		const entry: ChatTranscriptEntry = {
			chatId,
			transcriptViewId: restored.transcriptViewId,
			messages: restored.entries,
			lastOrdinal: restored.lastOrdinal,
			oldestOrdinal: restored.entries[0]?.ordinal ?? 0,
			nextBeforeOrdinal: restored.nextBeforeOrdinal,
			stale: restored.stale,
			lastValidatedAt: null,
		};
		this.#entries.set(chatId, entry);
		this.#lastAccessedAt.set(chatId, nowIso());
		this.#prune();
		return snapshotFromEntry(entry);
	}

	replaceFromPage(
		chatId: string,
		page: TranscriptPage,
		options: { stale?: boolean } = {},
	): ChatTranscriptSnapshot {
		const windowed = page.messages.slice(-this.#limit);
		const nextBeforeOrdinal = retainedEarlierPageCursor(
			page.messages,
			windowed,
			page.nextBeforeOrdinal,
		);
		const now = nowIso();
		const entry: ChatTranscriptEntry = {
			chatId,
			transcriptViewId: page.transcriptViewId,
			messages: windowed,
			lastOrdinal: page.pageNewestOrdinal,
			oldestOrdinal: windowed[0]?.ordinal ?? 0,
			nextBeforeOrdinal,
			stale: options.stale ?? false,
			lastValidatedAt: now,
		};
		this.#entries.set(chatId, entry);
		this.#lastAccessedAt.set(chatId, now);
		this.#persistence.schedule(entry);
		this.#prune();
		return snapshotFromEntry(entry);
	}

	replace(
		chatId: string,
		transcriptViewId: string,
		messages: TranscriptMessage[],
		lastOrdinal: number,
		nextBeforeOrdinal: number | null,
	): ChatTranscriptSnapshot {
		return this.replaceFromPage(chatId, {
			transcriptViewId,
			messages,
			lastOrdinal,
			pageOldestOrdinal: messages[0]?.ordinal ?? 0,
			pageNewestOrdinal: lastOrdinal,
			nextBeforeOrdinal,
			hasMore: nextBeforeOrdinal !== null,
		});
	}

	applyEarlierPage(
		chatId: string,
		transcriptViewId: string,
		requestBeforeOrdinal: number,
		page: TranscriptPage,
	): void {
		let entry = this.#entries.get(chatId);
		if (!entry) {
			this.hydrate(chatId);
			entry = this.#entries.get(chatId);
		}
		if (
			!entry
			|| entry.stale
			|| entry.transcriptViewId !== transcriptViewId
			|| entry.nextBeforeOrdinal !== requestBeforeOrdinal
		) return;

		const merged = mergeTranscriptEntriesByOrdinal(page.messages, entry.messages);
		const windowed = merged.slice(-this.#limit);
		const next: ChatTranscriptEntry = {
			...entry,
			messages: windowed,
			lastOrdinal: entry.lastOrdinal,
			oldestOrdinal: windowed[0]?.ordinal ?? 0,
			nextBeforeOrdinal: retainedEarlierPageCursor(
				merged,
				windowed,
				page.nextBeforeOrdinal,
			),
		};
		this.#entries.set(chatId, next);
		this.#lastAccessedAt.set(chatId, nowIso());
		this.#persistence.schedule(next);
	}

	applyMessages(
		chatId: string,
		transcriptViewId: string,
		append: Pick<TranscriptAppend, 'firstOrdinal' | 'lastOrdinal' | 'messages'>,
	): ChatTranscriptApplyResult {
		if (!chatId || !transcriptViewId) return { status: 'missing-base' };
		let entry = this.#entries.get(chatId);
		if (!entry) {
			this.hydrate(chatId);
			entry = this.#entries.get(chatId);
		}
		if (!entry) return this.#createFromInitialBatch(chatId, transcriptViewId, append);
		if (entry.transcriptViewId !== transcriptViewId) {
			this.markStale(chatId);
			return { status: 'view-changed' };
		}

		const applied = applyTranscriptAppend(entry.messages, append, entry.lastOrdinal);
		if (applied.status === 'gap-detected') {
			this.markStale(chatId);
			return {
				status: 'gap-detected',
				expectedOrdinal: applied.expectedOrdinal ?? entry.lastOrdinal + 1,
				receivedOrdinal: applied.receivedOrdinal ?? append.firstOrdinal,
			};
		}
		const windowed = applied.messages.slice(-this.#limit);
		const next: ChatTranscriptEntry = {
			...entry,
			messages: windowed,
			lastOrdinal: applied.lastOrdinal,
			oldestOrdinal: windowed[0]?.ordinal ?? 0,
			nextBeforeOrdinal: retainedEarlierPageCursor(
				applied.messages,
				windowed,
				entry.nextBeforeOrdinal,
			),
			stale: false,
		};
		this.#entries.set(chatId, next);
		this.#lastAccessedAt.set(chatId, nowIso());
		this.#persistence.schedule(next);
		return { status: 'applied', changed: applied.changed, lastOrdinal: next.lastOrdinal };
	}

	markStale(chatId: string): void {
		if (!chatId) return;
		this.#persistence.remove(chatId);
		const current = this.#entries.get(chatId);
		if (current) this.#entries.set(chatId, { ...current, stale: true });
		this.#storage.markStale(chatId);
	}

	markValidated(chatId: string): void {
		if (!chatId) return;
		const current = this.#entries.get(chatId);
		const now = nowIso();
		if (current) this.#entries.set(chatId, { ...current, stale: false, lastValidatedAt: now });
		this.#storage.markValidated(chatId);
	}

	listCursors(limit = 20): ChatTranscriptCursor[] {
		const boundedLimit = Math.max(0, Math.floor(limit));
		if (boundedLimit === 0) return [];

		const memory = [...this.#entries.values()]
			.filter((entry) => entry.transcriptViewId && entry.lastOrdinal > 0 && !entry.stale)
			.sort((left, right) =>
				(this.#lastAccessedAt.get(right.chatId) ?? '').localeCompare(
					this.#lastAccessedAt.get(left.chatId) ?? '',
				),
			)
			.map(
				(entry): ChatTranscriptCursor => ({
					chatId: entry.chatId,
					transcriptViewId: entry.transcriptViewId,
					lastOrdinal: entry.lastOrdinal,
				}),
			);
		if (memory.length >= boundedLimit) return memory.slice(0, boundedLimit);

		const seen = new Set(this.#entries.keys());
		const persisted = this.#storage
			.listCursors(boundedLimit)
			.filter((cursor: CachedChatCursor) => !seen.has(cursor.chatId));
		return [...memory, ...persisted].slice(0, boundedLimit);
	}

	remove(chatId: string): void {
		if (!chatId) return;
		this.#entries.delete(chatId);
		this.#lastAccessedAt.delete(chatId);
		this.#storage.remove(chatId);
		this.#persistence.remove(chatId);
	}

	flush(): void {
		this.#persistence.flush();
	}

	#createFromInitialBatch(
		chatId: string,
		transcriptViewId: string,
		append: Pick<TranscriptAppend, 'firstOrdinal' | 'lastOrdinal' | 'messages'>,
	): ChatTranscriptApplyResult {
		if (append.firstOrdinal !== 1) {
			this.markStale(chatId);
			return { status: 'missing-base' };
		}
		const applied = applyTranscriptAppend([], append, 0);
		if (applied.status === 'gap-detected') {
			this.markStale(chatId);
			return {
				status: 'gap-detected',
				expectedOrdinal: applied.expectedOrdinal ?? 1,
				receivedOrdinal: applied.receivedOrdinal ?? append.firstOrdinal,
			};
		}
		const windowed = applied.messages.slice(-this.#limit);
		const now = nowIso();
		const entry: ChatTranscriptEntry = {
			chatId,
			transcriptViewId,
			messages: windowed,
			lastOrdinal: applied.lastOrdinal,
			oldestOrdinal: windowed[0]?.ordinal ?? 0,
			nextBeforeOrdinal: retainedEarlierPageCursor(applied.messages, windowed, null),
			stale: false,
			lastValidatedAt: now,
		};
		this.#entries.set(chatId, entry);
		this.#lastAccessedAt.set(chatId, now);
		this.#persistence.schedule(entry);
		this.#prune();
		return { status: 'applied', changed: true, lastOrdinal: entry.lastOrdinal };
	}

	#prune(): void {
		if (this.#entries.size <= this.#maxEntries) return;
		const sorted = [...this.#entries.values()].sort((left, right) =>
			(this.#lastAccessedAt.get(left.chatId) ?? '').localeCompare(
				this.#lastAccessedAt.get(right.chatId) ?? '',
			),
		);
		for (const entry of sorted.slice(0, this.#entries.size - this.#maxEntries)) {
			this.#entries.delete(entry.chatId);
			this.#lastAccessedAt.delete(entry.chatId);
		}
	}
}
