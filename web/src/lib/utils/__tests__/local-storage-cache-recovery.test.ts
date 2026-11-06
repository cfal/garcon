import { beforeEach, describe, expect, it } from 'vitest';
import {
	CHAT_TRANSCRIPT_INDEX_KEY,
	CHAT_TRANSCRIPT_SNAPSHOT_PREFIX,
	purgeLegacyTranscriptSnapshots,
	setLocalStorageWithCacheRecovery,
} from '../local-storage-cache-recovery';

describe('setLocalStorageWithCacheRecovery', () => {
	beforeEach(() => localStorage.clear());

	it('purges every retired raw snapshot and index without deleting settings or drafts', () => {
		localStorage.setItem(`${CHAT_TRANSCRIPT_SNAPSHOT_PREFIX}deleted-chat`, 'Synthetic private transcript');
		localStorage.setItem(`${CHAT_TRANSCRIPT_SNAPSHOT_PREFIX}orphan`, 'Synthetic orphaned transcript');
		localStorage.setItem(CHAT_TRANSCRIPT_INDEX_KEY, 'malformed index');
		localStorage.setItem('chat_draft_current', 'Synthetic draft');
		localStorage.setItem('workspace_layout_v2', '{"version":2}');
		expect(purgeLegacyTranscriptSnapshots()).toBe(true);
		expect(Object.keys(localStorage).sort()).toEqual(['chat_draft_current', 'workspace_layout_v2']);
		expect(localStorage.getItem('chat_draft_current')).toBe('Synthetic draft');
		expect(purgeLegacyTranscriptSnapshots()).toBe(true);
	});

	it('evicts the oldest transcript cache entry before retrying durable state', () => {
		localStorage.setItem(`${CHAT_TRANSCRIPT_SNAPSHOT_PREFIX}old`, 'old transcript');
		localStorage.setItem(`${CHAT_TRANSCRIPT_SNAPSHOT_PREFIX}new`, 'new transcript');
		localStorage.setItem(
			CHAT_TRANSCRIPT_INDEX_KEY,
			JSON.stringify({
				version: 3,
				entries: [
					{ chatId: 'old', lastAccessedAt: '2026-01-01T00:00:00.000Z' },
					{ chatId: 'new', lastAccessedAt: '2026-02-01T00:00:00.000Z' },
				],
			}),
		);
		let quotaFailurePending = true;
		const quotaStorage: Storage = {
			get length() {
				return localStorage.length;
			},
			clear: () => localStorage.clear(),
			getItem: (key) => localStorage.getItem(key),
			key: (index) => localStorage.key(index),
			removeItem: (key) => localStorage.removeItem(key),
			setItem: (key, value) => {
				if (key === 'workspace_layout_v2' && quotaFailurePending) {
					quotaFailurePending = false;
					throw new DOMException('Quota exceeded', 'QuotaExceededError');
				}
				localStorage.setItem(key, value);
			},
		};

		setLocalStorageWithCacheRecovery(quotaStorage, 'workspace_layout_v2', '{"version":2}');

		expect(localStorage.getItem('workspace_layout_v2')).toBe('{"version":2}');
		expect(localStorage.getItem(`${CHAT_TRANSCRIPT_SNAPSHOT_PREFIX}old`)).toBeNull();
		expect(localStorage.getItem(`${CHAT_TRANSCRIPT_SNAPSHOT_PREFIX}new`)).toBe('new transcript');
	});
});
