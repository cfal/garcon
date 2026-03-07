// Bounded localStorage cache for chat message snapshots. Maintains an
// LRU index capped at 25 entries with schema-versioned envelopes so
// snapshots survive across sessions without unbounded growth.

import { parseChatMessages, type ChatMessage } from '$shared/chat-types';

const SNAPSHOT_PREFIX = 'chat_snapshot_';
const INDEX_KEY = 'chat_snapshot_index_v1';
const SCHEMA_VERSION = 1;
const MAX_ENTRIES = 25;

interface ChatSnapshotEnvelope {
	version: 1;
	chatId: string;
	savedAt: string;
	messages: ChatMessage[];
}

interface ChatSnapshotIndexEntry {
	chatId: string;
	lastAccessedAt: string;
	lastValidatedAt: string | null;
	schemaVersion: 1;
	stale: boolean;
}

interface ChatSnapshotIndex {
	version: 1;
	entries: ChatSnapshotIndexEntry[];
}

export interface RestoredChatSnapshot {
	messages: ChatMessage[];
	stale: boolean;
}

function snapshotKey(chatId: string): string {
	return `${SNAPSHOT_PREFIX}${chatId}`;
}

function hasSnapshot(chatId: string): boolean {
	return Boolean(localStorage.getItem(snapshotKey(chatId)));
}

function nowIso(): string {
	return new Date().toISOString();
}

function emptyIndex(): ChatSnapshotIndex {
	return { version: 1, entries: [] };
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
		schemaVersion: 1,
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
		(a, b) =>
			new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime(),
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

export class LocalChatSnapshotCache {
	/** Restores a snapshot, bumps recency, and returns stale status. */
	restore(chatId: string): RestoredChatSnapshot | null {
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

			const messages = parseChatMessages(parsed.messages);
			const index = readIndex();
			const entry = index.entries.find((candidate) => candidate.chatId === chatId);
			const nextIndex = upsertEntry(index, chatId, { lastAccessedAt: nowIso() });
			writeIndex(pruneIndex(nextIndex));

			return {
				messages,
				stale: entry?.stale ?? false,
			};
		} catch {
			this.remove(chatId);
			return null;
		}
	}

	/** Writes envelope, updates index, prunes to 25 entries. */
	persist(chatId: string, messages: ChatMessage[]): void {
		if (!chatId) return;

		if (messages.length === 0) {
			this.remove(chatId);
			return;
		}

		const envelope: ChatSnapshotEnvelope = {
			version: 1,
			chatId,
			savedAt: nowIso(),
			messages,
		};

		try {
			localStorage.setItem(snapshotKey(chatId), JSON.stringify(envelope));
			const index = readIndex();
			const nextIndex = upsertEntry(index, chatId, {
				lastAccessedAt: nowIso(),
				schemaVersion: 1,
			});
			writeIndex(pruneIndex(nextIndex));
		} catch {
			// Leaves storage best-effort.
		}
	}

	/** Removes both snapshot and index entry. */
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

	/** Marks the snapshot stale without removing it. */
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

	/** Clears the stale bit and updates lastValidatedAt. */
	markValidated(chatId: string): void {
		if (!chatId) return;
		try {
			if (!hasSnapshot(chatId)) {
				this.remove(chatId);
				return;
			}
			const index = readIndex();
			writeIndex(
				upsertEntry(index, chatId, {
					stale: false,
					lastValidatedAt: nowIso(),
				}),
			);
		} catch {
			// Leaves validation best-effort.
		}
	}

	/** Removes all snapshots and the index. */
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
