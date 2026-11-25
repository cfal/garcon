import { parseTranscriptMessages, type TranscriptMessage } from '$shared/chat-view';
import { canPersistBrowserData } from '$lib/utils/browser-data-lifetime';
import { serializeTranscriptWithinBudget } from './bounded-transcript-json';
import {
	CHAT_TRANSCRIPT_INDEX_KEY as INDEX_KEY,
	CHAT_TRANSCRIPT_SNAPSHOT_PREFIX as SNAPSHOT_PREFIX,
	setLocalStorageWithCacheRecovery,
} from '$lib/utils/local-storage-cache-recovery';

const SCHEMA_VERSION = 6;
const INDEX_VERSION = 7;
const MAX_ENTRIES = 25;
const MAX_SNAPSHOT_CHARACTERS = 250_000;
const MAX_RETAINED_CHARACTERS = 1_500_000;
const MAX_SNAPSHOT_VALUES = 10_000;
const MAX_SNAPSHOT_DEPTH = 64;

interface ChatSnapshotEnvelope {
	version: 6;
	chatId: string;
	savedAt: string;
	transcriptViewId: string;
	lastOrdinal: number;
	nextBeforeOrdinal: number | null;
	entries: TranscriptMessage[];
}

interface ChatSnapshotIndexEntry extends CachedChatCursor {
	lastAccessedAt: string;
	characters: number;
	stale: boolean;
}

interface ChatSnapshotIndex {
	version: typeof INDEX_VERSION;
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
	return { version: INDEX_VERSION, entries: [] };
}

function discardSnapshotIndex(keepKey?: string): void {
	const obsolete: string[] = [];
	for (let i = 0; i < localStorage.length; i++) {
		const key = localStorage.key(i);
		if (key?.startsWith(SNAPSHOT_PREFIX) && key !== keepKey && key !== INDEX_KEY) obsolete.push(key);
	}
	for (const key of obsolete) localStorage.removeItem(key);
	localStorage.removeItem(INDEX_KEY);
}

function readIndex(justWrittenKey?: string): ChatSnapshotIndex {
	try {
		const raw = localStorage.getItem(INDEX_KEY);
		if (!raw) return emptyIndex();
		const parsed = JSON.parse(raw) as ChatSnapshotIndex;
		if (parsed.version !== INDEX_VERSION || !Array.isArray(parsed.entries)) {
			discardSnapshotIndex(justWrittenKey);
			return emptyIndex();
		}
		return {
			version: INDEX_VERSION,
			entries: parsed.entries.filter(entry =>
				entry
				&& typeof entry.chatId === 'string'
				&& typeof entry.lastAccessedAt === 'string'
				&& typeof entry.transcriptViewId === 'string'
				&& Boolean(entry.transcriptViewId)
				&& Number.isSafeInteger(entry.lastOrdinal)
				&& entry.lastOrdinal > 0
				&& Number.isSafeInteger(entry.characters)
				&& entry.characters > 0
				&& typeof entry.stale === 'boolean',
			),
		};
	} catch {
		return emptyIndex();
	}
}

function writeIndex(index: ChatSnapshotIndex): void {
	// Quota recovery can evict snapshots referenced by the index being written.
	if (canPersistBrowserData()) localStorage.setItem(INDEX_KEY, JSON.stringify(index));
}

function windowEntries(
	entries: TranscriptMessage[],
	options: ChatTranscriptWindowOptions = {},
): TranscriptMessage[] {
	const limit = Number.isFinite(options.limit) ? Math.floor(options.limit ?? 0) : 0;
	if (limit <= 0 || entries.length <= limit) return entries;
	return entries.slice(-limit);
}


