export const CHAT_TRANSCRIPT_SNAPSHOT_PREFIX = 'chat_snapshot_';
export const CHAT_TRANSCRIPT_INDEX_KEY = 'chat_snapshot_index_v3';

interface TranscriptIndexEntry {
	chatId: string;
	lastAccessedAt?: string;
}

function isQuotaError(error: unknown): boolean {
	return (
		error instanceof DOMException &&
		(error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED')
	);
}

function indexedEntries(storage: Storage): TranscriptIndexEntry[] {
	try {
		const raw = storage.getItem(CHAT_TRANSCRIPT_INDEX_KEY);
		if (!raw) return [];
		const value = JSON.parse(raw) as { entries?: unknown };
		if (!Array.isArray(value.entries)) return [];
		return value.entries
			.filter(
				(entry): entry is TranscriptIndexEntry =>
					Boolean(entry) &&
					typeof entry === 'object' &&
					typeof (entry as TranscriptIndexEntry).chatId === 'string',
			)
			.sort(
				(left, right) =>
					Date.parse(left.lastAccessedAt ?? '') - Date.parse(right.lastAccessedAt ?? ''),
			);
	} catch {
		return [];
	}
}

function evictOldestTranscript(storage: Storage): boolean {
	const entries = indexedEntries(storage);
	const oldest = entries.find((entry) =>
		storage.getItem(`${CHAT_TRANSCRIPT_SNAPSHOT_PREFIX}${entry.chatId}`),
	);
	if (oldest) {
		storage.removeItem(`${CHAT_TRANSCRIPT_SNAPSHOT_PREFIX}${oldest.chatId}`);
		try {
			const raw = storage.getItem(CHAT_TRANSCRIPT_INDEX_KEY);
			const value = raw ? (JSON.parse(raw) as { entries?: unknown[] }) : null;
			if (value && Array.isArray(value.entries)) {
				value.entries = value.entries.filter(
					(entry) =>
						!entry ||
						typeof entry !== 'object' ||
						(entry as TranscriptIndexEntry).chatId !== oldest.chatId,
				);
				storage.setItem(CHAT_TRANSCRIPT_INDEX_KEY, JSON.stringify(value));
			}
		} catch {
			storage.removeItem(CHAT_TRANSCRIPT_INDEX_KEY);
		}
		return true;
	}

	for (let index = 0; index < storage.length; index += 1) {
		const key = storage.key(index);
		if (!key?.startsWith(CHAT_TRANSCRIPT_SNAPSHOT_PREFIX)) continue;
		storage.removeItem(key);
		return true;
	}
	return false;
}

export function setLocalStorageWithCacheRecovery(
	storage: Storage,
	key: string,
	value: string,
): void {
	while (true) {
		try {
			storage.setItem(key, value);
			return;
		} catch (error) {
			if (!isQuotaError(error) || !evictOldestTranscript(storage)) throw error;
		}
	}
}
