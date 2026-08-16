import { parseTranscriptMessages, type TranscriptMessage } from '$shared/chat-view';
import {
	CHAT_TRANSCRIPT_INDEX_KEY as INDEX_KEY,
	CHAT_TRANSCRIPT_SNAPSHOT_PREFIX as SNAPSHOT_PREFIX,
	setLocalStorageWithCacheRecovery,
} from '$lib/utils/local-storage-cache-recovery';

const SCHEMA_VERSION = 5;
const MAX_ENTRIES = 25;
const MAX_SNAPSHOT_CHARACTERS = 1_500_000;

interface ChatSnapshotEnvelope {
	version: 5;
	chatId: string;
	savedAt: string;
	transcriptViewId: string;
	lastOrdinal: number;
	nextBeforeOrdinal: number | null;
	entries: TranscriptMessage[];
}

interface ChatSnapshotIndexEntry {
	chatId: string;
	lastAccessedAt: string;
	lastValidatedAt: string | null;
	schemaVersion: 5;
	stale: boolean;
}

interface ChatSnapshotIndex {
	version: 5;
	entries: ChatSnapshotIndexEntry[];
}

export interface RestoredChatTranscript {
	entries: TranscriptMessage[];
	transcriptViewId: string;
	lastOrdinal: number;
	nextBeforeOrdinal: number | null;
	stale: boolean;
}

export interface CachedChatCursor {
	chatId: string;
	transcriptViewId: string;
	lastOrdinal: number;
}

export interface ChatTranscriptWindowOptions {
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
	setLocalStorageWithCacheRecovery(localStorage, INDEX_KEY, JSON.stringify(index));
}

function windowEntries(
	entries: TranscriptMessage[],
	options: ChatTranscriptWindowOptions = {},
): TranscriptMessage[] {
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
	const countBounded = sorted.slice(0, MAX_ENTRIES);
	const evicted = sorted.slice(MAX_ENTRIES);
	const keep: ChatSnapshotIndexEntry[] = [];
	let retainedCharacters = 0;
	for (const entry of countBounded) {
		const characters = localStorage.getItem(snapshotKey(entry.chatId))?.length ?? 0;
		if (keep.length > 0 && retainedCharacters + characters > MAX_SNAPSHOT_CHARACTERS) {
			evicted.push(entry);
			continue;
		}
		keep.push(entry);
		retainedCharacters += characters;
	}
	for (const entry of evicted) {
		try {
			localStorage.removeItem(snapshotKey(entry.chatId));
		} catch {
			// Leaves storage cleanup best-effort.
		}
	}
	return { ...index, entries: keep };
}

function hasSnapshot(chatId: string): boolean {
	return Boolean(localStorage.getItem(snapshotKey(chatId)));
}

export class LocalChatTranscriptStorage {
	restore(
		chatId: string,
		options: ChatTranscriptWindowOptions = {},
	): RestoredChatTranscript | null {
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
			const entries = parseTranscriptMessages(parsed.entries);
			if (
				entries === null
				|| typeof parsed.transcriptViewId !== 'string'
				|| !parsed.transcriptViewId
				|| (
					parsed.nextBeforeOrdinal !== null
					&& (
						typeof parsed.nextBeforeOrdinal !== 'number'
						|| !Number.isSafeInteger(parsed.nextBeforeOrdinal)
						|| parsed.nextBeforeOrdinal <= 1
					)
				)
			) {
				this.remove(chatId);
				return null;
			}
			const restoredEntries = windowEntries(entries, options);
			const nextBeforeOrdinal = restoredEntries.length < entries.length
				? restoredEntries[0]?.ordinal ?? null
				: parsed.nextBeforeOrdinal;
			const index = readIndex();
			const entry = index.entries.find((candidate) => candidate.chatId === chatId);
			writeIndex(pruneIndex(upsertEntry(index, chatId, { lastAccessedAt: nowIso() })));
			return {
				entries: restoredEntries,
				transcriptViewId: parsed.transcriptViewId,
				lastOrdinal: Number(parsed.lastOrdinal) || 0,
				nextBeforeOrdinal,
				stale: entry?.stale ?? false,
			};
		} catch {
			this.remove(chatId);
			return null;
		}
	}

	persist(
		chatId: string,
		entries: TranscriptMessage[],
		cursor: {
			transcriptViewId: string;
			lastOrdinal: number;
			nextBeforeOrdinal: number | null;
		},
		options: ChatTranscriptWindowOptions = {},
	): void {
		if (!chatId) return;
		if (entries.length === 0 || !cursor.transcriptViewId) {
			this.remove(chatId);
			return;
		}
		const retainedEntries = windowEntries(entries, options);
		const envelope: ChatSnapshotEnvelope = {
			version: SCHEMA_VERSION,
			chatId,
			savedAt: nowIso(),
			transcriptViewId: cursor.transcriptViewId,
			lastOrdinal: cursor.lastOrdinal,
			nextBeforeOrdinal: retainedEntries.length < entries.length
				? retainedEntries[0]?.ordinal ?? null
				: cursor.nextBeforeOrdinal,
			entries: retainedEntries,
		};
		try {
			setLocalStorageWithCacheRecovery(localStorage, snapshotKey(chatId), JSON.stringify(envelope));
			const index = readIndex();
			writeIndex(
				pruneIndex(
					upsertEntry(index, chatId, {
						lastAccessedAt: nowIso(),
						schemaVersion: SCHEMA_VERSION,
					}),
				),
			);
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

	listCursors(limit = 20): CachedChatCursor[] {
		const boundedLimit = Math.max(0, Math.floor(limit));
		if (boundedLimit === 0) return [];
		try {
			const sorted = readIndex()
				.entries.filter((entry) => !entry.stale)
				.sort(
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
					typeof parsed.transcriptViewId !== 'string' ||
					!parsed.transcriptViewId ||
					!(Number(parsed.lastOrdinal) > 0)
				) {
					this.remove(entry.chatId);
					continue;
				}
				cursors.push({
					chatId: entry.chatId,
					transcriptViewId: parsed.transcriptViewId,
					lastOrdinal: Number(parsed.lastOrdinal),
				});
			}
			return cursors;
		} catch {
			return [];
		}
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