function upsertEntry(index: ChatSnapshotIndex, entry: ChatSnapshotIndexEntry): ChatSnapshotIndex {
	return { ...index, entries: [...index.entries.filter(item => item.chatId !== entry.chatId), entry] };
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
		const { characters } = entry;
		if (
			characters > MAX_SNAPSHOT_CHARACTERS
			|| retainedCharacters + characters > MAX_RETAINED_CHARACTERS
		) {
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

export class LocalChatTranscriptStorage {
	restore(
		chatId: string,
		options: ChatTranscriptWindowOptions = {},
	): RestoredChatTranscript | null {
		if (!chatId || !canPersistBrowserData()) return null;
		try {
			const index = readIndex();
			const raw = localStorage.getItem(snapshotKey(chatId));
			if (!raw || raw.length > MAX_SNAPSHOT_CHARACTERS) {
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
				|| !Number.isSafeInteger(parsed.lastOrdinal)
				|| parsed.lastOrdinal <= 0
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
			const entry = index.entries.find((candidate) => candidate.chatId === chatId);
			const stale = entry?.transcriptViewId !== parsed.transcriptViewId
				|| entry.lastOrdinal !== parsed.lastOrdinal || entry.stale;
			writeIndex(pruneIndex(upsertEntry(index, {
				chatId,
				lastAccessedAt: nowIso(),
				characters: raw.length,
				transcriptViewId: parsed.transcriptViewId,
				lastOrdinal: parsed.lastOrdinal,
				stale,
			})));
			return {
				entries: restoredEntries,
				transcriptViewId: parsed.transcriptViewId,
				lastOrdinal: parsed.lastOrdinal,
				nextBeforeOrdinal,
				stale,
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
		if (!chatId || !canPersistBrowserData()) return;
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
			const serialized = serializeTranscriptWithinBudget(envelope, {
				characters: MAX_SNAPSHOT_CHARACTERS, values: MAX_SNAPSHOT_VALUES, depth: MAX_SNAPSHOT_DEPTH,
			});
			if (serialized === null) {
				this.remove(chatId);
				return;
			}
			setLocalStorageWithCacheRecovery(localStorage, snapshotKey(chatId), serialized);
			const index = readIndex(snapshotKey(chatId));
			writeIndex(
				pruneIndex(
					upsertEntry(index, {
						chatId,
						lastAccessedAt: nowIso(),
						characters: serialized.length,
						transcriptViewId: cursor.transcriptViewId,
						lastOrdinal: cursor.lastOrdinal,
						stale: false,
					}),
				),
			);
		} catch {
			this.remove(chatId);
		}
	}

	remove(chatId: string): void {
		if (!chatId || !canPersistBrowserData()) return;
		try {
			localStorage.removeItem(snapshotKey(chatId));
			const index = readIndex();
			writeIndex(removeEntry(index, chatId));
		} catch {
			// Leaves removal best-effort.
		}
	}

	markStale(chatId: string): void {
		if (!chatId || !canPersistBrowserData()) return;
		try {
			const index = readIndex();
			const entry = index.entries.find(item => item.chatId === chatId);
			if (entry && !entry.stale) writeIndex(upsertEntry(index, { ...entry, stale: true }));
		} catch {
			// Leaves stale marking best-effort.
		}
	}

	markStaleExcept(chatIds: ReadonlySet<string>): void {
		if (!canPersistBrowserData()) return;
		try {
			const index = readIndex();
			writeIndex({
				...index,
				entries: index.entries.map((entry) =>
					chatIds.has(entry.chatId) ? entry : { ...entry, stale: true },
				),
			});
		} catch {
			// Leaves stale marking best-effort.
		}
	}

	hasCurrentCursor({ chatId, transcriptViewId, lastOrdinal }: CachedChatCursor): boolean {
		if (!canPersistBrowserData()) return false;
		return readIndex().entries.some(entry => !entry.stale
			&& entry.characters <= MAX_SNAPSHOT_CHARACTERS
			&& entry.chatId === chatId
			&& entry.transcriptViewId === transcriptViewId
			&& entry.lastOrdinal === lastOrdinal);
	}

	listCursors(limit = 20): CachedChatCursor[] {
		if (!canPersistBrowserData()) return [];
		const boundedLimit = Math.max(0, Math.floor(limit));
		if (boundedLimit === 0) return [];
		try {
			return readIndex()
				.entries.filter((entry) => !entry.stale && entry.characters <= MAX_SNAPSHOT_CHARACTERS)
				.sort(
					(a, b) => new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime(),
				)
				.slice(0, boundedLimit)
				.map(({ chatId, transcriptViewId, lastOrdinal }) => ({ chatId, transcriptViewId, lastOrdinal }));
		} catch {
			return [];
		}
	}

	clearAll(): void {
		if (!canPersistBrowserData()) return;
		try {
			discardSnapshotIndex();
		} catch {
			// Ignores clear failures.
		}
	}
}
