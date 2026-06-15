import {
	applyChatViewMessages,
	parseChatViewMessages,
	type ChatViewMessage,
} from '$shared/chat-view';

const SNAPSHOT_PREFIX = 'chat_snapshot_';
const INDEX_KEY = 'chat_snapshot_index_v3';
const SCHEMA_VERSION = 3;
const MAX_ENTRIES = 25;

interface ChatSnapshotEnvelope {
	version: 3;
	chatId: string;
	savedAt: string;
	generationId: string;
	lastSeq: number;
	entries: ChatViewMessage[];
}

interface ChatSnapshotIndexEntry {
	chatId: string;
	lastAccessedAt: string;
	lastValidatedAt: string | null;
	schemaVersion: 3;
	stale: boolean;
}

interface ChatSnapshotIndex {
	version: 3;
	entries: ChatSnapshotIndexEntry[];
}

export interface RestoredChatSnapshot {
	entries: ChatViewMessage[];
	generationId: string;
	lastSeq: number;
	stale: boolean;
}

export interface CachedChatCursor {
	chatId: string;
	generationId: string;
	lastSeq: number;
}

export interface ChatSnapshotWindowOptions {
	limit?: number;
}

function snapshotKey(chatId: string): string {
	return `${SNAPSHOT_PREFIX}${chatId}`;
}

function nowIso(): string {
	return new Date().toISOString();
}

function emptyIndex(): ChatSnapshotIndex {
	return { version: SCHEMA_VERSION, entries: [] };
}

function readIndex(): ChatSnapshotIndex {
	try {
		const raw = localStorage.getItem(INDEX_KEY);
		if (!raw) return emptyIndex();
		const parsed = JSON.parse(raw) as ChatSnapshotIndex;
		if (parsed.version !== SCHEMA_VERSION || !Array.isArray(parsed.entries)) {
			localStorage.removeItem(INDEX_KEY);
			return emptyIndex();
		}
		return parsed;
	} catch {
		localStorage.removeItem(INDEX_KEY);
		return emptyIndex();
	}
}

function writeIndex(index: ChatSnapshotIndex): void {
	localStorage.setItem(INDEX_KEY, JSON.stringify(index));
}

function windowEntries(entries: ChatViewMessage[], options: ChatSnapshotWindowOptions = {}): ChatViewMessage[] {
	const limit = Number.isFinite(options.limit) ? Math.floor(options.limit ?? 0) : 0;
	if (limit <= 0 || entries.length <= limit) return entries;
	return entries.slice(-limit);
}

function upsertEntry(
	index: ChatSnapshotIndex,
	chatId: string,
	patch: Partial<ChatSnapshotIndexEntry>,
): ChatSnapshotIndex {
	const existing = index.entries.find((entry) => entry.chatId === chatId);
	const base: ChatSnapshotIndexEntry = existing ?? {
		chatId,
		lastAccessedAt: nowIso(),
		lastValidatedAt: null,
		schemaVersion: SCHEMA_VERSION,
		stale: false,
	};

	const nextEntry = { ...base, ...patch };
	const nextEntries = index.entries.filter((entry) => entry.chatId !== chatId);
	nextEntries.push(nextEntry);
	return { ...index, entries: nextEntries };
}

function removeEntry(index: ChatSnapshotIndex, chatId: string): ChatSnapshotIndex {
	return {
		...index,
		entries: index.entries.filter((entry) => entry.chatId !== chatId),
	};
}

function pruneIndex(index: ChatSnapshotIndex): ChatSnapshotIndex {
	const sorted = [...index.entries].sort(
		(a, b) => new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime(),
	);
	const keep = sorted.slice(0, MAX_ENTRIES);
	const evicted = sorted.slice(MAX_ENTRIES);
	for (const entry of evicted) {
		try {
			localStorage.removeItem(snapshotKey(entry.chatId));
		} catch {
			// Ignores storage removal failures.
		}
	}
	return { ...index, entries: keep };
}

function hasSnapshot(chatId: string): boolean {
	return Boolean(localStorage.getItem(snapshotKey(chatId)));
}

