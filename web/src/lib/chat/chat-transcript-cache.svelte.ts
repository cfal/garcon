import { SvelteMap } from 'svelte/reactivity';
import {
	applyChatViewMessages,
	type ChatViewMessage,
	type ChatViewPage,
} from '$shared/chat-view';
import {
	LocalChatTranscriptStorage,
	type CachedChatCursor,
} from './chat-transcript-storage';

export const CHAT_TRANSCRIPT_CACHE_LIMIT = 25;

export type ChatTranscriptApplyResult =
	| { status: 'applied'; changed: boolean; lastSeq: number }
	| { status: 'missing-base' }
	| { status: 'generation-changed' }
	| { status: 'gap-detected'; expectedSeq: number; receivedSeq: number }
	| { status: 'server-ahead'; lastSeq: number; serverLastSeq: number };

export interface ChatTranscriptCursor {
	chatId: string;
	generationId: string;
	lastSeq: number;
}

export interface ChatTranscriptSnapshot {
	chatId: string;
	generationId: string;
	messages: ChatViewMessage[];
	lastSeq: number;
	oldestSeq: number;
	stale: boolean;
}

interface ChatTranscriptEntry extends ChatTranscriptSnapshot {
	lastAccessedAt: string;
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
	generationId: string;
	lastSeq: number;
	messages: ChatViewMessage[];
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
		generationId: entry.generationId,
		messages: entry.messages,
		lastSeq: entry.lastSeq,
		oldestSeq: entry.oldestSeq,
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
		this.#setTimeout = options.setTimeoutFn ??
			((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
		this.#clearTimeout = options.clearTimeoutFn ??
			((timer) => globalThis.clearTimeout(timer));
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
				this.#storage.persist(draft.chatId, draft.messages, {
					generationId: draft.generationId,
					lastSeq: draft.lastSeq,
				}, { limit: this.#limit });
				this.#storage.markValidated(draft.chatId);
			},
		});
	}

	get(chatId: string): ChatTranscriptSnapshot | null {
		const entry = this.#entries.get(chatId);
		if (entry) {
			this.#touch(chatId);
			return snapshotFromEntry(entry);
		}
		return this.hydrate(chatId);
	}

	hydrate(chatId: string): ChatTranscriptSnapshot | null {
		if (!chatId) return null;
		const restored = this.#storage.restore(chatId, { limit: this.#limit });
		if (!restored) return null;
		const entry: ChatTranscriptEntry = {
			chatId,
			generationId: restored.generationId,
			messages: restored.entries,
			lastSeq: restored.lastSeq,
			oldestSeq: restored.entries[0]?.seq ?? 0,
			stale: restored.stale,
			lastAccessedAt: nowIso(),
			lastValidatedAt: null,
		};
		this.#entries.set(chatId, entry);
		this.#prune();
		return snapshotFromEntry(entry);
	}

	replaceFromPage(
		chatId: string,
		page: ChatViewPage,
		options: { stale?: boolean } = {},
	): ChatTranscriptSnapshot {
		const windowed = page.messages.slice(-this.#limit);
		const now = nowIso();
		const entry: ChatTranscriptEntry = {
			chatId,
			generationId: page.generationId,
			messages: windowed,
			lastSeq: page.lastSeq,
			oldestSeq: windowed[0]?.seq ?? 0,
			stale: options.stale ?? false,
			lastAccessedAt: now,
			lastValidatedAt: now,
		};
		this.#entries.set(chatId, entry);
		this.#persistence.schedule(entry);
		this.#prune();
		return snapshotFromEntry(entry);
	}

	replace(
		chatId: string,
		generationId: string,
		messages: ChatViewMessage[],
		lastSeq: number,
	): ChatTranscriptSnapshot {
		return this.replaceFromPage(chatId, {
			generationId,
			messages,
			lastSeq,
			pageOldestSeq: messages[0]?.seq ?? 0,
			hasMore: false,
		});
	}

	applyMessages(
		chatId: string,
		generationId: string,
		messages: ChatViewMessage[],
		serverLastSeq?: number,
	): ChatTranscriptApplyResult {
		if (!chatId || !generationId) return { status: 'missing-base' };
		let entry = this.#entries.get(chatId);
		if (!entry) {
			this.hydrate(chatId);
			entry = this.#entries.get(chatId);
		}
		if (!entry) return this.#createFromInitialBatch(chatId, generationId, messages, serverLastSeq);
		if (entry.generationId !== generationId) {
			this.markStale(chatId);
			return { status: 'generation-changed' };
		}

		const applied = applyChatViewMessages(entry.messages, messages, entry.lastSeq);
		if (applied.status === 'gap-detected') {
			this.markStale(chatId);
			return {
				status: 'gap-detected',
				expectedSeq: applied.expectedSeq ?? entry.lastSeq + 1,
				receivedSeq: applied.receivedSeq ?? messages[0]?.seq ?? 0,
			};
		}
		if (typeof serverLastSeq === 'number' && serverLastSeq > applied.lastSeq) {
			this.markStale(chatId);
			return { status: 'server-ahead', lastSeq: applied.lastSeq, serverLastSeq };
		}
		if (!applied.changed) {
			this.#touch(chatId);
			return { status: 'applied', changed: false, lastSeq: entry.lastSeq };
		}

		const windowed = applied.messages.slice(-this.#limit);
		const next: ChatTranscriptEntry = {
			...entry,
			messages: windowed,
			lastSeq: applied.lastSeq,
			oldestSeq: windowed[0]?.seq ?? 0,
			stale: false,
			lastAccessedAt: nowIso(),
		};
		this.#entries.set(chatId, next);
		this.#persistence.schedule(next);
		return { status: 'applied', changed: true, lastSeq: next.lastSeq };
	}

	markStale(chatId: string): void {
		if (!chatId) return;
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
			.filter((entry) => entry.generationId && entry.lastSeq > 0 && !entry.stale)
			.sort((left, right) => right.lastAccessedAt.localeCompare(left.lastAccessedAt))
			.map((entry): ChatTranscriptCursor => ({
				chatId: entry.chatId,
				generationId: entry.generationId,
				lastSeq: entry.lastSeq,
			}));
		if (memory.length >= boundedLimit) return memory.slice(0, boundedLimit);

		const seen = new Set(memory.map((cursor) => cursor.chatId));
		const persisted = this.#storage.listCursors(boundedLimit)
			.filter((cursor: CachedChatCursor) => !seen.has(cursor.chatId));
		return [...memory, ...persisted].slice(0, boundedLimit);
	}

	remove(chatId: string): void {
		if (!chatId) return;
		this.#entries.delete(chatId);
		this.#storage.remove(chatId);
		this.#persistence.remove(chatId);
	}

	flush(): void {
		this.#persistence.flush();
	}

	#createFromInitialBatch(
		chatId: string,
		generationId: string,
		messages: ChatViewMessage[],
		serverLastSeq?: number,
	): ChatTranscriptApplyResult {
		if (messages[0]?.seq !== 1) {
			this.markStale(chatId);
			return { status: 'missing-base' };
		}
		const applied = applyChatViewMessages([], messages, 0);
		if (applied.status === 'gap-detected') {
			this.markStale(chatId);
			return {
				status: 'gap-detected',
				expectedSeq: applied.expectedSeq ?? 1,
				receivedSeq: applied.receivedSeq ?? messages[0]?.seq ?? 0,
			};
		}
		if (typeof serverLastSeq === 'number' && serverLastSeq > applied.lastSeq) {
			this.markStale(chatId);
			return { status: 'server-ahead', lastSeq: applied.lastSeq, serverLastSeq };
		}
		const windowed = applied.messages.slice(-this.#limit);
		const now = nowIso();
		const entry: ChatTranscriptEntry = {
			chatId,
			generationId,
			messages: windowed,
			lastSeq: applied.lastSeq,
			oldestSeq: windowed[0]?.seq ?? 0,
			stale: false,
			lastAccessedAt: now,
			lastValidatedAt: now,
		};
		this.#entries.set(chatId, entry);
		this.#persistence.schedule(entry);
		this.#prune();
		return { status: 'applied', changed: true, lastSeq: entry.lastSeq };
	}

	#touch(chatId: string): void {
		const current = this.#entries.get(chatId);
		if (!current) return;
		this.#entries.set(chatId, { ...current, lastAccessedAt: nowIso() });
	}

	#prune(): void {
		if (this.#entries.size <= this.#maxEntries) return;
		const sorted = [...this.#entries.values()].sort(
			(left, right) => left.lastAccessedAt.localeCompare(right.lastAccessedAt),
		);
		for (const entry of sorted.slice(0, this.#entries.size - this.#maxEntries)) {
			this.#entries.delete(entry.chatId);
		}
	}
}