export class LocalChatSnapshotCache {
	restore(chatId: string, options: ChatSnapshotWindowOptions = {}): RestoredChatSnapshot | null {
		if (!chatId) return null;
		try {
			const raw = localStorage.getItem(snapshotKey(chatId));
			if (!raw) {
				this.remove(chatId);
				return null;
			}
			const parsed = JSON.parse(raw) as ChatSnapshotEnvelope;
			if (parsed.version !== SCHEMA_VERSION || parsed.chatId !== chatId) {
				this.remove(chatId);
				return null;
			}
			const entries = parseChatViewMessages(parsed.entries);
			if (entries === null || typeof parsed.generationId !== 'string' || !parsed.generationId) {
				this.remove(chatId);
				return null;
			}
			const index = readIndex();
			const entry = index.entries.find((candidate) => candidate.chatId === chatId);
			writeIndex(pruneIndex(upsertEntry(index, chatId, { lastAccessedAt: nowIso() })));
			return {
				entries: windowEntries(entries, options),
				generationId: parsed.generationId,
				lastSeq: Number(parsed.lastSeq) || 0,
				stale: entry?.stale ?? false,
			};
		} catch {
			this.remove(chatId);
			return null;
		}
	}

	persist(
		chatId: string,
		entries: ChatViewMessage[],
		cursor: { generationId: string; lastSeq: number },
		options: ChatSnapshotWindowOptions = {},
	): void {
		if (!chatId) return;
		if (entries.length === 0 || !cursor.generationId) {
			this.remove(chatId);
			return;
		}
		const envelope: ChatSnapshotEnvelope = {
			version: SCHEMA_VERSION,
			chatId,
			savedAt: nowIso(),
			generationId: cursor.generationId,
			lastSeq: cursor.lastSeq,
			entries: windowEntries(entries, options),
		};
		try {
			localStorage.setItem(snapshotKey(chatId), JSON.stringify(envelope));
			const index = readIndex();
			writeIndex(pruneIndex(upsertEntry(index, chatId, {
				lastAccessedAt: nowIso(),
				schemaVersion: SCHEMA_VERSION,
			})));
		} catch {
			// Leaves storage best-effort.
		}
	}

	remove(chatId: string): void {
		if (!chatId) return;
		try {
			localStorage.removeItem(snapshotKey(chatId));
			const index = readIndex();
			writeIndex(removeEntry(index, chatId));
		} catch {
			// Leaves removal best-effort.
		}
	}

	markStale(chatId: string): void {
		if (!chatId) return;
		try {
			if (!hasSnapshot(chatId)) {
				this.remove(chatId);
				return;
			}
			const index = readIndex();
			writeIndex(upsertEntry(index, chatId, { stale: true }));
		} catch {
			// Leaves stale marking best-effort.
		}
	}

	markValidated(chatId: string): void {
		if (!chatId) return;
		try {
			if (!hasSnapshot(chatId)) {
				this.remove(chatId);
				return;
			}
			const index = readIndex();
			writeIndex(upsertEntry(index, chatId, {
				stale: false,
				lastValidatedAt: nowIso(),
			}));
		} catch {
			// Leaves validation best-effort.
		}
	}

	listCursors(limit = 20): CachedChatCursor[] {
		const boundedLimit = Math.max(0, Math.floor(limit));
		if (boundedLimit === 0) return [];
		try {
			const sorted = [...readIndex().entries].sort(
				(a, b) => new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime(),
			);
			const cursors: CachedChatCursor[] = [];
			for (const entry of sorted) {
				if (cursors.length >= boundedLimit) break;
				const raw = localStorage.getItem(snapshotKey(entry.chatId));
				if (!raw) {
					this.remove(entry.chatId);
					continue;
				}
				const parsed = JSON.parse(raw) as Partial<ChatSnapshotEnvelope>;
				if (
					parsed.version !== SCHEMA_VERSION ||
					parsed.chatId !== entry.chatId ||
					typeof parsed.generationId !== 'string' ||
					!parsed.generationId ||
					!(Number(parsed.lastSeq) > 0)
				) {
					this.remove(entry.chatId);
					continue;
				}
				cursors.push({
					chatId: entry.chatId,
					generationId: parsed.generationId,
					lastSeq: Number(parsed.lastSeq),
				});
			}
			return cursors;
		} catch {
			return [];
		}
	}

	applyMessages(
		chatId: string,
		generationId: string,
		messages: ChatViewMessage[],
		lastSeq: number,
		options: ChatSnapshotWindowOptions = {},
	): boolean {
		if (!chatId || !generationId) return false;
		const restored = this.restore(chatId);
		if (!restored || restored.generationId !== generationId) {
			this.markStale(chatId);
			return false;
		}
		const result = applyChatViewMessages(restored.entries, messages, restored.lastSeq);
		this.persist(chatId, result.messages, {
			generationId,
			lastSeq: Math.max(result.lastSeq, lastSeq),
		}, options);
		this.markValidated(chatId);
		return true;
	}

	clearAll(): void {
		try {
			const index = readIndex();
			for (const entry of index.entries) {
				localStorage.removeItem(snapshotKey(entry.chatId));
			}
			localStorage.removeItem(INDEX_KEY);
		} catch {
			// Ignores clear failures.
		}
	}
}
